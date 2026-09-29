// THE PLAY-STATISTICS REPORT: one private HTML page, at GET /report, drawing what the endpoint in
// worker.js has collected. It answers the three questions the figures were gathered for —
//
//   1. how far down the campaign do players get?      (players who reached each level)
//   2. which levels do they need help on?             (players who took a hint on each level)
//   3. how many reach each chapter?                   (players who unlocked each section)
//
// — as three bar charts on a LOGARITHMIC scale, because the answer to the first spans three orders
// of magnitude: everybody plays the first level and a handful finish the last, and on a linear axis
// the whole tail of the campaign is a row of invisible stubs. On a log axis a constant drop-off rate
// is a straight line, so the rungs where players actually give up are the kinks in it.
//
// PLAYERS, NOT EVENTS, throughout: COUNT(DISTINCT player_id), which is the deduplication the random
// player id exists for — one person replaying a level in three save slots is one player who reached
// it. See migrations/0001_events.sql, whose three views count the same way.
//
// ---------------------------------------------------------------------------------------------
// NO JAVASCRIPT, AND NO IMAGES. The bars are <div>s with a width, the gridlines are borders, and the
// numbers are in the markup beside every bar — so the page carries its own table view, prints, and
// needs no hover layer to be readable, which matters because it could not have one. That is not
// asceticism: the site's privacy policy claims there is no script on this domain and public/_headers
// enforces it, and a report that needed a charting library would either break that claim or need a
// second hostname. The one thing this page does need is an inline <style> (the stylesheet in
// public/css/site.css is for prose on a sheet, not for a wall of figures), so its CSP — set below on
// its own response, not by _headers, which only covers static assets — is `default-src 'none'` with
// `style-src 'unsafe-inline'` added and nothing else. No origin, no script, no image.
//
// ---------------------------------------------------------------------------------------------
// WHO MAY READ IT. Nothing here is personal — there is no such thing as a player's name in this
// database — but it is not public either, so the page is behind a shared secret in `REPORT_TOKEN`
// (`npx wrangler secret put REPORT_TOKEN`, and `.dev.vars` locally). It is accepted as
// `?key=` for a bookmark or as an `Authorization: Bearer` header for curl, compared in constant
// time, and if the secret is NOT CONFIGURED the page is refused rather than opened — a missing
// binding must never be the thing that publishes it.
//
// The key does end up in the URL bar and so in browser history, which is why the response sends
// `Referrer-Policy: no-referrer` (so following a link off this page cannot leak it), `X-Robots-Tag`
// and `Cache-Control: no-store`. Rotating it is one `wrangler secret put`.

const DEC = ["1", "10", "100", "1,000", "10,000", "100,000"];

// The site's own colours, from public/css/site.css. One hue for all three charts on purpose: every
// bar on the page measures the same thing (players), so a second hue would imply a distinction that
// is not in the data — what separates the charts is their headings.
const BAR = "#9a6c17";

