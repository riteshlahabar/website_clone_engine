/**
 * Phase: apply — create the pages and write their Elementor documents.
 *
 * The Elementor meta write goes through php/set-elementor-data.php; see that
 * file for why `wp post meta update` cannot be used.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, PROJECT_ROOT } from "./env.ts";
import type { JobLogger } from "./jobs.ts";
import { wp } from "./wpcli.ts";
import { composePage, validateDocument } from "../elementor/compose.ts";
import { resolveFrontPage, type Brief, type Page } from "../shared/brief.ts";

const SET_DATA_SCRIPT = path.join(PROJECT_ROOT, "php", "set-elementor-data.php");

export type AppliedPage = {
  title: string;
  slug: string;
  postId: number;
  url: string;
  editUrl: string;
  isFrontPage: boolean;
};

async function run(
  logger: JobLogger,
  args: string[],
  options: { sitePath: string; allowFailure?: boolean },
) {
  logger.command(`wp ${args.join(" ")}`);
  return wp(args, {
    sitePath: options.sitePath,
    throwOnError: !options.allowFailure,
    onLine: (line) => {
      if (line.trim()) logger.log(line.trimEnd());
    },
  });
}

/** Find an existing page by slug so re-runs update rather than duplicate. */
async function findPageId(
  slug: string,
  sitePath: string,
): Promise<number | null> {
  const result = await wp(
    ["post", "list", "--post_type=page", `--name=${slug}`, "--field=ID", "--format=ids"],
    { sitePath, throwOnError: false },
  );
  const id = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function upsertPage(
  page: Page,
  sitePath: string,
  logger: JobLogger,
): Promise<number> {
  const existing = await findPageId(page.slug, sitePath);
  if (existing) {
    logger.log(`Page “${page.title}” already exists (#${existing}) — updating.`);
    await run(
      logger,
      ["post", "update", String(existing), `--post_title=${page.title}`, "--post_status=publish"],
      { sitePath },
    );
    return existing;
  }

  const result = await run(
    logger,
    [
      "post",
      "create",
      "--post_type=page",
      `--post_title=${page.title}`,
      `--post_name=${page.slug}`,
      "--post_status=publish",
      "--porcelain",
    ],
    { sitePath },
  );
  const id = Number(result.stdout.trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Could not read a post ID back for “${page.title}”.`);
  }
  return id;
}

export async function applyContent(
  brief: Brief,
  sitePath: string,
  siteUrl: string,
  logger: JobLogger,
): Promise<AppliedPage[]> {
  logger.step("Creating pages and Elementor layouts…");
  await mkdir(PATHS.out, { recursive: true });

  const applied: AppliedPage[] = [];
  const frontPage = resolveFrontPage(brief);

  for (const page of brief.pages) {
    const postId = await upsertPage(page, sitePath, logger);

    if (page.sections.length === 0) {
      logger.warn(`“${page.title}” has no sections — created as an empty page.`);
    } else {
      const elements = await composePage(page, brief);

      // Catch a malformed document here; a bad one renders as a blank page
      // with no error anywhere, which is painful to diagnose later.
      const problems = validateDocument(elements);
      if (problems.length > 0) {
        throw new Error(
          `Composed layout for “${page.title}” is invalid:\n  ${problems.join("\n  ")}`,
        );
      }

      const payloadPath = path.join(PATHS.out, `${brief.site.slug}-${page.slug}.json`);
      await writeFile(
        payloadPath,
        JSON.stringify({ elements, page_settings: {} }, null, 2),
        "utf8",
      );

      logger.step(`Writing Elementor data for “${page.title}” (${elements.length} sections)…`);
      await run(logger, ["eval-file", SET_DATA_SCRIPT, String(postId), payloadPath], {
        sitePath,
      });
    }

    applied.push({
      title: page.title,
      slug: page.slug,
      postId,
      url: page.slug === frontPage.slug ? `${siteUrl}/` : `${siteUrl}/${page.slug}/`,
      editUrl: `${siteUrl}/wp-admin/post.php?post=${postId}&action=elementor`,
      isFrontPage: page.slug === frontPage.slug,
    });
  }

  // Front page: WordPress shows the blog index until told otherwise.
  const front = applied.find((page) => page.isFrontPage);
  if (front) {
    logger.step(`Setting “${front.title}” as the front page…`);
    await run(logger, ["option", "update", "show_on_front", "page"], { sitePath });
    await run(logger, ["option", "update", "page_on_front", String(front.postId)], {
      sitePath,
    });
  }

  await applyMenu(brief, applied, sitePath, logger);

  // Elementor serves cached per-post CSS; without this the new layout renders
  // unstyled on first view.
  logger.step("Regenerating Elementor CSS…");
  await run(logger, ["elementor", "flush-css", "--regenerate"], {
    sitePath,
    allowFailure: true,
  });

  return applied;
}

async function applyMenu(
  brief: Brief,
  pages: AppliedPage[],
  sitePath: string,
  logger: JobLogger,
): Promise<void> {
  const { name, location } = brief.menu;
  logger.step(`Building the “${name}” menu…`);

  // Recreate from scratch so re-runs don't accumulate duplicate items.
  await run(logger, ["menu", "delete", name], { sitePath, allowFailure: true });
  const created = await run(logger, ["menu", "create", name, "--porcelain"], {
    sitePath,
    allowFailure: true,
  });
  if (created.exitCode !== 0) {
    logger.warn(`Could not create the menu — skipping navigation.`);
    return;
  }

  for (const page of pages) {
    await run(logger, ["menu", "item", "add-post", name, String(page.postId)], {
      sitePath,
      allowFailure: true,
    });
  }

  const assigned = await run(logger, ["menu", "location", "assign", name, location], {
    sitePath,
    allowFailure: true,
  });
  if (assigned.exitCode !== 0) {
    logger.warn(
      `Theme has no “${location}” menu location — the menu exists but is not displayed.`,
    );
  }
}
