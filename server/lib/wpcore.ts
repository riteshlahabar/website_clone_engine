/**
 * Downloading and unpacking WordPress core.
 *
 * `wp core download` is deliberately NOT used. It fetches a .tar.gz, and PHP's
 * PharData truncates any path longer than the 100-byte ustar `name` field —
 * WordPress ships files well past that (e.g. the php-ai-client provider
 * interfaces), producing names with a trailing dot that Windows cannot create.
 * Its `tar xz` fallback is equally unreliable because GNU tar may shadow bsdtar
 * on PATH.
 *
 * Instead we fetch the official .zip and unpack it with Windows' bundled
 * bsdtar, addressed by absolute path so PATH ordering cannot change the result.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { PATHS } from "./env.ts";
import type { JobLogger } from "./jobs.ts";

const WORDPRESS_ZIP_URL = "https://wordpress.org/latest.zip";

/** Windows' bundled bsdtar. Unlike GNU tar it extracts .zip archives. */
const BSDTAR = "C:\\Windows\\System32\\tar.exe";

/** Cached so repeated builds don't re-download ~25MB each time. */
const CACHED_ZIP = path.join(PATHS.out, "wordpress-latest.zip");

function isInstalled(sitePath: string): boolean {
  return existsSync(path.join(sitePath, "wp-includes", "version.php"));
}

async function fetchZip(logger: JobLogger): Promise<string> {
  if (existsSync(CACHED_ZIP)) {
    const { size } = await stat(CACHED_ZIP);
    if (size > 10_000_000) {
      logger.log(`Using cached WordPress archive (${Math.round(size / 1e6)}MB).`);
      return CACHED_ZIP;
    }
    await rm(CACHED_ZIP, { force: true });
  }

  logger.step("Downloading WordPress…");
  const response = await fetch(WORDPRESS_ZIP_URL);
  if (!response.ok) {
    throw new Error(`Could not download WordPress (HTTP ${response.status}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < 10_000_000) {
    throw new Error(
      `WordPress archive looks wrong (${buffer.byteLength} bytes); expected ~25MB.`,
    );
  }
  await mkdir(PATHS.out, { recursive: true });
  await writeFile(CACHED_ZIP, buffer);
  logger.log(`Downloaded ${Math.round(buffer.byteLength / 1e6)}MB.`);
  return CACHED_ZIP;
}

/**
 * Ensure WordPress core files exist at `sitePath`. No-op when already present.
 */
export async function ensureWordPressCore(
  sitePath: string,
  logger: JobLogger,
): Promise<void> {
  if (isInstalled(sitePath)) {
    logger.log("WordPress core already present — skipping download.");
    return;
  }
  if (!existsSync(BSDTAR)) {
    throw new Error(
      `Windows' bsdtar was not found at ${BSDTAR}, so the WordPress archive cannot be unpacked.`,
    );
  }

  const zipPath = await fetchZip(logger);

  // Extract to a scratch directory first: the archive contains a top-level
  // `wordpress/` folder we need to strip.
  const scratch = await mkdtemp(path.join(tmpdir(), "wpsb-"));
  try {
    logger.step("Unpacking WordPress…");
    const extraction = await execa(BSDTAR, ["-xf", zipPath, "-C", scratch], {
      reject: false,
      timeout: 300_000,
    });
    if (extraction.exitCode !== 0) {
      throw new Error(
        `Unpacking failed: ${extraction.stderr || extraction.stdout || "unknown error"}`,
      );
    }

    const unpacked = path.join(scratch, "wordpress");
    if (!existsSync(unpacked)) {
      const found = await readdir(scratch);
      throw new Error(
        `Expected a 'wordpress' folder in the archive, found: ${found.join(", ") || "nothing"}`,
      );
    }

    await mkdir(sitePath, { recursive: true });
    await cp(unpacked, sitePath, { recursive: true, force: true });

    if (!isInstalled(sitePath)) {
      throw new Error(
        `WordPress was unpacked but ${path.join(sitePath, "wp-includes", "version.php")} is missing.`,
      );
    }
    logger.success(`WordPress core installed to ${sitePath}`);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
