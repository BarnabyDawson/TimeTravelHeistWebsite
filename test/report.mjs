// THE REPORT PAGE. src/report.js is one pure half — the log axis, the ordering, the escaping — and
// one handler over a D1 binding, so both run here against plain objects and a fake database.
//
// THE FAILURES PINNED HERE ARE THE ONES THAT MATTER:
//   - the page opening to anyone, because the secret was missing, empty, short or wrongly compared;
//   - the log axis putting a count in the wrong place, or losing the count 1 to a zero-width bar;
//   - a campaign number off the query string reaching the SQL;
//   - a level id ending up in the markup unescaped.
//
// Run with `npm test` (node test/report.mjs). No framework: one `check` and a count, like the game
// repo's own tests.

import { reportPage, esc, sameSecret, axisTop, barFrac, decades, mins, MIN_TOKEN } from "../src/report.js";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗", name, detail === undefined ? "" : `\n      ${detail}`);
  }
}
const group = (name) => console.log(`\n${name}`);

// ---------- the secret ----------

group("the secret");

const TOKEN = "0123456789abcdef0123";

check("a matching key passes", sameSecret(TOKEN, TOKEN));
check("a wrong key of the same length fails", !sameSecret("0123456789abcdef0124", TOKEN));
check("a prefix of the key fails", !sameSecret("0123456789abcdef", TOKEN));
check("an empty key fails", !sameSecret("", ""));
check("a non-string fails", !sameSecret(undefined, TOKEN) && !sameSecret(null, TOKEN));

// ---------- the log axis ----------

group("the log axis");

check("the top is the next decade up", axisTop(1) === 10 && axisTop(9) === 10 && axisTop(10) === 10);
check("and it keeps climbing", axisTop(11) === 100 && axisTop(100) === 100 && axisTop(101) === 1000);
check("an empty chart still has an axis to draw in", axisTop(0) === 10);

check("a decade sits exactly on its gridline", barFrac(10, 100) === 0.5 && barFrac(100, 100) === 1);
check("the count 1 sits on the baseline", barFrac(1, 100) === 0);
// This is the property the whole chart rests on: on a log axis, equal RATIOS are equal DISTANCES.
// 500 -> 50 must be the same width as 50 -> 5, or the drop-off is not readable as a slope.
const step = barFrac(500, 1000) - barFrac(50, 1000);
check("equal ratios are equal distances", Math.abs(step - (barFrac(50, 1000) - barFrac(5, 1000))) < 1e-12, step);
check("nothing sits off the axis", barFrac(0, 100) === 0);

const d = decades(1000);
check("one gridline per decade", d.length === 4, JSON.stringify(d.map((x) => x.label)));
check("labelled 1 to the top", d.map((x) => x.label).join() === "1,10,100,1,000");
check("the last is marked so its label can turn round", d[3].last === true && d[0].last === undefined);

// ---------- the small print ----------

group("formatting");

check("a level id cannot break out of the markup", esc('<b>"x</b>') === "&lt;b&gt;&quot;x&lt;/b&gt;");
check("short times keep a decimal", mins(90) === "1.5m");
check("long ones do not", mins(3600) === "60m");
check("a missing average is a dash", mins(null) === "—" && mins(undefined) === "—");

// ---------- the handler ----------

group("the handler");

// A stand-in for the D1 binding: records what it was asked and answers from a fixture. `all` and
// `first` are the only two shapes src/report.js uses.
function fakeDb(fixture) {
  const asked = [];
  return {
    asked,
    prepare(sql) {
      const q = { sql, args: [] };
      asked.push(q);
      const rows = () => fixture(sql, q.args) || [];
      return {
        bind(...a) {
          q.args = a;
          return this;
        },
        all: async () => ({ results: rows() }),
        first: async () => rows()[0] || null,
      };
    },
  };
}

const FIXTURE = (sql) => {
  if (/GROUP BY campaign/.test(sql)) return [{ campaign: 6, players: 3, last_seen: 1 }, { campaign: 5, players: 1, last_seen: 1 }];
  if (/scope = 'level'/.test(sql))
    return [
      { level_id: "tut-0", level_version: 2, reached: 40, finished: 38, hinted: 4, hint_total: 9, secs: 65, avg_hints: 0.2 },
      { level_id: "<script>", level_version: 1, reached: 7, finished: 2, hinted: 2, hint_total: 11, secs: 900, avg_hints: 3 },
      { level_id: "tut-1", level_version: 2, reached: 22, finished: 20, hinted: 9, hint_total: 30, secs: 300, avg_hints: 1.1 },
    ];
  if (/scope = 'section'/.test(sql))
    return [{ section: "Training part 1", reached: 40, finished: 12, secs: 800, avg_hints: 2 }];
  if (/COUNT\(DISTINCT player_id\) AS players/.test(sql))
    return [{ players: 40, finishers: 1, events: 500, first_seen: 1758000000000, last_seen: 1759000000000 }];
  return [];
};

const get = (url, env, headers) => reportPage(new Request(url, { headers }), env, new URL(url));
const ENV = () => ({ REPORT_TOKEN: TOKEN, DB: fakeDb(FIXTURE) });

