// THE ONE PIECE OF SERVER CODE ON THE SITE: the endpoint the Android game sends its anonymous play
// statistics to. Every page is still a static asset served straight from Cloudflare's edge —
// wrangler.jsonc routes only /api/* through this script (`run_worker_first`), so nothing here runs
// for a page view and the pages themselves still contain no JavaScript.
//
//   POST /api/v1/events   a batch of events from game/metrics.js (in the game repo) → D1
//
// WHAT IS STORED is exactly what the privacy policy lists, and it is decided HERE rather than by the
// client: every field is validated and copied across by name, so a future client that sends more
// cannot get more into the database. In particular no IP address, user agent, country or other
// request detail is read or stored — the request object is used for its body and nothing else.
//
// ENCRYPTED IN TRANSIT. The site is HTTPS-only (HSTS in public/_headers), and this endpoint refuses
// plain http outright rather than redirecting: a redirected POST arrives as a GET with no body, so a
// redirect would fail silently where a refusal fails loudly. There is no exception for local work:
// run `npm run dev`, which serves https on localhost with a self-signed certificate.
//
// CORS IS OPEN (`*`), deliberately. The app's WebView calls from https://localhost, the browser build
// from wherever it is served, and the endpoint takes no credentials and returns nothing worth
// reading — so an allow-list would add a way to break the app and no protection.

const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 100;
const MAX_MS = 30 * 24 * 60 * 60 * 1000; // a month of play on one level is not a real figure
const MAX_HINTS = 10_000;
const MAX_INT = 1_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEVEL_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const APP = /^[0-9A-Za-z.+-]{1,32}$/;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    },
  });

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);

// One event, checked and rebuilt, or null. Rebuilt rather than passed through so the insert below
// can only ever see the fields named here.
export function cleanEvent(e) {
  if (!e || typeof e !== "object") return null;
  if (!UUID.test(e.id) || !UUID.test(e.save)) return null;
  if (e.kind !== "attempt" && e.kind !== "complete") return null;
  if (e.scope !== "level" && e.scope !== "section" && e.scope !== "campaign") return null;
  if (!isInt(e.campaign, 0, MAX_INT)) return null;

  const out = {
    id: e.id,
    save: e.save,
    kind: e.kind,
    scope: e.scope,
    campaign: e.campaign,
    section: null,
    level: null,
    lv: null,
    ms: null,
    hints: null,
    partial: e.partial === true ? 1 : 0,
    at: isInt(e.at, 0, Number.MAX_SAFE_INTEGER) ? e.at : null,
  };
  if (e.scope !== "campaign") {
    if (!isText(e.section, 80)) return null;
    out.section = e.section;
  }
  if (e.scope === "level") {
    if (!LEVEL_ID.test(e.level) || !isInt(e.lv, 0, MAX_INT)) return null;
    out.level = e.level;
    out.lv = e.lv;
  }
  if (e.kind === "complete") {
    if (!isInt(e.ms, 0, MAX_MS) || !isInt(e.hints, 0, MAX_HINTS)) return null;
    out.ms = e.ms;
    out.hints = e.hints;
  }
  return out;
}

// The envelope, checked. Returns { player, app, lang, events } or a string saying what was wrong.
export function cleanBatch(b) {
  if (!b || typeof b !== "object" || b.v !== 1) return "unsupported schema";
  if (!UUID.test(b.player)) return "bad player id";
  if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > MAX_EVENTS) return "bad events";
  return {
    player: b.player,
    app: APP.test(b.app) ? b.app : null,
    lang: typeof b.lang === "string" && b.lang.length <= 35 && LANG.test(b.lang) ? b.lang : null,
    events: b.events,
  };
}

const INSERT = `INSERT OR IGNORE INTO events
  (event_id, player_id, save_id, kind, scope, campaign, section, level_id, level_version,
   play_ms, hints, partial, app_version, lang, client_at, received_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`;

async function postEvents(request, env) {
  const type = request.headers.get("Content-Type") || "";
  if (!/^(application\/json|text\/plain)\b/i.test(type)) return json(415, { error: "expected JSON" });
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY) return json(413, { error: "too large" });
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: "too large" });

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "not JSON" });
  }
  const batch = cleanBatch(body);
  if (typeof batch === "string") return json(400, { error: batch });

  // A bad event is skipped, not a reason to refuse its neighbours: the client drops a batch the
  // server rejects, and one malformed row should not cost the rest.
  const events = batch.events.map(cleanEvent).filter(Boolean);
  const rejected = batch.events.length - events.length;
  if (!events.length) return json(400, { error: "no valid events", rejected });

  if (!env.DB) return json(503, { error: "not configured" });
  const now = Date.now();
  const stmt = env.DB.prepare(INSERT);
  await env.DB.batch(
    events.map((e) =>
      stmt.bind(e.id, batch.player, e.save, e.kind, e.scope, e.campaign, e.section, e.level, e.lv,
        e.ms, e.hints, e.partial, batch.app, batch.lang, e.at, now),
    ),
  );
  return json(202, { accepted: events.length, rejected });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return json(403, { error: "https required" });

    if (url.pathname === "/api/v1/events") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      try {
        return await postEvents(request, env);
      } catch (err) {
        console.error("events insert failed", err && err.message);
        return json(500, { error: "server error" });
      }
    }

    // Anything else under /api/ is not a page and must not fall through to the site's 404 page.
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    return env.ASSETS.fetch(request);
  },
};
