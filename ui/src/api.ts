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
