# WP Site Builder

A browser-driven tool that builds WordPress sites with Elementor pages, a theme, and plugins
from a structured brief. Target environment is local XAMPP. **There is no terminal UI** — the
user double-clicks `start.bat`, a Fastify server boots, and the browser opens.

## Sibling project

`../Mediator` publishes Elementor pages to an **existing, live** WordPress site over the
REST API, instead of provisioning a new one locally. It reuses this project's block library and
compose engine unchanged — if you add or change a block here, consider porting it there.
Runs on port 5180; this one uses 5174.

## Two pipelines

**Build** — invent a site from a brief:

```
Brief (UI form → briefs/<slug>.yaml)
  ├─ validate    zod schema (server/shared/brief.ts)
  ├─ provision   WP core + database + theme + plugins + permalinks
  ├─ media       import images and the logo into the media library
  ├─ compose     block templates + content → Elementor JSON per page
  ├─ apply       pages, _elementor_data, kit colours/fonts, front page, menu
  └─ verify      HTTP 200, PHP-notice scan, widget count per page
```

**Clone** — reproduce an existing site (`server/clone/`, spec in `server/shared/clone.ts`):

```
CloneSpec (UI form)
  ├─ checks      target folder + empty database, before anything expensive
  ├─ discover    which pages exist                     discover.ts
  ├─ provision   WordPress, reusing the Build pipeline
  ├─ capture     one Chromium, one visit per page      capture.ts + extract.ts
  │                computed styles, bands, markup, stylesheets, shell
  ├─ assets      fonts/video/CSS → theme assets, images → media library
  ├─ theme       child theme: chrome + shell + scoped CSS   theme.ts + css.ts
  ├─ pages       bands → Elementor document             hybrid.ts + map.ts
  └─ compare     screenshot the clone, diff it against the source   compare.ts
```

Long operations run as background **jobs**; the browser follows them over **SSE**
(`/api/jobs/:id/stream`). The job log is replayed on connect, so a reload never loses history.

## The three rules that keep this working

1. **Never write `_elementor_data` with `wp post meta update`.** WordPress runs `wp_unslash()`
   on meta writes and corrupts the JSON. Write it only through `php/set-elementor-data.php`
   via `wp eval-file`, which applies `wp_slash()`. Then run `wp elementor flush-css --regenerate`
   or pages render unstyled.
2. **Never generate Elementor JSON freehand.** The schema is large and version-sensitive;
   invented JSON produces blank or broken pages. Layouts come from the hand-verified,
   parameterized block library in `server/elementor/blocks/`. Code (or a model) may only
   *choose blocks and fill their text*, never author schema. `server/clone/map.ts` is the one
   scoped exception — see the note at the top of that file.
3. **Never call a clone correct without looking at it.** Structural checks — HTTP 200, a
   widget count, valid JSON — all passed on a clone that rendered three times too tall with
   its logo blown up to 1254px. `clone/compare.ts` screenshots the clone and diffs it against
   the source; that number is the only check that would have caught it.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Control layer | WP-CLI, plus PHP `eval-file` for Elementor meta | Only reliable way to write Elementor data |
| Environment | XAMPP at `C:\xampp`. **No Docker** | User requirement; XAMPP already installed |
| Interface | Browser only. **No terminal/CLI** | User requirement; `start.bat` is the entry point |
| Server | Fastify + SSE | Serves UI and streams build logs |
| UI | React 19 + Vite 8 + Tailwind 4 | Dynamic form: pages, drag-reorder sections, color pickers |
| Runtime | Node 24 native TypeScript | No build step for the server; `node server/index.ts` runs `.ts` directly |
| Brief format | YAML, validated with zod | Diffable and re-runnable; the form round-trips to it |
| Elementor layout | Flexbox **containers**, not legacy sections | Elementor 3.16+ default; block library targets one mode only |
| AI | **None.** No Anthropic SDK | User requirement — the builder is fully deterministic |

## Environment facts (verified on this machine)

- **PHP for WP-CLI:** `C:\php83\php.exe` (8.3.31) — preferred over XAMPP's PHP because it adds
  `gd` and `sodium`. Resolution order is in `server/lib/env.ts`.
