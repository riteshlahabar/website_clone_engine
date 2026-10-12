/**
 * Upload and manage premium plugin zips.
 *
 * Elementor Pro and paid themes are not on wordpress.org, so WP-CLI cannot
 * fetch them. The user supplies the .zip and it is installed from disk.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { PATHS } from "../lib/env.ts";

const MAX_BYTES = 64 * 1024 * 1024;

/** Reject anything that could escape vendor-plugins/ or isn't a zip. */
function safeZipName(name: string): string | null {
  const base = path.basename(name);
  if (base !== name) return null;
  if (!/^[A-Za-z0-9._-]+\.zip$/i.test(base)) return null;
  if (base.startsWith(".")) return null;
  return base;
}

export function registerPluginRoutes(app: FastifyInstance): void {
  app.get("/api/plugins/premium", async () => {
    await mkdir(PATHS.vendorPlugins, { recursive: true });
    const entries = await readdir(PATHS.vendorPlugins);
    const zips = entries.filter((name) => name.toLowerCase().endsWith(".zip"));

    const files = await Promise.all(
      zips.map(async (name) => {
        const info = await stat(path.join(PATHS.vendorPlugins, name));
        return { name, size: info.size, uploadedAt: info.mtime.toISOString() };
      }),
    );
    return { files: files.sort((a, b) => a.name.localeCompare(b.name)) };
  });

  app.post("/api/plugins/premium", async (request, reply) => {
    const upload = await request.file({ limits: { fileSize: MAX_BYTES } });
    if (!upload) {
      return reply.code(400).send({ ok: false, message: "No file was uploaded." });
    }

    const name = safeZipName(upload.filename);
    if (!name) {
      return reply.code(400).send({
        ok: false,
        message: `“${upload.filename}” is not a plain .zip filename.`,
      });
    }

    await mkdir(PATHS.vendorPlugins, { recursive: true });
    const target = path.join(PATHS.vendorPlugins, name);
    await pipeline(upload.file, createWriteStream(target));

    // Busboy truncates past the limit rather than erroring, so check after.
    if (upload.file.truncated) {
      await rm(target, { force: true });
      return reply.code(413).send({
        ok: false,
        message: `${name} is larger than ${MAX_BYTES / 1024 / 1024}MB.`,
      });
    }

    const info = await stat(target);
    return { ok: true, file: { name, size: info.size } };
  });

  app.delete<{ Params: { name: string } }>(
    "/api/plugins/premium/:name",
    async (request, reply) => {
      const name = safeZipName(request.params.name);
      if (!name) {
        return reply.code(400).send({ ok: false, message: "Invalid filename." });
      }
      await rm(path.join(PATHS.vendorPlugins, name), { force: true });
      return { ok: true };
    },
  );
}
