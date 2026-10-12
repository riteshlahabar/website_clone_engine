/**
 * The build pipeline. Each phase logs into the job stream the browser is
 * watching, so the UI shows real progress rather than a spinner.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { PATHS } from "./env.ts";
import type { JobLogger } from "./jobs.ts";
import { applyContent, type AppliedPage } from "./apply.ts";
import { provision, type ProvisionResult } from "./provision.ts";
import type { Brief } from "../shared/brief.ts";

export type BuildResult = ProvisionResult & {
  pages: AppliedPage[];
  briefPath: string;
};

/** Persist the brief so a build is reproducible and diffable. */
async function saveBrief(brief: Brief): Promise<string> {
  await mkdir(PATHS.briefs, { recursive: true });
  const target = path.join(PATHS.briefs, `${brief.site.slug}.yaml`);
  await writeFile(target, YAML.stringify(brief), "utf8");
  return target;
}

export async function runBuild(
  brief: Brief,
  logger: JobLogger,
): Promise<BuildResult> {
  logger.step(`Building “${brief.site.name}”`);

  const briefPath = await saveBrief(brief);
  logger.log(`Brief saved to ${briefPath}`);

  const provisioned = await provision(brief, logger);

  const pages = await applyContent(
    brief,
    provisioned.sitePath,
    provisioned.siteUrl,
    logger,
  );

  logger.success(`Build complete — ${pages.length} page(s) ready at ${provisioned.siteUrl}`);
  return { ...provisioned, pages, briefPath };
}
