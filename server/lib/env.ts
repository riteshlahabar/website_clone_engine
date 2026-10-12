/**
 * Environment discovery for the XAMPP / PHP / WP-CLI toolchain.
 *
 * Everything the builder needs to touch on disk is resolved here so there is a
 * single place to look when a path is wrong on another machine.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const PATHS = {
  tools: path.join(PROJECT_ROOT, "tools"),
  wpCliPhar: path.join(PROJECT_ROOT, "tools", "wp-cli.phar"),
  php: path.join(PROJECT_ROOT, "php"),
  out: path.join(PROJECT_ROOT, "out"),
  jobs: path.join(PROJECT_ROOT, "out", "jobs"),
  screenshots: path.join(PROJECT_ROOT, "out", "screenshots"),
  vendorPlugins: path.join(PROJECT_ROOT, "vendor-plugins"),
  blocks: path.join(PROJECT_ROOT, "server", "elementor", "blocks"),
  uiDist: path.join(PROJECT_ROOT, "dist", "ui"),
  briefs: path.join(PROJECT_ROOT, "briefs"),
} as const;

export const XAMPP = {
  root: "C:\\xampp",
  htdocs: "C:\\xampp\\htdocs",
  httpd: "C:\\xampp\\apache\\bin\\httpd.exe",
  mysqld: "C:\\xampp\\mysql\\bin\\mysqld.exe",
  mysql: "C:\\xampp\\mysql\\bin\\mysql.exe",
  myIni: "C:\\xampp\\mysql\\bin\\my.ini",
  controlPanel: "C:\\xampp\\xampp-control.exe",
} as const;

/**
 * PHP used to run WP-CLI. Ordered best-first: the standalone PHP 8.3 carries
 * gd and sodium (which WordPress wants) on top of the mysqli that WP-CLI
 * requires, whereas XAMPP currently bundles an end-of-life PHP 8.0.
 *
 * Note this is only the CLI runtime — Apache serves pages with its own PHP
 * module from XAMPP, which is why the Doctor reports the two separately.
 */
const PHP_CANDIDATES = [
  "C:\\php83\\php.exe",
  "C:\\xampp\\php\\php.exe",
  "C:\\php\\php.exe",
];

export function findPhp(): string | null {
  return PHP_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** The PHP that Apache (and therefore the live site) actually runs on. */
export const APACHE_PHP = "C:\\xampp\\php\\php.exe";

/** MariaDB defaults in a stock XAMPP install: root with an empty password. */
export const DB = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  /** `wp_<slug>`, truncated to MySQL's 64-char identifier limit. */
  nameFor: (slug: string) => `wp_${slug}`.slice(0, 64),
} as const;

/** The local URL a provisioned site will be served from. */
export function siteUrlFor(slug: string): string {
  return `http://localhost/${slug}`;
}

/** Where on disk a provisioned site's WordPress root lives. */
export function sitePathFor(slug: string): string {
  return path.join(XAMPP.htdocs, slug);
}

export const SERVER_PORT = Number(process.env.PORT ?? 5174);
