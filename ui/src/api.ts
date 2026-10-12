/** Typed client for the builder API. Mirrors the server's response shapes. */

export type CheckStatus = "ok" | "warn" | "fail";

export type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fixAction?: "install-wp-cli" | "start-apache" | "start-mariadb";
  fixLabel?: string;
};

export type DoctorReport = {
  checks: Check[];
  ready: boolean;
  checkedAt: string;
};

export type LogLevel = "info" | "step" | "success" | "warn" | "error" | "command";

export type LogEntry = {
  at: string;
  level: LogLevel;
  message: string;
};

export type JobStatus = "running" | "done" | "error";

export type JobEvent =
  | { type: "log"; entry: LogEntry }
  | { type: "status"; status: JobStatus; error?: string; result?: unknown };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (body as { message?: string } | null)?.message ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  doctor: () => request<DoctorReport>("/api/doctor"),

  fix: (action: string) =>
    request<{ ok: boolean; message: string; report: DoctorReport }>("/api/doctor/fix", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
};

/**
 * Subscribe to a job's SSE stream. The server replays the backlog on connect,
 * so callers should reset their local log when calling this.
 */
export function streamJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/stream`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as JobEvent);
    } catch {
      // Ignore malformed frames rather than killing the stream.
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}

// --- blocks and builds -------------------------------------------------

import type { BlockMeta, BuildResult } from "./types.ts";

export async function fetchBlocks(): Promise<BlockMeta[]> {
  const data = await request<{ blocks: BlockMeta[] }>("/api/blocks");
  return data.blocks;
}

export type StartBuildResponse =
  | { ok: true; jobId: string }
  | { ok: false; errors: string[] };

/**
 * Start a build. Validation and environment failures come back as a structured
 * error list rather than a thrown exception, because the form renders them.
 */
export async function startBuild(payload: unknown): Promise<StartBuildResponse> {
  const response = await fetch("/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; jobId?: string; errors?: string[]; message?: string }
    | null;

  if (response.ok && body?.jobId) return { ok: true, jobId: body.jobId };
  return {
    ok: false,
    errors: body?.errors ?? [body?.message ?? `Build request failed (${response.status})`],
  };
}

export type { BuildResult };

// --- premium plugin zips ------------------------------------------------

export type PremiumFile = { name: string; size: number; uploadedAt?: string };

export async function fetchPremiumZips(): Promise<PremiumFile[]> {
  const data = await request<{ files: PremiumFile[] }>("/api/plugins/premium");
  return data.files;
}

export async function uploadPremiumZip(file: File): Promise<PremiumFile> {
  const body = new FormData();
  body.append("file", file);
  // No Content-Type header: the browser must set the multipart boundary.
  const response = await fetch("/api/plugins/premium", { method: "POST", body });
  const parsed = (await response.json().catch(() => null)) as
    | { ok?: boolean; file?: PremiumFile; message?: string }
    | null;
  if (!response.ok || !parsed?.file) {
    throw new Error(parsed?.message ?? `Upload failed (${response.status})`);
  }
  return parsed.file;
}

export async function deletePremiumZip(name: string): Promise<void> {
  await request(`/api/plugins/premium/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

// --- starter templates --------------------------------------------------

export type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  industry: string;
  pageCount: number;
  sectionCount: number;
  colors: { primary: string; secondary: string; text: string; accent: string };
};

export type SiteTemplate = {
  id: string;
  name: string;
  brand: {
    colors: TemplateSummary["colors"];
    fonts: { heading: string; body: string };
  };
  theme: string;
  plugins: { free: string[] };
  menu: { name: string; location: string };
  pages: Array<{
    title: string;
    slug: string;
    isFrontPage: boolean;
    sections: Array<{ block: string; content: Record<string, string> }>;
  }>;
};

export async function fetchTemplates(): Promise<TemplateSummary[]> {
  const data = await request<{ templates: TemplateSummary[] }>("/api/templates");
  return data.templates;
}

export async function fetchTemplate(id: string): Promise<SiteTemplate> {
  const data = await request<{ template: SiteTemplate }>(
    `/api/templates/${encodeURIComponent(id)}`,
  );
  return data.template;
}