- **PHP for Apache:** `C:\xampp\php\php.exe` (**8.0.30, end-of-life**) — this is what the built
  site actually runs on. The Doctor reports it as a warning; it works but XAMPP should be upgraded.
- **WP-CLI:** `tools/wp-cli.phar` (2.12.0), downloaded by the Doctor panel. Gitignored.
- **MariaDB:** 10.4.32, `root` with an empty password — XAMPP defaults.
- `C:\xampp\mysql\bin` is **not on PATH**, so `server/lib/wpcli.ts` injects it into every WP-CLI
  call. Without it every `wp db` command fails. (WP-CLI's `--info` still prints an empty
  "MySQL binary" line on Windows — cosmetic, the binaries do resolve.)
- Sites are provisioned to `C:\xampp\htdocs\<slug>`, database `wp_<slug>`,
  served at `http://localhost/<slug>`.
- **The server listens on 127.0.0.1:5174, and only one instance can.** A second launch dies
  with `EADDRINUSE`. `start.bat` now checks the port first and `stop.bat` frees it.
- **Every local site uses `admin` / `12345678`** (set 2026-10-13 across all six installs).
  Convenience for localhost-only development — never carry it to a real host. Note XAMPP's
  Apache binds to all interfaces, so these are reachable from the local network.
- **Generated admin passwords are written to `out/jobs/*.log` in plain text**, because the
  provisioner echoes the whole `wp core install` command. That is how a lost password is
  recovered; it is also why `out/` must stay gitignored and off shared storage.

## Conventions

- **Node strip-only TypeScript**: no `enum`, no namespaces, and **no constructor parameter
  properties** — declare and assign fields explicitly. `erasableSyntaxOnly` in `tsconfig.json`
  catches violations; `npx tsc --noEmit` before committing.
- Relative imports carry explicit extensions (`./env.ts`, `./App.tsx`) — required by
  `moduleResolution: nodenext`, and Vite handles them fine.
- Every WP-CLI invocation goes through `wp()` in `server/lib/wpcli.ts`. Never spawn `wp` elsewhere;
  that wrapper is the single place handling Windows quoting, PATH, and timeouts.
- Element ids in Elementor JSON are unique 7-character lowercase hex strings.
- Each block is a `<name>.json` template paired with a `<name>.meta.json` parameter spec.

## Commands

| Task | Command |
|---|---|
| Normal use | double-click `start.bat` |
| Stop a server whose window was lost | double-click `stop.bat` |
| Run server only | `npm start` (set `NO_OPEN=1` to suppress the browser) |
| Rebuild UI | `npm run ui:build` |
| UI dev with HMR | `npm run ui:dev` (port 5175, proxies `/api` to 5174) |
| Typecheck | `npx tsc --noEmit` |
| Tests | `npm test` |

## Layout

```
server/
  index.ts              Fastify bootstrap, static UI, SPA fallback
  lib/env.ts            all filesystem paths + PHP resolution
  lib/services.ts       start/detect Apache + MariaDB
  lib/wpcli.ts          the only WP-CLI entry point
  lib/wpcore.ts         WordPress download + bsdtar unpack
  lib/doctor.ts         preflight checks
  lib/jobs.ts           job registry + SSE event bus
  lib/provision.ts      core, db, theme, plugins, permalinks
  lib/apply.ts          pages, Elementor data, front page, menu
  lib/pipeline.ts       orchestrates provision → apply
  elementor/blocks/     the block library (*.json + *.meta.json)
  elementor/registry.ts loads and caches blocks
  elementor/compose.ts  token fill, id assignment, validation
  clone/discover.ts     crawl the source for pages
  clone/extract.ts      in-page computed-style walk; motion freezing
  clone/simplify.ts     DOM tree → bands (landmarks kept, nothing dropped)
  clone/capture.ts      one visit: styles, bands, markup, stylesheets, shell
  clone/css.ts          @layer flattening, scoping, url() rewriting
  clone/map.ts          bands → Elementor widgets (the `editable` path)
  clone/hybrid.ts       picks markup vs widgets per band; markup sanitising
  clone/theme.ts        child theme: chrome, shell, menu, fidelity mu-plugin
  clone/assets.ts       localise images, fonts, video
  clone/compare.ts      screenshot the clone and diff it against the source
  clone/pipeline.ts     orchestrates the whole clone
  shared/brief.ts       zod Brief schema
  shared/clone.ts       zod CloneSpec schema
  routes/               doctor.ts, jobs.ts, build.ts, blocks.ts, clone.ts
ui/src/                 React app (App.tsx, api.ts, types.ts, components/)
php/                    eval-file scripts run inside WordPress
briefs/                 saved YAML briefs, one per site
tests/                  vitest suite over the compose and clone engines
vendor-plugins/         premium .zip uploads (gitignored)
```

