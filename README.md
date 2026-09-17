# timetravelheist.co.uk

The companion site for **Time Travel Heist**, a turn-based time-travel puzzle game
for Android by Annanor Technologies Ltd.

Four hand-written static pages and one stylesheet. No build step, no framework, no
JavaScript anywhere on the site — see the note on the CSP below, which is not an
aesthetic preference but a promise the privacy policy makes on the site's behalf.

## Layout

```
public/            everything that is served, exactly as served
  index.html       the game
  support.html     served at /support
  privacy.html     served at /privacy
  404.html
  favicon.svg
  robots.txt
  sitemap.xml
  _headers         security headers, including the CSP
  css/site.css     the whole design: palette, the rail layout, print styles
wrangler.jsonc     Cloudflare Workers config: static assets + custom domains
WEBSITE_SPEC.MD    what the finished site is meant to be. Most of it isn't built.
```

## Running it locally

```sh
npm install
npm run dev          # http://localhost:8787
```

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