// ---------- pure helpers ----------

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Constant-time string compare. Length is not secret (and differing lengths cannot be compared
// without leaking it anyway), so it short-circuits there and nowhere else.
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The top of a log axis: the next power of ten at or above the largest bar, and never below 10 — an
// axis from 1 to 1 has no width to draw in, and a chart whose biggest number is 4 still reads
// correctly against a decade.
export const axisTop = (max) => Math.pow(10, Math.max(1, Math.ceil(Math.log10(Math.max(1, max)))));

// Where a count sits on that axis, 0..1. log10(1) is 0, so the smallest real count sits ON the
// baseline and is drawn as a stub by `min-width` in the stylesheet rather than as nothing; 0 gets no
// bar at all, which is the one thing a log scale genuinely cannot show and is why the count is
// always printed as well.
export const barFrac = (n, top) => (n > 0 ? Math.log10(n) / Math.log10(top) : 0);

// The decade gridlines to draw for an axis, as { label, frac, last }. The last one stands on the
// right-hand edge of the plot, so its label hangs off the end of the table unless it is turned round
// to sit inside — `last` is what the stylesheet turns on to do that.
export const decades = (top) => {
  const out = [];
  for (let v = 1; v <= top; v *= 10) out.push({ label: DEC[Math.round(Math.log10(v))], frac: barFrac(v, top) });
  if (out.length) out[out.length - 1].last = true;
  return out;
};

const pct = (f) => `${(f * 100).toFixed(2)}%`;
const num = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-GB"));

// Minutes, for a figure that is only ever read as "about how long": a level that takes 40 seconds and
// one that takes half an hour both have to be legible in the same column.
export function mins(secs) {
  if (secs === null || secs === undefined) return "—";
  const m = secs / 60;
  return m < 10 ? `${m.toFixed(1)}m` : `${Math.round(m)}m`;
}

// ---------- the queries ----------
// Two GROUP BYs answer all three charts. Everything is per campaign release: a level is only
// comparable with itself, and folding two releases together would count a rung twice under two
// different sets of neighbours.

const LEVELS = `SELECT level_id, level_version,
    MAX(section)                                                                  AS section,
    COUNT(DISTINCT CASE WHEN kind = 'attempt'  THEN player_id END)                AS reached,
    COUNT(DISTINCT CASE WHEN kind = 'complete' THEN player_id END)                AS finished,
    COUNT(DISTINCT CASE WHEN kind = 'complete' AND hints > 0 THEN player_id END)  AS hinted,
    SUM(CASE WHEN kind = 'complete' THEN hints END)                               AS hint_total,
    ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN play_ms END) / 1000.0, 1) AS secs,
    ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN hints   END), 2)          AS avg_hints
  FROM events WHERE scope = 'level' AND campaign = ?1
  GROUP BY level_id, level_version`;

const SECTIONS = `SELECT section,
    COUNT(DISTINCT CASE WHEN kind = 'attempt'  THEN player_id END) AS reached,
    COUNT(DISTINCT CASE WHEN kind = 'complete' THEN player_id END) AS finished,
    ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN play_ms END) / 1000.0, 1) AS secs,
    ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN hints   END), 2)          AS avg_hints
  FROM events WHERE scope = 'section' AND campaign = ?1
  GROUP BY section`;

const CAMPAIGNS = `SELECT campaign,
    COUNT(DISTINCT player_id) AS players,
    MAX(received_at) AS last_seen
  FROM events GROUP BY campaign ORDER BY campaign DESC`;

const OVERALL = `SELECT
    COUNT(DISTINCT player_id) AS players,
    COUNT(DISTINCT CASE WHEN scope = 'campaign' AND kind = 'complete' THEN player_id END) AS finishers,
    COUNT(*) AS events,
    MIN(received_at) AS first_seen,
    MAX(received_at) AS last_seen
  FROM events WHERE campaign = ?1`;

// ---------- the chart ----------
// A table with a bar in one column: the bar is the chart and the row is its table view, so there is
// one thing to read rather than a picture and a duplicate of it underneath.
//
//   rows     [{ label, sub, value, extra: [string] }], already in the order they should appear
//   heads    column headings for `extra`
function chart(id, title, blurb, rows, heads, valueHead) {
  const top = axisTop(Math.max(0, ...rows.map((r) => r.value)));
  const grid = decades(top)
    .map((d) => `<span class="g${d.last ? " last" : ""}" style="left:${pct(d.frac)}"><i>${d.label}</i></span>`)
    .join("");
  const body = rows
    .map(
      (r) => `<tr>
        <th scope="row">${esc(r.label)}${r.sub ? ` <small>${esc(r.sub)}</small>` : ""}</th>
        <td class="plot">${grid}${r.value > 0 ? `<div class="bar" style="width:${pct(barFrac(r.value, top))}"></div>` : ""}</td>
        <td class="v">${num(r.value)}</td>
        ${r.extra.map((x) => `<td class="v s">${x}</td>`).join("")}
      </tr>`,
    )
    .join("");
  return `<section id="${id}">
    <h2>${esc(title)}</h2>
    <p class="blurb">${blurb}</p>
    ${rows.length ? `<div class="scroll"><table>
      <thead><tr>
        <th scope="col" class="name"></th>
        <th scope="col" class="axis">${grid}</th>
        <th scope="col" class="v">${esc(valueHead)}</th>
        ${heads.map((h) => `<th scope="col" class="v s">${esc(h)}</th>`).join("")}
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>` : `<p class="empty">Nothing recorded yet.</p>`}
  </section>`;
}

// ---------- the page ----------

const STYLE = `
:root{--ink:#2c2016;--soft:#5f4a34;--faint:#8a7358;--sheet:#efe5d3;--edge:#dcccb0;
  --ground:#241a12;--up:#f6ead9;--rule:rgba(112,88,60,.28);--bar:${BAR}}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;padding:1.5rem 1rem 6rem;color:var(--up);
  font:16px/1.5 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
main{max-width:78rem;margin:0 auto}
header{padding:0 0 1.5rem}
h1{margin:0 0 .25rem;font-size:1.5rem;font-weight:400;letter-spacing:.12em;text-transform:uppercase}
.lede{margin:0;color:var(--up);opacity:.75;font-size:.9rem}
nav{margin:.9rem 0 0;font-size:.85rem;color:var(--up);opacity:.8}
nav a{color:var(--up)}
section{background:var(--sheet);color:var(--ink);border:1px solid var(--edge);
  border-radius:3px;padding:1.5rem;margin:0 0 1.5rem}
h2{margin:0 0 .3rem;font-size:1.05rem;font-weight:400;letter-spacing:.09em;text-transform:uppercase}
.blurb{margin:0 0 1.25rem;max-width:44rem;color:var(--soft);font-size:.82rem;line-height:1.55}
.empty{margin:0;color:var(--faint);font-style:italic}
/* On a phone the figures do not fold: the columns are the chart's table view and dropping any of
   them would lose a number. So the table scrolls sideways inside its sheet rather than squashing the
   plot down to nothing, and the page itself never scrolls sideways. */
.scroll{overflow-x:auto}
table{width:100%;min-width:34rem;border-collapse:collapse;font-size:.8rem}
th,td{padding:.2rem .5rem;text-align:left;font-weight:400;vertical-align:middle}
thead th{color:var(--faint);font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;
  padding-bottom:.55rem;border-bottom:1px solid var(--rule)}
tbody th{width:1px;white-space:nowrap;color:var(--ink);font-variant-numeric:tabular-nums}
tbody th small{color:var(--faint);font-size:.85em}
.v{width:1px;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
.s{color:var(--soft)}
/* The plot column takes whatever is left, and the decade lines are absolutely placed inside it, so
   one set of gridlines is written per row and the bars line up without a fixed pixel width. */
.axis,.plot{position:relative;width:auto;min-width:12rem}
.axis{height:1.2rem}
.g{position:absolute;top:0;bottom:0;border-left:1px solid var(--rule)}
.g i{position:absolute;top:0;left:2px;color:var(--faint);font-size:.66rem;font-style:normal;
  font-variant-numeric:tabular-nums}
.g.last i{left:auto;right:2px}
/* THIN BARS, AND WHY. Fifty-nine rungs of a gated campaign are fifty-nine bars within one decade of
   each other, and drawn thick they are a solid block of gold with the answer hidden inside it. Drawn
   thin, with the row taller than the bar, it is their ENDS that the eye follows — and the line those
   ends trace down the page is the drop-off, which is the thing the chart was made to show. */
.plot{height:1.25rem}
.plot .g i{display:none}
.bar{position:relative;height:.4rem;top:.42rem;min-width:2px;background:var(--bar);
  border-radius:0 2px 2px 0}
footer{padding:1rem 0 0;font-size:.78rem;color:var(--up);opacity:.6;max-width:44rem}
footer p{margin:0 0 .6rem}
@media print{body{background:#fff;color:#000;padding:0}
  section{border-color:#999;margin-bottom:1rem;break-inside:avoid}
  header,footer{color:#000;opacity:1}}
`;

const when = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "—");

