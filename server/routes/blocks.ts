import type { FastifyInstance } from "fastify";
import { clearBlockCache, listBlocks } from "../elementor/registry.ts";

export function registerBlockRoutes(app: FastifyInstance): void {
  /** Catalogue for the UI's section picker. */
  app.get("/api/blocks", async (request) => {
    // Block files are edited by hand during development; allow a forced reload.
    if ((request.query as { refresh?: string } | undefined)?.refresh) {
      clearBlockCache();
    }
    return { blocks: await listBlocks() };
  });
}