## How the clone engine reaches fidelity

The hard-won part. A clone of a modern site is not a translation problem, it is a
**preservation** problem — and the engine was originally built the other way round.

### Fidelity modes (`fidelity.mode` in the spec)

| Mode | What a band becomes | Use when |
|---|---|---|
| `exact` (default) | the source's own markup, styled by the source's own stylesheet | you want it to look identical |
| `auto` | markup where translation would lose too much, widgets elsewhere | a middle ground |
| `editable` | native Elementor widgets, always | you intend to rebuild it in Elementor anyway |

`exact` is the default because **the translation table cannot express a CSS framework.**
`map.ts` reads ~35 computed properties; Tailwind expresses a page with hundreds, plus
pseudo-elements, hover states and media queries that have no computed-style equivalent at
all. Translating a Tailwind page produces an approximation; keeping its markup produces the
page. Editability is worth nothing if the result is wrong.

### Five things that each silently ruined a clone

1. **Cascade layers lose to unlayered CSS, always.** A Tailwind v4 source puts *everything*
   in `@layer theme/base/utilities`; WordPress, Hello Elementor and Elementor all ship
   unlayered CSS, which therefore outranks all of it regardless of specificity. `img { height:
   auto }` from hello-elementor beat `.wpc-clone .h-14` and rendered a 56px logo at 1254px.
   `css.ts` now **flattens every `@layer`** before scoping.
2. **A band's markup is not enough — it needs its ancestors.** `.flex > *`, `:root` custom
   properties and the source's own `pt-[83px]` navbar offset all live above the band.
   `capture.ts` records the wrapper chain as a `CapturedShell`, and `theme.ts` reopens it in
   `header.php` and closes it in `footer.php`.
3. **Elementor's own wrapper divs break those relationships again.** Cloned markup lands
   inside `.site-main > .elementor > .e-con > .elementor-widget-html > …`. The generated theme
   sets `display: contents` on all of them, so they stop generating boxes while inherited
   values still pass through.
4. **WordPress edits cloned content.** Elementor's kit enqueues Google Fonts (a 7%-wider Inter
   that reflowed a paragraph and moved every band below it 23px down); WordPress swaps emoji
   for `<img>`; it re-encodes JPEGs at 82% and shrinks anything over 2560px; Hello Elementor
   prints a duplicate page title. All four are turned off — fonts via
   `elementor_google_font=0`, images via a **must-use plugin** (the import happens before the
   theme exists, so theme filters would be too late), the rest in the theme's `functions.php`.
5. **Segmentation dropped content without saying so.** See below.

### Band detection (`simplify.ts`)

Two rules, both learned from the same bad clone:

- **Landmarks are never folded away.** `simplify` collapses single-child wrappers, and it used
  to collapse `<section>` too — so the hero vanished and its `<h1>` and `<p>` were emitted as
  two separate full-width bands.
- **Children must be *stacked* before they count as bands.** A row of four cards is one band,
  not four. The old code descended into the cards and then discarded each for being narrower
  than 40% of the page, deleting a whole section. Nothing is dropped for being narrow now: a
  node too narrow to be a band means the *parent* was the band. Bands may still overlap by up
  to half their height, because pulling one up with a negative margin is a common device.

