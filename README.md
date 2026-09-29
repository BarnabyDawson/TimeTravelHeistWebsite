# timetravelheist.co.uk

The companion site for **Time Travel Heist**, a turn-based time-travel puzzle game
for Android by Annanor Technologies Ltd.

Four hand-written static pages and one stylesheet. No build step, no framework, no
JavaScript in any page — see the note on the CSP below, which is not an aesthetic
preference but a promise the privacy policy makes on the site's behalf.

The only server code is the endpoint the game sends its anonymous play statistics
to (`src/worker.js`) and the private report that draws them (`src/report.js`) — see
*Play statistics* below. Between them they run only for `/api/*` and `/report`; every
page a reader visits is still a static file served straight from the edge, and the
report itself contains no JavaScript either.

## Layout

```
public/            everything that is served, exactly as served
  index.html       the game
  support.html     served at /support
  privacy.html     served at /privacy
  404.html
  favicon.ico        the gold exit portal, from the app icon (16/32/48)
  icon-192.png       the same, larger, for browsers that prefer PNG
  apple-touch-icon.png  the same on the sepia floor, for home-screen bookmarks
  robots.txt
  sitemap.xml
  _headers         security headers, including the CSP
  css/site.css     the whole design: palette, the rail layout, print styles
src/worker.js      the play-statistics endpoint, POST /api/v1/events
src/report.js      the private report on those statistics, GET /report
test/report.mjs    its tests — `npm test`
migrations/        the D1 schema for those statistics, and the summary views
wrangler.jsonc     Cloudflare Workers config: static assets, custom domains, D1
WEBSITE_SPEC.MD    what the finished site is meant to be. Most of it isn't built.
```

## Running it locally

```sh
npm install
npx wrangler d1 migrations apply tth-metrics --local   # once, for the endpoint
npm run dev          # https://localhost:8787 (self-signed certificate)
```

It serves **https**, with a self-signed certificate your browser will warn about
once. That is on purpose: the statistics endpoint refuses plain http everywhere,
local included, so there is no code path that accepts statistics unencrypted.

`wrangler dev` is worth using over opening the files directly, because it applies
`_headers` and the extensionless-URL handling. Loading `index.html` off the disk
gets you neither, and the CSP is the thing most likely to break silently.

## Deploying

```sh
npx wrangler login   # once, per machine
npm run deploy
```

`wrangler.jsonc` declares `timetravelheist.co.uk` and `www.` as custom domains, so
the deploy creates the DNS records and certificate itself. The domain's nameservers
must already be Cloudflare's, and the zone must be on the same account as the Worker.

Two things in that file will bite if changed carelessly, and both are commented
in place: `name` must match the Worker that the Workers Builds connection created,
or a second empty Worker appears and takes the traffic; and `html_handling` is what
makes `/support` and `/privacy` resolve, which every canonical tag on the site
depends on.

## The content security policy

`public/_headers` serves `default-src 'none'` with no external origin permitted.
The privacy policy tells readers that opening a page here contacts nobody but this
domain and that there is no JavaScript on the site; the CSP is what makes that true
rather than merely intended, so a third-party embed added in a hurry is blocked by
the reader's browser instead of quietly loading.

**If you add anything that needs a script** — the playable demo is the obvious one —
relax `script-src` for that path alone, and edit the privacy policy in the same
commit. The claims that need narrowing are the last bullet of "The short version"
and the whole of "Analytics". There is a comment in `privacy.html` at the point
where the demo's own paragraph should go back in.

## Still to build

The nav shows Gallery, Demo and Press greyed out, which is deliberate — the shape
of the site is visible while it is being built, without a nav full of 404s. See
`WEBSITE_SPEC.MD` for what each is meant to hold. There is no artwork on the site
yet, which is also why no page has an `og:image`.

## Play statistics

The Android game sends anonymous play statistics here — which levels, sections and
campaigns each player has attempted and completed, and the play time and hint count
each completion took. What is sent, and when, is `game/metrics.js` in the game repo;
what is accepted and stored is `src/worker.js` here, which validates every field and
copies across only the ones it names. No IP address or other request detail is
stored. A player is a random UUID made on their phone; the privacy policy describes
all of this and must change in the same commit as anything that changes what is kept.

