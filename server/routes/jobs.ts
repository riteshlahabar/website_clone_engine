import type { FastifyInstance } from "fastify";
import { getJob, listJobs, subscribe } from "../lib/jobs.ts";

export function registerJobRoutes(app: FastifyInstance): void {
  app.get("/api/jobs", async () =>
    listJobs().map(({ log, ...rest }) => ({ ...rest, logLength: log.length })),
  );

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) return reply.code(404).send({ message: "No such job." });
    return job;
  });

  /**
   * SSE stream of a job's progress. The existing log is replayed first so a
   * late or reconnecting browser still renders the complete history.
   */
  app.get<{ Params: { id: string } }>("/api/jobs/:id/stream", (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) {
      void reply.code(404).send({ message: "No such job." });
      return;
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    for (const entry of job.log) send({ type: "log", entry });
    if (job.status !== "running") {
      send({ type: "status", status: job.status, error: job.error, result: job.result });
    }

    const unsubscribe = subscribe(job.id, (event) => {
      send(event);
      if (event.type === "status") {
        // Terminal state: close so the browser's EventSource stops retrying.
        reply.raw.end();
      }
    });

    // Comment frames keep intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
