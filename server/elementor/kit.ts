/**
 * Applies the brand palette and fonts to Elementor's global kit.
 *
 * Per-section colours are injected at compose time, but typography is inherited
 * rather than declared per widget — so without this step the fonts chosen in the
 * form have no effect at all.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, PROJECT_ROOT } from "../lib/env.ts";
import type { JobLogger } from "../lib/jobs.ts";
import { wp } from "../lib/wpcli.ts";
import type { Brief } from "../shared/brief.ts";

const SET_KIT_SCRIPT = path.join(PROJECT_ROOT, "php", "set-elementor-kit.php");

export async function applyBrandKit(
  brief: Brief,
  sitePath: string,
  logger: JobLogger,
): Promise<void> {
  logger.step("Applying brand colours and fonts to the Elementor kit…");

  await mkdir(PATHS.out, { recursive: true });
  const payloadPath = path.join(PATHS.out, `${brief.site.slug}-kit.json`);
  await writeFile(
    payloadPath,
    JSON.stringify({ colors: brief.brand.colors, fonts: brief.brand.fonts }, null, 2),
    "utf8",
  );

  logger.command(`wp eval-file set-elementor-kit.php`);
  const result = await wp(["eval-file", SET_KIT_SCRIPT, payloadPath], {
    sitePath,
    throwOnError: false,
    onLine: (line) => {
      if (line.trim()) logger.log(line.trimEnd());
    },
  });

  // A failed kit write leaves a usable site with the wrong fonts, so warn
  // rather than aborting a build that is otherwise fine.
  if (result.exitCode !== 0) {
    logger.warn(
      "Could not update the Elementor kit — brand fonts may not be applied.",
    );
  }
}
