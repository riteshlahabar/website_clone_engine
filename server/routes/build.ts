import type { FastifyInstance } from "fastify";
import { runDoctor } from "../lib/doctor.ts";
import { startJob } from "../lib/jobs.ts";
import { runBuild } from "../lib/pipeline.ts";
import { parseBrief } from "../shared/brief.ts";

export function registerBuildRoutes(app: FastifyInstance): void {
  /**
   * Validate a brief without building. Lets the form show errors before the
   * user commits to a long-running job.
   */
  app.post("/api/brief/validate", async (request, reply) => {
    const parsed = parseBrief(request.body);
    if (!parsed.ok) return reply.code(400).send({ ok: false, errors: parsed.errors });
    return { ok: true, brief: parsed.brief };
  });

  app.post("/api/build", async (request, reply) => {
    const parsed = parseBrief(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ ok: false, errors: parsed.errors });
    }

    // A build that starts on a broken environment fails confusingly halfway
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

    const brief = parsed.brief;
    const job = startJob(`build:${brief.site.slug}`, (logger) => runBuild(brief, logger));
    return { ok: true, jobId: job.id };
  });
}