let r = await get("https://x/report", { DB: fakeDb(FIXTURE) });
check("no secret configured refuses the page", r.status === 503, r.status);

r = await get("https://x/report?key=" + TOKEN, { REPORT_TOKEN: "short", DB: fakeDb(FIXTURE) });
check("a secret too short to be one refuses it too", r.status === 503, r.status);

// The visitor is told the same thing either way — "too short" would narrow a guess — but whoever
// set the secret has to be able to tell the two apart, and a secret that IS set reading back as
// "not configured" sends them looking in the wrong place entirely.
{
  const said = [];
  const err = console.error;
  console.error = (m) => said.push(String(m));
  const a = await get("https://x/report", { DB: fakeDb(FIXTURE) });
  const b = await get("https://x/report", { REPORT_TOKEN: "short", DB: fakeDb(FIXTURE) });
  console.error = err;
  check("the visitor cannot tell missing from too short",
    a.status === b.status && (await a.text()) === (await b.text()));
  check("but the log can: missing says so", /not set/.test(said[0] || ""), said[0]);
  check("and too short says how short", /5 characters/.test(said[1] || "") && new RegExp(`${MIN_TOKEN}`).test(said[1] || ""), said[1]);
}

r = await get("https://x/report", ENV());
check("no key is not found", r.status === 404, r.status);
r = await get("https://x/report?key=nope", ENV());
check("a wrong key is not found", r.status === 404, r.status);

r = await get("https://x/report?key=" + TOKEN, ENV());
check("the right key in the query string opens it", r.status === 200, r.status);
const body = await r.text();

r = await get("https://x/report", ENV(), { Authorization: `Bearer ${TOKEN}` });
check("so does a bearer header", r.status === 200, r.status);

r = await reportPage(new Request("https://x/report", { method: "POST" }), ENV(), new URL("https://x/report"));
check("POST is refused", r.status === 405, r.status);

group("the page");

const csp = (await get("https://x/report?key=" + TOKEN, ENV())).headers.get("Content-Security-Policy");
check("its CSP allows inline style and nothing else",
  /default-src 'none'/.test(csp) && /style-src 'unsafe-inline'/.test(csp) && !/script-src/.test(csp), csp);
check("it is not cached and not indexed",
  (await get("https://x/report?key=" + TOKEN, ENV())).headers.get("Cache-Control") === "no-store");
check("and the key cannot leak by referrer",
  (await get("https://x/report?key=" + TOKEN, ENV())).headers.get("Referrer-Policy") === "no-referrer");

check("there is no <script> in it", !/<script/i.test(body));
check("a level id is escaped", body.includes("&lt;script&gt;") && !body.includes("<script>"));
check("all three charts are drawn", /id="reach"/.test(body) && /id="hints"/.test(body) && /id="sections"/.test(body));
check("the scale is named as logarithmic", /logarithmic/i.test(body));

// The two level charts must share one order — they are read against each other.
const order = (id) => {
  const sec = body.split(`id="${id}"`)[1].split("</section>")[0];
  return [...sec.matchAll(/<th scope="row">([^<\s]+)/g)].map((m) => m[1]);
};
check("levels are ordered by reach, which is the running order", order("reach").join() === "tut-0,tut-1,&lt;script&gt;", order("reach"));
check("and the hints chart keeps that order", order("hints").join() === order("reach").join(), order("hints"));

// Every extra column is written in two places — the heading list and the row — and a number under
// the wrong heading is worse than no number at all.
for (const id of ["reach", "hints", "sections"]) {
  const sec = body.split(`id="${id}"`)[1].split("</section>")[0];
  const heads = (sec.split("</thead>")[0].match(/<th scope="col"/g) || []).length;
  const cells = sec
    .split("<tbody>")[1]
    .split("</tr>")
    .filter((r) => r.includes("<th scope=\"row\""))
    .map((r) => 1 + (r.match(/<td/g) || []).length);
  check(`${id}: every row has a cell for every heading`, cells.length > 0 && cells.every((c) => c === heads), `${heads} headings, rows ${[...new Set(cells)]}`);
}

const env = ENV();
await get("https://x/report?c=6&key=" + TOKEN, env);
check("the campaign asked for is passed to the queries", env.asked === undefined || env.DB.asked.slice(1).every((q) => q.args[0] === 6));

const env2 = ENV();
await get("https://x/report?c=99&key=" + TOKEN, env2);
check("one that is not in the database is not", env2.DB.asked.slice(1).every((q) => q.args[0] === 6),
  JSON.stringify(env2.DB.asked.map((q) => q.args)));

const env3 = ENV();
await get("https://x/report?c=6%20OR%201=1&key=" + TOKEN, env3);
check("and neither is anything that is not a number", env3.DB.asked.slice(1).every((q) => q.args[0] === 6));

const env4 = { REPORT_TOKEN: TOKEN, DB: fakeDb(() => []) };
r = await get("https://x/report?key=" + TOKEN, env4);
check("an empty database is a page, not a crash", r.status === 200 && /No events/.test(await r.text()), r.status);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
