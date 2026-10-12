# WP Site Builder

A browser-driven tool that builds WordPress sites with Elementor pages, a theme, and plugins
from a structured brief. Target environment is local XAMPP. **There is no terminal UI** — the
user double-clicks `start.bat`, a Fastify server boots, and the browser opens.

## Pipeline

```
Brief (UI form → briefs/<slug>.yaml)
  ├─ validate    zod schema (server/shared/brief.ts)
  ├─ provision   WP core + database + theme + plugins + permalinks
  ├─ compose     block templates + content → Elementor JSON per page
  └─ apply       pages, _elementor_data, front page, menu, flush-css
```

Long operations run as background **jobs**; the browser follows them over **SSE**
(`/api/jobs/:id/stream`). The job log is replayed on connect, so a reload never loses history.

## The two rules that keep this working

1. **Never write `_elementor_data` with `wp post meta update`.** WordPress runs `wp_unslash()`
   on meta writes and corrupts the JSON. Write it only through `php/set-elementor-data.php`
   via `wp eval-file`, which applies `wp_slash()`. Then run `wp elementor flush-css --regenerate`
   or pages render unstyled.
2. **Never generate Elementor JSON freehand.** The schema is large and version-sensitive;
   invented JSON produces blank or broken pages. Layouts come from the hand-verified,
   parameterized block library in `server/elementor/blocks/`. Code (or a model) may only
   *choose blocks and fill their text*, never author schema.

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
  shared/brief.ts       zod Brief schema
  routes/               doctor.ts, jobs.ts, build.ts, blocks.ts
ui/src/                 React app (App.tsx, api.ts, types.ts, components/)
php/                    eval-file scripts run inside WordPress
briefs/                 saved YAML briefs, one per site
tests/                  vitest suite over the compose engine
vendor-plugins/         premium .zip uploads (gitignored)
```

## Adding a block

1. Build the section by hand in Elementor, export the template, and strip it
   down to the element tree (`elType` / `widgetType` / `settings` / `elements`).
   Do not hand-write schema you have not seen Elementor produce.
2. Save it as `server/elementor/blocks/<id>.json`, replacing text and colours
   with `{{token}}` placeholders. Remove all `id` fields — compose regenerates them.
3. Add `<id>.meta.json` declaring every token as a param with a sensible default.
   Set `brand` on colour params that should follow the palette.
4. `npm test` — the suite composes every block and fails on malformed output.

## Known constraints

- **Elementor Pro and premium themes cannot be downloaded.** They are not on wordpress.org, so
  WP-CLI cannot fetch them. The user uploads a `.zip` through the UI into `vendor-plugins/` and
  supplies a license key; the builder then installs from the zip and runs `wp elementor license activate`.
- Free Elementor + Hello Elementor install automatically, so the default stack needs no uploads.
- Apache and MariaDB must be running. The Doctor panel starts them without a terminal.

---

# Decision & History log

Newest first. One entry per working session: what changed, why, and what broke.
When this passes ~150 lines, move older entries to `docs/HISTORY.md` and keep the last ~10 here.

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
