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
import { composePage, validateDocument, type ElementorNode } from "../elementor/compose.ts";
import { applyBrandKit } from "../elementor/kit.ts";
import { getBlock } from "../elementor/registry.ts";
import { applyLogo, importImage } from "./media.ts";
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

/**
 * Create or update a page by slug, returning its post id.
 *
 * Takes just the title and slug rather than a whole `Page` so the clone
 * pipeline, which has no brief sections, can reuse it.
 */
export async function upsertPage(
  page: { title: string; slug: string },
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

/**
 * Write an Elementor document onto a page.
 *
 * The payload goes to a file and is handed to PHP by path, never as a CLI
 * argument — see php/set-elementor-data.php for why the write has to happen
 * inside PHP at all (`wp post meta update` corrupts the JSON).
 *
 * Shared with the clone pipeline, which produces its elements a different way
 * but must persist them identically.
 */
export async function writeElementorDocument(options: {
  postId: number;
  /** Basename for the payload file kept in out/, for debugging. */
  payloadName: string;
  /** Human-readable name for the log line. */
  label: string;
  elements: ElementorNode[];
  sitePath: string;
  logger: JobLogger;
}): Promise<void> {
  const payloadPath = path.join(PATHS.out, `${options.payloadName}.json`);
  await writeFile(
    payloadPath,
    JSON.stringify({ elements: options.elements, page_settings: {} }, null, 2),
    "utf8",
  );

  options.logger.step(
    `Writing Elementor data for “${options.label}” (${options.elements.length} sections)…`,
  );
  await run(
    options.logger,
    ["eval-file", SET_DATA_SCRIPT, String(options.postId), payloadPath],
    { sitePath: options.sitePath },
  );
}

/**
 * Import every image a page references, rewriting the section content in place
 * so compose emits a local URL and its attachment id. Runs before compose
 * because the composer is pure and cannot await a download.
 */
async function resolveSectionImages(
  page: Page,
  sitePath: string,
  logger: JobLogger,
): Promise<void> {
  for (const section of page.sections) {
    const block = await getBlock(section.block);
    for (const param of block.params) {
      if (param.type !== "image") continue;

      const supplied = section.content[param.key];
      const url =
        typeof supplied === "string" && supplied.trim() !== ""
          ? supplied
          : param.default;
      if (!url) continue;

      const imported = await importImage(url, sitePath, logger);
      section.content[param.key] = imported.url;
      section.content[`${param.key}_id`] = imported.id;
    }
  }
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
      await resolveSectionImages(page, sitePath, logger);
      const elements = await composePage(page, brief);

      // Catch a malformed document here; a bad one renders as a blank page
      // with no error anywhere, which is painful to diagnose later.
      const problems = validateDocument(elements);
      if (problems.length > 0) {
        throw new Error(
          `Composed layout for “${page.title}” is invalid:\n  ${problems.join("\n  ")}`,
        );
      }

      await writeElementorDocument({
        postId,
        payloadName: `${brief.site.slug}-${page.slug}`,
        label: page.title,
        elements,
        sitePath,
        logger,
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

  await applyLogo(brief.site.logoUrl, sitePath, logger);
  await applyBrandKit(brief, sitePath, logger);
  await removeDefaultContent(sitePath, logger);
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

/**
 * WordPress ships a "Sample Page", a "Privacy Policy" draft and a "Hello world!"
 * post. Leaving them behind is the clearest sign of an unfinished site, and they
 * turn up in menus and search results.
 */
async function removeDefaultContent(
  sitePath: string,
  logger: JobLogger,
): Promise<void> {
  const defaults: Array<{ type: string; slug: string }> = [
    { type: "page", slug: "sample-page" },
    { type: "page", slug: "privacy-policy" },
    { type: "post", slug: "hello-world" },
  ];

  const removed: string[] = [];
  for (const { type, slug } of defaults) {
    const found = await wp(
      ["post", "list", `--post_type=${type}`, `--name=${slug}`, "--post_status=any", "--field=ID", "--format=ids"],
      { sitePath, throwOnError: false },
    );
    const id = Number(found.stdout.trim().split(/\s+/)[0]);
    if (!Number.isInteger(id) || id <= 0) continue;

    const deleted = await wp(["post", "delete", String(id), "--force"], {
      sitePath,
      throwOnError: false,
    });
    if (deleted.exitCode === 0) removed.push(slug);
  }

  if (removed.length > 0) {
    logger.log(`Removed WordPress default content: ${removed.join(", ")}.`);
  }
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
