/**
 * Measures how close a clone actually came.
 *
 * Every other check in this project is structural — HTTP 200, a widget count,
 * valid JSON. All of those passed on a clone that rendered three times too
 * tall with its logo blown up to 1254px, because none of them look at the
 * page. The only honest test of a clone is a picture of it next to a picture
 * of the original.
 *
 * Two numbers come out, and they answer different questions:
 *
 * - `heightRatio` catches collapsed layout. A page that stacks what should sit
 *   side by side is the characteristic clone failure, and it shows up here as
 *   a ratio far from 1 long before any pixel is examined.
 * - `difference` is the share of pixels that disagree, over the region both
 *   images share. It catches wrong colours, wrong fonts and missing images.
 *
 * Neither is expected to be zero. Fonts rasterise differently between runs,
 * animations land in different places, and a clone served from localhost
 * renders its own URLs. Treat these as a regression signal — a run that was
 * 4% different and is now 40% broke something — rather than a pass/fail gate.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Browser } from "playwright";
import { launchBrowser, screenshotPage, withPage, type ExtractOptions } from "./extract.ts";
import type { JobLogger } from "../lib/jobs.ts";

export type VisualComparison = {
  sourceUrl: string;
  cloneUrl: string;
  source: { width: number; height: number };
  clone: { width: number; height: number };
  /** Clone height ÷ source height. 1 means the layout is the same shape. */
  heightRatio: number;
  /** Share of compared pixels that differ, 0..1. */
  difference: number;
  /** Where the side-by-side difference image was written, if one was. */
  diffPath?: string;
};

/** Crop a PNG to the given box, in place of a dependency on a resize library. */
function crop(image: PNG, width: number, height: number): PNG {
  if (image.width === width && image.height === height) return image;
  const out = new PNG({ width, height });
  // Fill with white so a short image compares against blank rather than black,
  // which would otherwise read as a total mismatch in the missing region.
  out.data.fill(0xff);
  PNG.bitblt(image, out, 0, 0, Math.min(width, image.width), Math.min(height, image.height), 0, 0);
  return out;
}

export type CompareOptions = ExtractOptions & {
  /** Write a visual diff here. Omitted means no image is produced. */
  diffPath?: string;
  /** Pixel difference tolerance, 0..1. Higher ignores more. */
  tolerance?: number;
};

/**
 * Screenshot `cloneUrl` and compare it with a screenshot of the source taken
 * during capture.
 *
 * The source screenshot is reused rather than retaken: it was captured at the
 * same viewport with the same settle logic, and retaking it would both double
 * the work and let the source drift between the two shots.
 */
export async function compareToSource(
  options: {
    sourceUrl: string;
    sourceScreenshotPath: string;
    cloneUrl: string;
    cloneScreenshotPath: string;
  } & CompareOptions,
  logger: JobLogger,
  existingBrowser?: Browser,
): Promise<VisualComparison> {
  const browser = existingBrowser ?? (await launchBrowser());
  try {
    await withPage(browser, options.cloneUrl, options, async (page) => {
      await screenshotPage(page, options.cloneScreenshotPath);
    });
  } finally {
    if (!existingBrowser) await browser.close();
  }

  const source = PNG.sync.read(await readFile(options.sourceScreenshotPath));
  const clone = PNG.sync.read(await readFile(options.cloneScreenshotPath));

  const width = Math.min(source.width, clone.width);
  const height = Math.min(source.height, clone.height);
  const a = crop(source, width, height);
  const b = crop(clone, width, height);

  const diff = new PNG({ width, height });
  const differing = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: options.tolerance ?? 0.12,
  });

  let diffPath: string | undefined;
  if (options.diffPath) {
    await writeFile(options.diffPath, PNG.sync.write(diff));
    diffPath = options.diffPath;
  }

  const result: VisualComparison = {
    sourceUrl: options.sourceUrl,
    cloneUrl: options.cloneUrl,
    source: { width: source.width, height: source.height },
    clone: { width: clone.width, height: clone.height },
    heightRatio: source.height > 0 ? clone.height / source.height : 0,
    difference: width * height > 0 ? differing / (width * height) : 1,
    ...(diffPath ? { diffPath } : {}),
  };

  logger.log(
    `Visual check: ${(result.difference * 100).toFixed(1)}% of pixels differ, ` +
      `height ${source.height}px → ${clone.height}px ` +
      `(${result.heightRatio.toFixed(2)}×).`,
  );
  return result;
}

/** A sentence for the job log and the result panel. */
export function describeComparison(result: VisualComparison): string {
  const pixels = `${(result.difference * 100).toFixed(1)}% of pixels differ`;
  const ratio = result.heightRatio;
  if (ratio < 0.8 || ratio > 1.25) {
    return `${pixels}; the clone is ${ratio.toFixed(2)}× the source's height, ` +
      `which usually means a row of content was stacked vertically.`;
  }
  if (result.difference > 0.3) {
    return `${pixels} — the layout matches but the painting does not. ` +
      `Check that the cloned stylesheet and its fonts loaded.`;
  }
  return `${pixels}; height within ${Math.abs(1 - ratio) * 100 < 1 ? "1" : Math.round(Math.abs(1 - ratio) * 100)}% of the source.`;
}

/** Default path for a page's clone screenshot, beside the source one. */
export function cloneScreenshotPath(screenshotDir: string, slug: string): string {
  return path.join(screenshotDir, `${slug}-clone.png`);
}

/** Default path for a page's diff image. */
export function diffScreenshotPath(screenshotDir: string, slug: string): string {
  return path.join(screenshotDir, `${slug}-diff.png`);
}
