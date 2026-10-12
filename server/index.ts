/**
 * WP Site Builder server.
 *
 * Serves the browser UI and the build API. Started by start.bat, which then
 * opens the default browser — the user never needs a terminal.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import open from "open";
import { PATHS, SERVER_PORT } from "./lib/env.ts";
import { registerBlockRoutes } from "./routes/blocks.ts";
import { registerBuildRoutes } from "./routes/build.ts";
import { registerDoctorRoutes } from "./routes/doctor.ts";
import { registerJobRoutes } from "./routes/jobs.ts";
import { registerPluginRoutes } from "./routes/plugins.ts";
import { registerTemplateRoutes } from "./routes/templates.ts";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "warn" },
  bodyLimit: 25 * 1024 * 1024, // premium plugin zips are uploaded through here
});

await app.register(fastifyMultipart, { limits: { fileSize: 64 * 1024 * 1024 } });

await mkdir(PATHS.jobs, { recursive: true });
await mkdir(PATHS.screenshots, { recursive: true });
await mkdir(PATHS.briefs, { recursive: true });
await mkdir(PATHS.vendorPlugins, { recursive: true });

registerDoctorRoutes(app);
registerJobRoutes(app);
registerBuildRoutes(app);
registerBlockRoutes(app);
registerPluginRoutes(app);
registerTemplateRoutes(app);

app.get("/api/health", async () => ({ ok: true, port: SERVER_PORT }));

const uiBuilt = existsSync(PATHS.uiDist);
if (uiBuilt) {
  await app.register(fastifyStatic, { root: PATHS.uiDist });
  // SPA fallback: unknown non-API paths render the app shell.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ message: "Unknown API route." });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.get("/", async (_request, reply) =>
    reply.type("text/html").send(
      `<!doctype html><title>WP Site Builder</title>
       <body style="font:16px system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">
       <h1>UI not built yet</h1>
       <p>The interface has not been compiled. Run <code>npm run ui:build</code> once,
       then reload this page.</p></body>`,
    ),
  );
}

const address = await app.listen({ port: SERVER_PORT, host: "127.0.0.1" });
console.log(`WP Site Builder running at ${address}`);

if (process.env.NO_OPEN !== "1") {
  try {
    await open(address);
  } catch {
    console.log(`Open ${address} in your browser.`);
  }
}
