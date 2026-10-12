import type { FastifyInstance } from "fastify";
import { getTemplate, listTemplates } from "../templates/registry.ts";

export function registerTemplateRoutes(app: FastifyInstance): void {
  app.get("/api/templates", async () => ({ templates: await listTemplates() }));

  app.get<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    try {
      return { template: await getTemplate(request.params.id) };
    } catch (error) {
      return reply
        .code(404)
        .send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
}