### Measuring it

`compare.ts` reports two numbers per page, and they answer different questions:

- **`heightRatio`** catches collapsed layout — the characteristic clone failure, visible long
  before any pixel is examined.
- **`difference`** catches wrong colours, fonts and missing images.

Both screenshots are taken with motion frozen (`extract.ts` pauses video and disables CSS
animation), without which the test page's two background videos alone reported 18% difference
between two screenshots of the *same* page. With freezing, source-vs-itself is **0.0%**, which
makes the number worth acting on.

**Measured on `https://legal-iota-cyan.vercel.app/`:** 4.5% of pixels differ, height within
0.2% — against 0.0% noise. The residue is text antialiasing and one re-encoded JPEG.

## Adding a starter template

Templates live in `server/templates/*.json` and are a whole brief minus the `site`
block — pages, sections, copy, palette and fonts. The filename must match the `id`.
Applying one never overwrites business name, slug, email, logo or password.

Tests enforce that every template references real blocks, sets only content keys the
block declares (a typo would otherwise be silently dropped), has exactly one front page,
and composes to a valid document.

## Adding a block

1. Build the section by hand in Elementor, export the template, and strip it
   down to the element tree (`elType` / `widgetType` / `settings` / `elements`).
   Do not hand-write schema you have not seen Elementor produce.
2. Save it as `server/elementor/blocks/<id>.json`, replacing text and colours
   with `{{token}}` placeholders. Remove all `id` fields — compose regenerates them.
3. Add `<id>.meta.json` declaring every token as a param with a sensible default.
   Set `brand` on colour params that should follow the palette.
4. `npm test` — the suite composes every block and fails on malformed output.

## Elementor free vs Pro

Elementor registers **upgrade stubs** for Pro widgets even when Pro is absent, so
`widgets_manager->get_widget_types()` listing a widget does **not** mean it is usable.
A block referencing one renders an "Upgrade Now" prompt instead of content.

Confirmed Pro-only (never use in a block): `price-table`, `form`, `slides`, `flip-box`,
`call-to-action`, `nav-menu`, `posts`, `portfolio`, `testimonial-carousel`,
`animated-headline`, `countdown`, `share-buttons`, `lottie`. A test enforces this list.

Confirmed free and in use: `heading`, `text-editor`, `button`, `icon-box`, `image`,
`icon-list`, `testimonial`, `accordion`, `counter`, `google_maps`.

To re-check on another install, inspect the class behind each widget — a stub is
`Elementor\Modules\Promotions\Widgets\Pro_Widget_Promotion`.

## Known constraints

- **Elementor Pro and premium themes cannot be downloaded.** They are not on wordpress.org, so
  WP-CLI cannot fetch them. The user uploads a `.zip` through the UI into `vendor-plugins/` and
  supplies a license key; the builder then installs from the zip and runs `wp elementor license activate`.
- Free Elementor + Hello Elementor install automatically, so the default stack needs no uploads.
- Apache and MariaDB must be running. The Doctor panel starts them without a terminal.
- **Discovery is blind to a single-page app.** `discover.ts` uses `fetch` + cheerio on purpose —
  launching Chromium per candidate would make a twenty-page crawl take minutes — but a React,
  Vue or Next SPA serves an empty shell, so there are no links to find. Measured on the test
  site: 455 bytes of HTML, `<div id="root"></div>`, **zero** `<a href>`. Every such site clones
  as one page regardless of how many routes it has.
  The fix is cheap and not done yet: `capture.ts` already collects rendered `links` into
  `CapturedPage.links` and nothing reads them. Feeding those back as discovery seeds when the
  static crawl yields ≤1 page would cost nothing on a normal site.
  *Not* the explanation for the test site only cloning one page — see below.
- **A nav menu is not evidence a page exists.** `legal-iota-cyan.vercel.app` links to
  `/services`, `/articles`, `/about` and `/contact` from its navbar; all four return
  **HTTP 404**. The clone is complete at one page because the source is one page. Before
  treating "only the home page was cloned" as a bug, render the other routes and check.
