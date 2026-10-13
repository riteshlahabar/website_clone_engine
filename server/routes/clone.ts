/**
 * Routes for the clone pipeline.
 *
 * Discovery is a job rather than a plain request because crawling a real site
 * takes tens of seconds — long enough that a synchronous call would look like
 * a hang and risk a proxy timeout. Both endpoints hand back a job id and the
 * browser follows the existing SSE stream.
 */
import type { FastifyInstance } from "fastify";
import { discoverPages } from "../clone/discover.ts";
import { runClone } from "../clone/pipeline.ts";
import { runDoctor } from "../lib/doctor.ts";
import { startJob } from "../lib/jobs.ts";
import { listHtdocsFolders, resolveCloneTarget } from "../lib/target.ts";
import { inspectDatabase } from "../lib/db.ts";
import { parseCloneSpec, type DiscoveredPage } from "../shared/clone.ts";

export function registerCloneRoutes(app: FastifyInstance): void {
  /**
   * List folders under htdocs, so the form can offer a picker instead of
   * asking the user to type an absolute Windows path.
   */
  app.get<{ Querystring: { path?: string } }>("/api/clone/folders", async (request) => {
    return listHtdocsFolders(request.query.path ?? "");
  });

  /**
   * Validate a spec and check the target without doing anything, so the form
   * can report a bad folder or a non-empty database before a run starts.
   */
  app.post("/api/clone/check", async (request, reply) => {
    const parsed = parseCloneSpec(request.body);
    if (!parsed.ok) return reply.code(400).send({ ok: false, errors: parsed.errors });

    const spec = parsed.spec;
    const errors: string[] = [];
    let siteUrl: string | null = null;

    try {
      const target = await resolveCloneTarget(spec);
      siteUrl = target.siteUrl;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    try {
      const state = await inspectDatabase(spec.dbName, {
        user: spec.dbUser,
        password: spec.dbPassword,
      });
      if (!state.exists) {
        errors.push(
          `Database "${spec.dbName}" does not exist. Create it in phpMyAdmin first.`,
        );
      } else if (state.tableCount > 0) {
        errors.push(
          `Database "${spec.dbName}" already holds ${state.tableCount} table(s). Use an empty one.`,
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return { ok: errors.length === 0, errors, siteUrl };
  });

  /** Crawl the source site and report the pages found, as a job. */
  app.post("/api/clone/discover", async (request, reply) => {
    const parsed = parseCloneSpec(request.body);
    if (!parsed.ok) return reply.code(400).send({ ok: false, errors: parsed.errors });

    const spec = parsed.spec;
    const job = startJob(`discover:${new URL(spec.sourceUrl).hostname}`, async (logger) => {
      const pages: DiscoveredPage[] = await discoverPages(
        spec.sourceUrl,
        { maxPages: spec.crawl.maxPages, respectRobots: spec.crawl.respectRobots },
        logger,
      );
      return { pages };
    });
    return { ok: true, jobId: job.id };
  });

  /** Run the clone. */
  app.post("/api/clone", async (request, reply) => {
    const parsed = parseCloneSpec(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ ok: false, errors: parsed.errors });
    }

    // A clone that starts on a broken environment fails confusingly halfway
    // through, so refuse up front and point at the Doctor panel.
    const report = await runDoctor();
    if (!report.ready) {
      const failing = report.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.label);
      return reply.code(409).send({
        ok: false,
        errors: [
          `Environment is not ready: ${failing.join(", ")}. Fix these in the Environment panel first.`,
        ],
      });
    }

    const spec = parsed.spec;
    // The browser sends the pages the user ticked; an empty list means
    // "discover them as part of the run".
    const chosen: DiscoveredPage[] = Array.isArray(
      (request.body as { selectedPages?: DiscoveredPage[] } | null)?.selectedPages,
    )
      ? (request.body as { selectedPages: DiscoveredPage[] }).selectedPages
      : [];

    const job = startJob(`clone:${new URL(spec.sourceUrl).hostname}`, (logger) =>
      runClone(spec, logger, { pages: chosen }),
    );
    return { ok: true, jobId: job.id };
  });
}
