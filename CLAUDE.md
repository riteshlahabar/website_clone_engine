# WP Site Builder

A browser-driven tool that builds WordPress sites with Elementor pages, a theme, and plugins
from a structured brief. Target environment is local XAMPP. **There is no terminal UI** — the
user double-clicks `start.bat`, a Fastify server boots, and the browser opens.

## Pipeline

```
Brief (UI form ⇄ site.yaml)
  ├─ validate    zod schema
  ├─ compose     block templates + content → Elementor JSON per page
  ├─ provision   WP core + database + theme + plugins   (WP-CLI)
  ├─ apply       pages, _elementor_data, kit styles, menus, media, flush-css
  └─ verify      HTTP 200s, PHP notice scan, screenshots
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
  index.ts          Fastify bootstrap, static UI, SPA fallback
  lib/env.ts        all filesystem paths + PHP resolution
  lib/services.ts   start/detect Apache + MariaDB
  lib/wpcli.ts      the only WP-CLI entry point
  lib/doctor.ts     preflight checks
  lib/jobs.ts       job registry + SSE event bus
  routes/           doctor.ts, jobs.ts
ui/src/             React app (App.tsx, api.ts, components/)
php/                eval-file scripts run inside WordPress
tools/              wp-cli.phar (gitignored)
vendor-plugins/     premium .zip uploads (gitignored)
```

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
