import type { FastifyInstance } from "fastify";
import { runDoctor } from "../lib/doctor.ts";
import { startService } from "../lib/services.ts";
import { installWpCli } from "../lib/wpcli.ts";

const FIX_ACTIONS = {
  "install-wp-cli": async () => {
    const target = await installWpCli();
    return `WP-CLI installed at ${target}`;
  },
  "start-apache": async () => {
    await startService("apache");
    return "Apache started.";
  },
  "start-mariadb": async () => {
    await startService("mariadb");
    return "MariaDB started.";
  },
} as const;

type FixAction = keyof typeof FIX_ACTIONS;

export function registerDoctorRoutes(app: FastifyInstance): void {
  app.get("/api/doctor", async () => runDoctor());

  app.post<{ Body: { action?: string } }>("/api/doctor/fix", async (request, reply) => {
    const action = request.body?.action;
    if (!action || !(action in FIX_ACTIONS)) {
      return reply.code(400).send({
        ok: false,
        message: `Unknown fix action: ${String(action)}`,
      });
    }
    try {
      const message = await FIX_ACTIONS[action as FixAction]();
      // Re-run the checks so the UI can render fresh state in one round-trip.
      return { ok: true, message, report: await runDoctor() };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        report: await runDoctor(),
      });
    }
  });
}