- **Links to pages that were not cloned are left pointing at the source.** `rewriteLink` only
  remaps URLs in the clone's own `linkMap`, so a menu item for a page that does not exist sends
  visitors off the clone to the original host — a Vercel 404, in the test site's case. Adding
  pages to an existing clone later means re-running the clone or editing Appearance → Menus;
  cross-page links only wire themselves up for pages cloned in the same run.

---

# Decision & History log

Newest first. One entry per working session: what changed, why, and what broke.
When this passes ~150 lines, move older entries to `docs/HISTORY.md` and keep the last ~10 here.

## 2026-10-13 — Launcher, credentials, and what "only one page" meant

Follow-up session. No engine code changed; two launcher scripts and three findings.

- **`start.bat` failed silently and looked like a dead app.** An instance left running from
  earlier held port 5174, so every double-click died instantly on `EADDRINUSE` — and that path
  ended in `goto end` with no `pause`, so the window closed before the error could be read.
  `start.bat` now checks the port first and offers to open the running instance instead,
  `pause`s on *any* failure, and says that closing the window stops the server (which is how
  the orphan got created). New `stop.bat` frees the port when the original window is gone.
- **All six local installs set to `admin` / `12345678`** at the user's request, verified against
  `wp_check_password` rather than trusting WP-CLI's exit code. Recorded under Environment facts
  along with the plain-text passwords in `out/jobs/`, which is where the previous random
  password was recovered from.
- **"It only cloned the home page" was not a bug.** The source's navbar links to `/services`,
  `/articles`, `/about` and `/contact`; all four return HTTP 404 when rendered. The site is one
  page. Two real limitations surfaced while establishing that, both now under Known constraints:
  discovery cannot see links in an SPA, and links to uncloned pages stay pointed at the source.

**Still unverified:** `runClone()` has not been run end to end since the fidelity work — the
clone was regenerated by driving its stages against the existing install, because resetting the
database and site folder was blocked. Provisioning, discovery, the menu build, the brand kit and
the image-quality path (the mu-plugin now installs before import, but the images were reused
from the previous run) have not been exercised. A clean clone into a fresh slug and empty
database would close that gap.

## 2026-10-13 — Clone fidelity: from unusable to 4.5%

A clone of `legal-iota-cyan.vercel.app` came out **8606px tall against the source's 3340**,
with the logo rendered at 1254px, the navbar stacked vertically, one whole section missing
and the hero split into three bands. Every existing check passed on it. Rebuilt the parts of
the engine that caused each of those, and added the check that would have caught them.

**Result: 4.5% of pixels differ, height within 0.2%, against a 0.0% noise floor.**

- **`exact` is the new default fidelity mode.** Bands keep their source markup and are styled
  by the source's own stylesheet. `editable` (all native widgets) and `auto` (the old
  behaviour) remain, chosen from a dropdown in the clone form. The translation table cannot
  express a CSS framework and pretending otherwise was the root of most of this.
- **`css.ts` flattens `@layer`.** Cascade layers lose to unlayered rules unconditionally, and
  WordPress/Elementor ship unlayered CSS — so a Tailwind v4 source was outranked wholesale.
  This one bug alone accounted for the giant logo and most of the broken chrome.
- **`CapturedShell`**: the wrapper chain around the bands is captured and reopened in
  `header.php`/`footer.php`, and Elementor's own wrapper divs are set to `display: contents`,
  so ancestor-dependent CSS keeps matching.
- **`simplify.ts` rewritten twice over.** Landmarks (`section`, `nav`, `main`, …) are no longer
  folded away, and bands must be *stacked* — a row of cards is one band, not four discarded
  slivers. Band detection on the test page now reproduces its structure exactly: nav, four
  sections, footer.
- **`map.ts`**: `display: grid` is laid out as a row (it was defaulting to a column, which is
  why the page tripled in height), inner containers get their real width share (the code wrote
  a literal `size: 0`), background images survive a background colour, and gradients are
  reported rather than dropped.
- **`compare.ts`** is new: screenshots the clone, diffs it against the source with pixelmatch,
  and reports `heightRatio` and `difference` per page in the result panel.