### First-time setup (once)

```sh
npx wrangler d1 create tth-metrics
# paste the database_id it prints into wrangler.jsonc, replacing the zeros
npx wrangler d1 migrations apply tth-metrics --remote
npm run deploy
```

A later schema change is a new numbered file in `migrations/`, applied with the same
`migrations apply --remote` **before** the deploy that relies on it.

### The report

`/report` draws the figures: three bar charts on a **logarithmic** scale, one per
question the statistics were collected to answer.

| Chart | The bar is | Read it for |
|---|---|---|
| How far players get | players who **reached** each level | where the campaign loses people |
| Where players ask for help | players who took **at least one hint** on a level | which puzzles are under-hinted or over-hard |
| How many reach each chapter | players who **unlocked** each chapter | the same shape at the scale a player sees |

The scale is logarithmic because reach spans three orders of magnitude — everybody
plays the first level and a handful finish the last — so on a linear axis the whole
tail of the campaign is a row of invisible stubs. Each gridline is ten times the one
before it, which means a *constant rate* of drop-off draws a straight slope and the
rungs where players actually stop are the steps in it.

Levels are ordered by reach, which recovers the running order without a copy of the
campaign manifest living here: the campaign unlocks downwards, so a level cannot be
reached by more players than the one above it. Both level charts use that one order,
so they can be read against each other.

**One caveat worth knowing before you act on chart 2.** A hint is only reported when
the level is *completed*, so a player who took three hints and gave up anyway is in
neither column. The hint chart therefore tells you which levels needed help among the
people who got through, and chart 1 tells you where the people who didn't went missing.

`?c=13` picks a campaign release; the newest one with any events is the default, and
the others are linked at the top of the page.

#### Getting in

It is behind a shared secret, and refuses itself outright if that secret is not set —
a missing binding must never be the thing that publishes it.

```sh
node -e "console.log(crypto.randomUUID().replace(/-/g,''))"   # or any long random string
npx wrangler secret put REPORT_TOKEN                          # paste it
echo 'REPORT_TOKEN=...' >> .dev.vars                          # for `npm run dev`; gitignored
```

Then `https://timetravelheist.co.uk/report?key=<the secret>`, which is a bookmark, or
`curl -H "Authorization: Bearer <the secret>"` for the same page without the key in
the URL. Rotating it is one more `wrangler secret put`. A wrong key is a 404 rather
than a 403, so the path does not confirm itself to anyone guessing.

The page has **no JavaScript** — the bars are divs with a width and the numbers are in
the markup beside every one of them, so it is its own table view and it prints. That
keeps the privacy policy's "no scripts at all" true without narrowing it. It does need
an inline `<style>`, so its CSP is set on its own response (`src/report.js`) rather
than by `public/_headers`, and is the site's `default-src 'none'` plus inline style and
nothing else.

`npm test` covers the token check, the log axis and the escaping.

### Reading the figures by hand

Three views summarise by distinct player, so one person replaying a level in three
save slots counts once. Time and hints are averaged over completions that were
tracked from the start (`partial = 0`) — a save that predates the feature reports its
completions, but with the earlier play missing, and would drag the averages down.

```sh
npx wrangler d1 execute tth-metrics --remote --command "SELECT * FROM level_stats WHERE campaign = 6 ORDER BY players_attempted DESC"
npx wrangler d1 execute tth-metrics --remote --command "SELECT * FROM section_stats WHERE campaign = 6"
npx wrangler d1 execute tth-metrics --remote --command "SELECT * FROM campaign_stats"
```

Where players give up is `players_attempted - players_completed` on `level_stats`.

### Deleting one player's statistics

The privacy policy promises this on request. The player's ID is shown in the game's
Options, under *Share play statistics*:

```sh
npx wrangler d1 execute tth-metrics --remote --command "DELETE FROM events WHERE player_id = '<their id>'"
```
