# timetravelheist.co.uk

The companion site for **Time Travel Heist**, a turn-based time-travel puzzle game
for Android by Annanor Technologies Ltd.

Four hand-written static pages and one stylesheet. No build step, no framework, no
JavaScript in any page — see the note on the CSP below, which is not an aesthetic
preference but a promise the privacy policy makes on the site's behalf.

The one piece of server code is the endpoint the game sends its anonymous play
statistics to (`src/worker.js`, see *Play statistics* below). It runs only for
`/api/*`; every page is still a static file served straight from the edge.

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

### Reading the figures

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