- **`extract.ts` freezes motion** before every screenshot. Without it the page's two background
  videos reported 18% difference between two shots of the same page, making the metric useless.
- Images: every `srcset`/`<picture>` candidate is localised, not just `currentSrc`; video,
  audio and `poster` too.
- Tests 29 → 59. The clone engine had none, which is how all of this shipped.

**Four things WordPress does to cloned content, all now disabled:** Elementor's kit enqueues
Google Fonts (its Inter was 7% wider than the locally-installed one the source asks for — the
footer paragraph wrapped onto a fourth line and shifted everything below it down 23px); emoji
become `<img>`; JPEGs are re-encoded at 82% and anything over 2560px is shrunk; Hello
Elementor prints a duplicate page title. The image filters live in a **must-use plugin**,
because importing happens before the generated theme exists.

**Found by driving the result, not by reading code:** the menu came out empty because
`extractMenu` only recognised `<ul>` navigation and this nav is bare `<a>` tags in a flex row.
Those are now read into a real WordPress menu — but the markup is deliberately *not* swapped
for `wp_nav_menu()`, which would replace a nav that renders perfectly with `<ul><li><a>` that
does not.

## 2026-10-12 — Phase 5: starter templates

- Five templates in `server/templates/`: dental clinic, law firm, restaurant/café,
  fitness studio, trades. Each is a complete 2–3 page brief with real copy, a palette
  and fonts. Picking one fills the form; business details are never overwritten.
- `templates/registry.ts` validates every file against the zod schema at load, so a
  broken template fails on startup rather than halfway through a build.
- Tests 21 → 29.

**Bug found by driving the UI, and it would have hit any existing user:** a draft saved
in `localStorage` under an older schema came back missing `plugins.premium`, and
`toPayload` called `.map()` on it. The Build button silently did nothing — no error in
the UI, just a console `TypeError`. Added `normalizeDraft()`, which merges any stored
draft against current defaults and guarantees one front page, plus six tests covering
the legacy shape and junk input.

Also replaced `window.confirm` in the template picker with an inline confirm: a native
modal blocks the page and reads as an error rather than a choice.

## 2026-10-12 — Phase 4: blocks, global kit, images, premium upload, verify

Closed every gap identified in the completeness audit.

- **Block library 4 → 10.** Added `testimonials-3col`, `pricing-3col`, `contact-split`,
  `faq-accordion`, `text-image-split`, `stats-row`.
- **Global kit applied** (`php/set-elementor-kit.php`, `elementor/kit.ts`): brand colours
  become Elementor global colours and the chosen fonts become global typography plus
  Theme Style body/h1–h6. Fonts previously had no effect at all. Verified live: the kit
  CSS carries `--e-global-color-*` and Google Fonts are enqueued for the chosen families.
- **Images** (`lib/media.ts`): image params are imported into the media library before
  compose, with the attachment id written alongside the URL so WordPress emits `srcset`.
  Logo support added, with custom CSS capping its height.
- **Premium plugin upload** (`routes/plugins.ts` + `PremiumPlugins.tsx`): upload, list,
  tick and delete `.zip` files; the form now actually sends them.
- **Verify phase** (`lib/verify.ts`): every page is fetched after the build and checked
  for HTTP 200, PHP notices leaking into markup, and a non-zero widget count. Results
  appear as a badge per page in the result panel.
- **Default content removed** — Sample Page, Privacy Policy and Hello world! are deleted.
- Tests 11 → 15.

**Four problems found by actually running it:**
1. `price-table` is a **Pro stub**, so the originally planned pricing block would have
   rendered an upgrade prompt. Rebuilt from free widgets, and a test now enforces the
   Pro-widget blocklist.
2. `wp media import <url>` fails for any URL without a file extension (Unsplash, most
   CDNs) — WordPress infers type from the filename, so a valid JPEG is rejected as
   "not allowed to upload this file type". Now downloaded first and named from the
   `Content-Type` header.
