/**
 * Brings the source site's files local, so a clone outlives the original.
 *
 * Two destinations, because the two kinds of asset are used differently:
 *
 * - Images go into the WordPress media library, via the existing
 *   `importImage`. That gets them an attachment id, which is what makes
 *   WordPress emit `srcset`, and it means the user can manage them in the
 *   admin like any other upload.
 * - Stylesheets and fonts go into the child theme's `assets/` folder. They are
 *   not media; they are part of the theme, and the media library would only
 *   get in the way.
 *
 * Everything here degrades rather than fails. A missing asset should leave one
 * broken image on a cloned page, not abort a twenty-page run.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { DESKTOP_UA } from "./extract.ts";
import type { ElementorNode } from "../elementor/compose.ts";
import type { JobLogger } from "../lib/jobs.ts";
import { importImage } from "../lib/media.ts";

/** Parallel downloads. Enough to hide latency, few enough to be polite. */
const CONCURRENCY = 6;

/** Extension for a content type, when the URL does not carry one. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "application/font-woff2": ".woff2",
  "application/font-woff": ".woff",
  "application/x-font-ttf": ".ttf",
  "text/css": ".css",
};

/**
 * A filename that is readable, unique and safe on Windows.
 *
 * The hash suffix matters: real sites serve different files under the same
 * basename from different folders (`icons/arrow.svg`, `hero/arrow.svg`), and
 * collapsing them would silently swap one image for another.
 */
export function localFilename(url: string, contentType?: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Keep the raw string; the slug step below copes.
  }
  const base = path.posix.basename(pathname) || "asset";
  const extension =
    path.posix.extname(base) ||
    (contentType ? EXTENSION_BY_TYPE[contentType.split(";")[0]!.trim().toLowerCase()] ?? "" : "");
  const stem = (extension ? base.slice(0, base.length - path.posix.extname(base).length) : base)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "asset";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${stem}-${hash}${extension || ""}`;
}

export type DownloadedAsset = {
  url: string;
  file: string;
  bytes: number;
};

/**
 * Download files into `destDir`, returning a map from source URL to the
 * path to reference them by (relative to `publicPrefix`).
 */
export async function downloadAssets(
  urls: Iterable<string>,
  options: {
    destDir: string;
    /** Prefix for the returned reference paths, e.g. "assets". */
    publicPrefix: string;
    logger: JobLogger;
  },
): Promise<Map<string, string>> {
  const unique = [...new Set([...urls])].filter((url) => /^https?:/i.test(url));
  const map = new Map<string, string>();
  if (unique.length === 0) return map;

  await mkdir(options.destDir, { recursive: true });
  const limit = pLimit(CONCURRENCY);
  let failed = 0;
  let bytes = 0;

  await Promise.all(
    unique.map((url) =>
      limit(async () => {
        try {
          const response = await fetch(url, {
            headers: { "user-agent": DESKTOP_UA, accept: "*/*" },
            signal: AbortSignal.timeout(45_000),
            redirect: "follow",
          });
          if (!response.ok) {
            failed += 1;
            return;
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.byteLength === 0) {
            failed += 1;
            return;
          }
          const name = localFilename(url, response.headers.get("content-type") ?? undefined);
          await writeFile(path.join(options.destDir, name), buffer);
          bytes += buffer.byteLength;
          map.set(url, `${options.publicPrefix}/${name}`);
        } catch {
          failed += 1;
        }
      }),
    ),
  );

  options.logger.log(
    `Localized ${map.size}/${unique.length} file(s), ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MB` +
      (failed > 0 ? ` — ${failed} could not be fetched.` : "."),
  );
  return map;
}

/**
 * Import images into the media library, reusing the builder's own importer so
 * attachment reuse, content-type naming and `srcset` all behave as they do
 * for a normal build.
 *
 * Returns a map from source URL to the WordPress URL, plus the attachment ids
 * so natively mapped image widgets can carry them.
 */
export async function importImages(
  urls: Iterable<string>,
  sitePath: string,
  logger: JobLogger,
): Promise<Map<string, { url: string; id: string }>> {
  const unique = [...new Set([...urls])].filter((url) => /^https?:/i.test(url));
  const map = new Map<string, { url: string; id: string }>();
  if (unique.length === 0) return map;

  logger.step(`Importing ${unique.length} image(s) into the media library…`);

  // Deliberately serial: `wp media import` is a PHP process per call and
  // running six at once on XAMPP's PHP is slower than running them in order,
  // as well as risking sideloading collisions on the same filename.
  let imported = 0;
  for (const url of unique) {
    const result = await importImage(url, sitePath, logger);
    // importImage never throws; a failure comes back with an empty id and the
    // original URL, which is still the right thing to reference.
    if (result.id) imported += 1;
    map.set(url, { url: result.url, id: result.id });
  }

  logger.log(`${imported}/${unique.length} image(s) became media attachments.`);
  return map;
}

/**
 * Point Elementor image widgets at the imported attachments.
 *
 * Mirrors what the brief pipeline does for block image params: without the
 * attachment id WordPress cannot emit `srcset`, and without the rewritten URL
 * the clone keeps hotlinking the source.
 */
export function applyImageMap(
  elements: ElementorNode[],
  media: Map<string, { url: string; id: string }>,
): number {
  let rewritten = 0;

  const swap = (target: unknown): void => {
    const slot = target as { url?: string; id?: string } | undefined;
    if (!slot?.url) return;
    const replacement = media.get(slot.url);
    if (!replacement) return;
    slot.url = replacement.url;
    slot.id = replacement.id;
    rewritten += 1;
  };

  const walk = (node: ElementorNode): void => {
    swap(node.settings.image);
    swap(node.settings.background_image);
    for (const child of node.elements) walk(child);
  };

  for (const node of elements) walk(node);
  return rewritten;
}
