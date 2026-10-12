/**
 * Preflight checks surfaced in the browser's Doctor panel.
 *
 * Every check reports what to do about a failure, and names a `fixAction` when
 * the server can fix it on the user's behalf (so nobody has to open a terminal).
 */
import { existsSync } from "node:fs";
import { execa } from "execa";
import { APACHE_PHP, XAMPP, findPhp } from "./env.ts";
import { canConnectToDatabase, isServiceRunning } from "./services.ts";
import { isWpCliInstalled, wpCliVersion } from "./wpcli.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** An action id the UI can POST to /api/doctor/fix to resolve this. */
  fixAction?: "install-wp-cli" | "start-apache" | "start-mariadb";
  fixLabel?: string;
};

export type DoctorReport = {
  checks: Check[];
  /** True when nothing is in `fail` — i.e. a build can be attempted. */
  ready: boolean;
  checkedAt: string;
};

async function checkNode(): Promise<Check> {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    id: "node",
    label: "Node.js",
    status: major >= 24 ? "ok" : "fail",
    detail:
      major >= 24
        ? `v${process.versions.node}`
        : `v${process.versions.node} — Node 24+ is required for native TypeScript execution.`,
  };
}

/** `8.3.31` → [8, 3, 31] */
async function phpVersion(binary: string): Promise<number[] | null> {
  try {
    const { stdout } = await execa(binary, ["-r", "echo PHP_VERSION;"], {
      timeout: 15_000,
    });
    const parts = stdout.trim().split(".").map(Number);
    return parts.every(Number.isFinite) ? parts : null;
  } catch {
    return null;
  }
}

async function checkPhp(): Promise<Check> {
  const php = findPhp();
  if (!php) {
    return {
      id: "php",
      label: "PHP (WP-CLI)",
      status: "fail",
      detail: "Not found. Expected C:\\php83\\php.exe or C:\\xampp\\php\\php.exe.",
    };
  }
  const version = await phpVersion(php);
  if (!version) {
    return {
      id: "php",
      label: "PHP (WP-CLI)",
      status: "fail",
      detail: `${php} could not be run.`,
    };
  }
  // WP-CLI needs mysqli for every `wp db` command; without it provisioning dies
  // halfway through with a confusing error, so check up front.
  const { stdout: modules } = await execa(php, ["-m"], { reject: false, timeout: 15_000 });
  const hasMysqli = /^mysqli$/im.test(modules);
  return {
    id: "php",
    label: "PHP (WP-CLI)",
    status: hasMysqli ? "ok" : "fail",
    detail: hasMysqli
      ? `${version.join(".")} at ${php}`
      : `${version.join(".")} at ${php} is missing the mysqli extension, which WP-CLI needs.`,
  };
}

/**
 * Apache serves pages with its own bundled PHP module, which can differ from
 * the CLI PHP above. A stale Apache PHP is what the live site actually runs on.
 */
async function checkApachePhp(): Promise<Check> {
  const version = await phpVersion(APACHE_PHP);
  if (!version) {
    return {
      id: "php-apache",
      label: "PHP (Apache)",
      status: "warn",
      detail: `Could not read the version from ${APACHE_PHP}.`,
    };
  }
  const [major = 0, minor = 0] = version;
  const supported = major > 8 || (major === 8 && minor >= 1);
  return {
    id: "php-apache",
    label: "PHP (Apache)",
    status: supported ? "ok" : "warn",
    detail: supported
      ? `${version.join(".")} — this is what your site will run on.`
      : `${version.join(".")} is end-of-life and is what your site will actually run on. ` +
        `WordPress and Elementor will work, but upgrading XAMPP is recommended.`,
  };
}

async function checkXampp(): Promise<Check> {
  const present = existsSync(XAMPP.root) && existsSync(XAMPP.htdocs);
  return {
    id: "xampp",
    label: "XAMPP",
    status: present ? "ok" : "fail",
    detail: present
      ? `${XAMPP.root} (htdocs ready)`
      : `${XAMPP.root} not found — install XAMPP to continue.`,
  };
}

async function checkApache(): Promise<Check> {
  const running = await isServiceRunning("apache");
  return {
    id: "apache",
    label: "Apache",
    status: running ? "ok" : "fail",
    detail: running
      ? "Running — sites will be served on http://localhost/"
      : "Not running. Sites cannot be served until Apache starts.",
    fixAction: running ? undefined : "start-apache",
    fixLabel: running ? undefined : "Start Apache",
  };
}

async function checkMariadb(): Promise<Check> {
  const running = await isServiceRunning("mariadb");
  if (!running) {
    return {
      id: "mariadb",
      label: "MariaDB",
      status: "fail",
      detail: "Not running. WordPress needs a database to install into.",
      fixAction: "start-mariadb",
      fixLabel: "Start MariaDB",
    };
  }
  const connects = await canConnectToDatabase();
  return {
    id: "mariadb",
    label: "MariaDB",
    status: connects ? "ok" : "warn",
    detail: connects
      ? "Running and accepting connections as root."
      : "Process is up but refused a root connection — check the XAMPP root password.",
  };
}

async function checkWpCli(): Promise<Check> {
  if (!isWpCliInstalled()) {
    return {
      id: "wp-cli",
      label: "WP-CLI",
      status: "fail",
      detail: "tools/wp-cli.phar is missing. It is a single ~7MB download.",
      fixAction: "install-wp-cli",
      fixLabel: "Install WP-CLI",
    };
  }
  const version = await wpCliVersion();
  return {
    id: "wp-cli",
    label: "WP-CLI",
    status: version ? "ok" : "fail",
    detail: version ?? "wp-cli.phar is present but would not run. Check the PHP check above.",
  };
}

export async function runDoctor(): Promise<DoctorReport> {
  // Independent checks, so run them concurrently.
  const checks = await Promise.all([
    checkNode(),
    checkPhp(),
    checkApachePhp(),
    checkXampp(),
    checkApache(),
    checkMariadb(),
    checkWpCli(),
  ]);
  return {
    checks,
    ready: checks.every((check) => check.status !== "fail"),
    checkedAt: new Date().toISOString(),
  };
}