function page(campaign, camps, overall, levels, sections, key) {
  // ONE ORDER FOR BOTH LEVEL CHARTS, and it comes out of the data rather than out of a copy of the
  // campaign manifest: levels sorted by how many players reached them. The campaign is gated —
  // a rung opens when the ones above it are done — so reach falls monotonically down the ladder and
  // sorting by it recovers the running order, with the drop-off as the shape of the chart. A copy of
  // the manifest here would be a second place to keep the ladder in step, and would be wrong for
  // every release but the one it was copied from.
  const byReach = [...levels].sort((a, b) => b.reached - a.reached || String(a.level_id).localeCompare(String(b.level_id)));
  const lv = (r) => (r.level_version === null ? "" : `v${r.level_version}`);

  // A level event carries its chapter too (worker.js requires it for every scope but the campaign),
  // so the chapter can be named beside each rung without a second query or a copy of the manifest.
  const chap = (r) => esc(r.section || "—");

  const reach = byReach.map((r) => ({
    label: r.level_id,
    sub: lv(r),
    value: r.reached,
    extra: [num(r.finished), r.reached ? `${Math.round((r.finished / r.reached) * 100)}%` : "—", mins(r.secs), chap(r)],
  }));

  const hints = byReach.map((r) => ({
    label: r.level_id,
    sub: lv(r),
    value: r.hinted,
    extra: [num(r.finished), r.finished ? `${Math.round((r.hinted / r.finished) * 100)}%` : "—", num(r.hint_total), r.avg_hints === null ? "—" : r.avg_hints.toFixed(2), chap(r)],
  }));

  const secs = [...sections]
    .sort((a, b) => b.reached - a.reached || String(a.section).localeCompare(String(b.section)))
    .map((r) => ({
      label: r.section,
      sub: "",
      value: r.reached,
      extra: [num(r.finished), r.reached ? `${Math.round((r.finished / r.reached) * 100)}%` : "—", mins(r.secs), r.avg_hints === null ? "—" : r.avg_hints.toFixed(2)],
    }));

  const link = (c) => `<a href="/report?c=${c}&amp;key=${encodeURIComponent(key)}">r${c}</a>`;
  const others = camps.filter((c) => c.campaign !== campaign);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Play statistics — campaign r${campaign}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
  <h1>Play statistics · campaign r${campaign}</h1>
  <p class="lede">${num(overall.players)} players · ${num(overall.finishers)} finished the campaign ·
    ${num(overall.events)} events · ${when(overall.first_seen)} to ${when(overall.last_seen)} UTC</p>
  <nav>Campaign ${others.length ? `r${campaign} · also ${others.map((c) => link(c.campaign)).join(" · ")}` : `r${campaign} only`}</nav>
</header>

${chart(
  "reach",
  "How far players get",
  "Players who <strong>reached</strong> each level — one bar per rung of the campaign, the longest at " +
    "the top. The scale is <strong>logarithmic</strong>: each gridline is ten times the one before it, " +
    "so a steady rate of drop-off draws a straight slope and the rungs where players actually stop are " +
    "the steps in it. Levels are ordered by reach, which is the running order: the campaign unlocks " +
    "downwards, so a level cannot be reached by more players than the one above it.",
  reach,
  ["Finished", "Clear", "Avg time", "Chapter"],
  "Reached",
)}

${chart(
  "hints",
  "Where players ask for help",
  "Players who took <strong>at least one hint</strong> on each level, in the same order as above, on the " +
    "same logarithmic scale. <strong>Read this against the finishers, not the players who reached it</strong>: " +
    "a hint is only reported when the level is completed, so a player who took three hints and gave up " +
    "anyway is counted in neither column here. Hints are counted once each however many times the card " +
    "is paged back to.",
  hints,
  ["Finished", "Of those", "Hints", "Avg each", "Chapter"],
  "Took a hint",
)}

${chart(
  "sections",
  "How many reach each chapter",
  "Players who <strong>unlocked</strong> each chapter — recorded the first time any level in it is " +
    "opened — on the same logarithmic scale, longest first. A chapter is the only grouping a player " +
    "sees, so this is the campaign's shape at the scale they experience it.",
  secs,
  ["Finished", "Clear", "Avg time", "Avg hints"],
  "Unlocked",
)}

<footer>
  <p>Every figure counts <strong>distinct players</strong>, not events: one person replaying a level in
    three save slots is one player who reached it. A player is a random number made on their phone and
    is not linked to anything else — see <a href="/privacy">the privacy policy</a>.</p>
  <p>Average time and average hints are taken over completions that were tracked from the start. A save
    made before the app collected any of this reports its completions with the earlier play missing, and
    those are left out of the averages rather than allowed to drag them down.</p>
  <p>A level is counted at the version it shipped at, within one campaign release. Figures from other
    releases are on their own page.</p>
</footer>
</main>
</body>
</html>`;
}

// ---------- the handler ----------

const deny = (status, msg) =>
  new Response(msg, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });

export async function reportPage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "method not allowed\n");

  // Fail closed: no secret configured means no report, never an open one.
  const want = env.REPORT_TOKEN;
  if (typeof want !== "string" || want.length < 16) return deny(503, "report not configured\n");
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const key = url.searchParams.get("key") || bearer;
  if (!sameSecret(key, want)) return deny(404, "not found\n");

  if (!env.DB) return deny(503, "no database\n");

  const camps = (await env.DB.prepare(CAMPAIGNS).all()).results || [];
  if (!camps.length) return html(emptyPage());

  // The release being played now, unless one is named. `c` is checked against what is actually in the
  // database rather than passed to the query on trust.
  const asked = Number(url.searchParams.get("c"));
  const campaign = camps.some((c) => c.campaign === asked) ? asked : camps[0].campaign;

  const [overall, levels, sections] = await Promise.all([
    env.DB.prepare(OVERALL).bind(campaign).first(),
    env.DB.prepare(LEVELS).bind(campaign).all(),
    env.DB.prepare(SECTIONS).bind(campaign).all(),
  ]);

  return html(page(campaign, camps, overall || {}, levels.results || [], sections.results || [], key));
}

const emptyPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Play statistics</title><style>${STYLE}</style></head><body><main><header>
<h1>Play statistics</h1><p class="lede">No events have been recorded yet.</p></header></main></body></html>`;

// The page's own CSP, set here because public/_headers covers static assets only. It is the site's
// `default-src 'none'` with inline styles allowed and nothing else added: no script, no image, no
// origin. `no-referrer` keeps the key in the URL from travelling to anywhere this page links.
const html = (body) =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    },
  });
