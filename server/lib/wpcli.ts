/**
 * The one and only place that invokes WP-CLI.
 *
 * WP-CLI is run as `php wp-cli.phar ...` rather than through a .bat shim so
 * argument quoting is handled by execa's array form instead of cmd.exe — which
 * is where Windows paths with spaces normally go wrong.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execa } from "execa";
import path from "node:path";
import { PATHS, XAMPP, findPhp } from "./env.ts";

const WP_CLI_PHAR_URL = "https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar";

/** Directory holding mysql.exe / mysqladmin.exe / mysqldump.exe. */
const XAMPP_MYSQL_BIN = path.dirname(XAMPP.mysql);

export type WpResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The command as a readable string, for the build log. */
  command: string;
};

export class WpCliError extends Error {
  // Declared and assigned explicitly: Node's strip-only TypeScript mode does
  // not support constructor parameter properties.
  result: WpResult;

  constructor(message: string, result: WpResult) {
    super(message);
    this.name = "WpCliError";
    this.result = result;
  }
}

export function isWpCliInstalled(): boolean {
  return existsSync(PATHS.wpCliPhar);
}

/** Download wp-cli.phar into tools/. Idempotent. */
export async function installWpCli(): Promise<string> {
  await mkdir(PATHS.tools, { recursive: true });
  const response = await fetch(WP_CLI_PHAR_URL);
  if (!response.ok) {
    throw new Error(
      `Could not download wp-cli.phar (HTTP ${response.status}). Check your internet connection.`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  // A valid phar is ~7MB; anything tiny is an error page, not a binary.
  if (buffer.byteLength < 1_000_000) {
    throw new Error(
      `Downloaded wp-cli.phar looks wrong (${buffer.byteLength} bytes). Expected several megabytes.`,
    );
  }
  await writeFile(PATHS.wpCliPhar, buffer);
  return PATHS.wpCliPhar;
}

export type WpOptions = {
  /** WordPress install root; becomes `--path=`. Omit for non-site commands. */
  sitePath?: string;
  /** Stream each output line as it arrives (used to feed the browser log). */
  onLine?: (line: string) => void;
  /** Throw a WpCliError on a non-zero exit. Defaults to true. */
  throwOnError?: boolean;
  timeoutMs?: number;
};

/**
 * Run a WP-CLI command, e.g. `wp(["plugin", "install", "elementor", "--activate"], { sitePath })`.
 */
export async function wp(
  args: string[],
  options: WpOptions = {},
): Promise<WpResult> {
  const php = findPhp();
  if (!php) {
    throw new Error(
      "No PHP executable found. Expected C:\\xampp\\php\\php.exe — is XAMPP installed?",
    );
  }
  if (!isWpCliInstalled()) {
    throw new Error(
      "wp-cli.phar is missing. Run the installer from the Doctor panel first.",
    );
  }

  const fullArgs = [
    // Extracting the WordPress tarball blows past PHP's default 128M limit and
    // dies with "Allowed memory size exhausted" mid-download. WP-CLI is a
    // short-lived CLI process, so an unbounded limit is the standard fix.
    "-d",
    "memory_limit=-1",
    PATHS.wpCliPhar,
    ...args,
    ...(options.sitePath ? [`--path=${options.sitePath}`] : []),
  ];
  const command = `wp ${args.join(" ")}`;

  const child = execa(php, fullArgs, {
    reject: false,
    all: true,
    timeout: options.timeoutMs ?? 300_000,
    env: {
      // WP-CLI refuses to run as root/admin without this; harmless on Windows.
      WP_CLI_ALLOW_ROOT: "1",
      // `wp db *` shells out to mysql/mysqladmin/mysqldump. XAMPP does not put
      // those on PATH, so without this every database command fails with a
      // bare "command not found".
      PATH: `${XAMPP_MYSQL_BIN};${process.env.PATH ?? ""}`,
    },
  });

  if (options.onLine && child.all) {
    let pending = "";
    child.all.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) options.onLine!(line);
    });
    child.all.on("end", () => {
      if (pending.trim()) options.onLine!(pending);
    });
  }

  const outcome = await child;
  const result: WpResult = {
    exitCode: outcome.exitCode ?? 1,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    command,
  };

  if (result.exitCode !== 0 && options.throwOnError !== false) {
    throw new WpCliError(
      `${command} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`.trim(),
      result,
    );
  }
  return result;
}

/** WP-CLI's own version string, or null when it can't run at all. */
export async function wpCliVersion(): Promise<string | null> {
  try {
    const result = await wp(["--version"], { throwOnError: false, timeoutMs: 30_000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}
