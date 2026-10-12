/**
 * Pulls images into the WordPress media library.
 *
 * Elementor will happily render an external URL, but then the site depends on
 * someone else's host, gets no responsive srcset, and breaks if that URL dies.
 * Importing gives a real attachment the rest of WordPress understands.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./env.ts";
import { wp } from "./wpcli.ts";
import type { JobLogger } from "./jobs.ts";

const SET_CSS_SCRIPT = path.join(PROJECT_ROOT, "php", "set-custom-css.php");

export type ImportedImage = {
  /** Attachment ID, or "" when the import failed and we fell back to the URL. */
  id: string;
  /** Local URL when imported, otherwise the original. */
  url: string;
};

/** Imports are slow; the same URL often appears on several pages. */
const cache = new Map<string, ImportedImage>();

function cacheKey(sitePath: string, url: string): string {
  return `${sitePath}::${url}`;
}

/**
 * Import one image. Never throws: a broken image URL should degrade to
 * hot-linking, not abort an otherwise good build.
 */
export async function importImage(
  url: string,
  sitePath: string,
  logger: JobLogger,
): Promise<ImportedImage> {
  const trimmed = url.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    // Already a local path, a data URI, or empty — nothing to import.
    return { id: "", url: trimmed };
  }

  const key = cacheKey(sitePath, trimmed);
  const hit = cache.get(key);
  if (hit) return hit;

  const fallback: ImportedImage = { id: "", url: trimmed };

  // Download first rather than handing the URL straight to WP-CLI. WordPress
  // infers the file type from the filename, so any URL without an extension
  // (Unsplash and most CDNs) is rejected as "not allowed to upload this file
  // type" even when it serves a perfectly good JPEG.
  let localFile: string;
  try {
    localFile = await downloadToTemp(trimmed);
  } catch (error) {
    logger.warn(
      `Could not download ${trimmed} (${(error as Error).message}) — the page will link to it directly.`,
    );
    cache.set(key, fallback);
    return fallback;
  }

  try {
    // Re-importing on every build would stack up hero.jpg, hero-2.jpg,
    // hero-3.jpg… so reuse the attachment if this filename is already there.
    const stem = path.basename(localFile).replace(/\.[^.]*$/, "");
    const existing = await wp(
      ["post", "list", "--post_type=attachment", `--name=${stem}`, "--field=ID", "--format=ids"],
      { sitePath, throwOnError: false },
    );
    const existingId = Number(existing.stdout.trim().split(/\s+/)[0]);
    if (Number.isInteger(existingId) && existingId > 0) {
      logger.log(`Reusing existing image #${existingId}.`);
      return await finishImport(existingId, trimmed, sitePath, key, logger);
    }

    const imported = await wp(["media", "import", localFile, "--porcelain"], {
      sitePath,
      throwOnError: false,
      timeoutMs: 120_000,
    });

    const id = Number(imported.stdout.trim().split(/\s+/).pop());
    if (imported.exitCode !== 0 || !Number.isInteger(id) || id <= 0) {
      logger.warn(`Could not import ${trimmed} — the page will link to it directly.`);
      cache.set(key, fallback);
      return fallback;
    }
    return await finishImport(id, trimmed, sitePath, key, logger);
  } finally {
    await rm(localFile, { force: true }).catch(() => {});
  }
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

/** Fetch an image to a temp file named with the extension its type implies. */
async function downloadToTemp(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const extension = EXTENSION_BY_TYPE[contentType];
  if (!extension) {
    // SVG lands here too: WordPress blocks it by default for good reason.
    throw new Error(`unsupported image type "${contentType || "unknown"}"`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error("empty response");

  // Keep a readable stem so the media library is browsable, not a hash dump.
  const stem =
    (path.basename(new URL(url).pathname).replace(/\.[^.]*$/, "") || "image")
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 60) || "image";

  const directory = await mkdtemp(path.join(tmpdir(), "wpsb-img-"));
  const target = path.join(directory, `${stem}${extension}`);
  await writeFile(target, buffer);
  return target;
}

async function finishImport(
  id: number,
  originalUrl: string,
  sitePath: string,
  key: string,
  logger: JobLogger,
): Promise<ImportedImage> {
  const localUrl = await wp(["post", "get", String(id), "--field=guid"], {
    sitePath,
    throwOnError: false,
  });

  const result: ImportedImage = {
    id: String(id),
    url: localUrl.stdout.trim() || originalUrl,
  };
  cache.set(key, result);
  logger.log(`Image ready (#${id}).`);
  return result;
}

/** Import the site logo and attach it to the theme. */
export async function applyLogo(
  logoUrl: string,
  sitePath: string,
  logger: JobLogger,
): Promise<void> {
  if (!logoUrl.trim()) return;

  logger.step("Importing the site logo…");
  const logo = await importImage(logoUrl, sitePath, logger);
  if (!logo.id) {
    logger.warn("Logo could not be imported — the site will show its name as text.");
    return;
  }

  const set = await wp(["theme", "mod", "set", "custom_logo", logo.id], {
    sitePath,
    throwOnError: false,
  });
  if (set.exitCode !== 0) {
    logger.warn("Logo imported but the theme would not accept it.");
    return;
  }

  await constrainLogo(sitePath, logger);
  logger.success("Site logo set.");
}

/**
 * Themes render the custom logo at the image's natural size, so any logo that
 * is not already cropped for a header dominates the page. Cap it so an
 * ordinary image file still produces a sensible header.
 */
async function constrainLogo(sitePath: string, logger: JobLogger): Promise<void> {
  const css = [
    "/* Added by WP Site Builder: keep the site logo to a sane header size. */",
    ".custom-logo-link img,",
    ".site-header .custom-logo,",
    ".site-footer .custom-logo {",
    "  max-height: 64px;",
    "  width: auto;",
    "  object-fit: contain;",
    "}",
    "",
  ].join("\n");

  const directory = await mkdtemp(path.join(tmpdir(), "wpsb-css-"));
  const cssFile = path.join(directory, "logo.css");
  await writeFile(cssFile, css, "utf8");

  try {
    const result = await wp(["eval-file", SET_CSS_SCRIPT, cssFile], {
      sitePath,
      throwOnError: false,
    });
    if (result.exitCode !== 0) {
      logger.warn("Could not constrain the logo size; it may render large.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Drop cached imports (used between builds and by tests). */
export function clearMediaCache(): void {
  cache.clear();
}