3. **Bug caught by a new test:** `instantiate` stripped *every* `id` key to regenerate
   element ids, which also wiped the attachment id inside image settings. It now only
   regenerates ids on nodes that declare `elType`.
4. Rebuilds duplicated media (`hero.jpg`, `hero-2.jpg`, …). Existing attachments are
   now reused; verified the attachment count is unchanged across a rebuild.

## 2026-10-12 — Phases 1–3: provisioning, Elementor engine, browser form

- **Provisioning works end to end**: WordPress 7.1.3, Hello Elementor 3.5.1,
  Elementor 4.3.4, database, pretty permalinks, menu and front page.
- **Elementor engine works**: pages are composed from the block library and written
  through `php/set-elementor-data.php`. Four blocks so far: `hero-centered`,
  `features-3col`, `cta-banner`, `page-header`.
- **Browser form built**: brief editor with brand colour pickers, page management,
  a block picker, per-section content fields, and drag-reordering via dnd-kit.
  Build progress streams into the page over SSE; the result panel hands back the
  site URL, generated admin password and per-page Elementor edit links.
- Draft is kept in `localStorage` so a reload doesn't lose a half-filled form.
- 11 vitest tests cover composition, id uniqueness, brand resolution and schema.

**Verified in the browser, not just by API:** filled the form by hand for
"Lotus Yoga Studio", clicked Build, and got a working site. Separately confirmed
the Elementor editor opens a generated page and lists Heading / Text Editor /
Button as native editable widgets — the pass/fail gate for the whole JSON approach.

**Four real bugs found and fixed along the way:**
1. `wp core download` is unusable on Windows. PHP's `PharData` truncates tar paths
   at the 100-byte ustar `name` field; WordPress ships paths past that (the
   php-ai-client provider interfaces), so extraction produced a filename ending in
   `.` which Windows refuses to create. Its `tar xz` fallback is also unreliable
   because GNU tar can shadow bsdtar on PATH. Replaced with `lib/wpcore.ts`:
   fetch `latest.zip`, unpack with `C:\Windows\System32\tar.exe` by absolute path.
   The archive is cached in `out/` so repeat builds skip the 37MB download.
2. PHP's default 128M `memory_limit` killed WP-CLI mid-extract. Every WP-CLI call
   now passes `-d memory_limit=-1`.
3. `C:\xampp\mysql\bin` is not on PATH, which would have made every `wp db`
   command fail. The wrapper injects it.
4. `wp rewrite structure --hard` re-invokes WP-CLI without quoting the phar path
   and died on the space in "C:\All Project". Two fixes: the phar now installs to
   `%LOCALAPPDATA%\wp-site-builder\` (space-free), and `.htaccess` is written
   directly rather than via the subprocess.

## 2026-10-12 — Phase 0: foundation, Doctor panel, launcher

- Scaffolded the project: Fastify server, React/Vite/Tailwind UI, `start.bat` launcher.
- Built `lib/env.ts`, `lib/services.ts`, `lib/wpcli.ts`, `lib/doctor.ts`, `lib/jobs.ts`,
  and the `/api/doctor` + `/api/jobs` routes.
- Doctor panel ships with self-healing actions: install WP-CLI, start Apache, start MariaDB.
  Verified live — WP-CLI 2.12.0 downloaded through the UI's fix action, all checks green.
- **Scope changes requested mid-session:** dropped the Anthropic SDK (builder is fully
  deterministic), and replaced the planned CLI with a browser UI. `commander`, `ora`,
  and `picocolors` were never installed as a result.
- **Broke and fixed:** a constructor parameter property in `WpCliError` crashed Node's
  strip-only TypeScript loader (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Fields are now declared
  and assigned explicitly; `erasableSyntaxOnly` is on to catch recurrences.
- **Found and fixed:** `C:\xampp\mysql\bin` is absent from PATH, which would have made every
  `wp db` command fail during provisioning. The WP-CLI wrapper now injects it.
- **Discovered:** XAMPP's Apache runs PHP 8.0.30 (EOL) while the CLI uses PHP 8.3.31. Surfaced
  as a Doctor warning rather than hidden, since the served site runs on the older one.
