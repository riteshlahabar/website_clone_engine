/**
 * In-memory job registry with a replayable log.
 *
 * A build is long-running, so the browser subscribes over SSE. Subscribers that
 * connect late (or reconnect) get the full backlog first, so the log in the page
 * always matches what actually happened.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "./env.ts";

export type JobStatus = "running" | "done" | "error";
export type LogLevel = "info" | "step" | "success" | "warn" | "error" | "command";

export type LogEntry = {
  at: string;
  level: LogLevel;
  message: string;
};

export type Job = {
  id: string;
  kind: string;
  status: JobStatus;
  log: LogEntry[];
  startedAt: string;
  finishedAt?: string;
  /** Structured outcome for the result panel (site URL, page edit links, …). */
  result?: unknown;
  error?: string;
};

type Subscriber = (event: JobEvent) => void;

export type JobEvent =
  | { type: "log"; entry: LogEntry }
  | { type: "status"; status: JobStatus; error?: string; result?: unknown };

const jobs = new Map<string, Job>();
const subscribers = new Map<string, Set<Subscriber>>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function subscribe(id: string, subscriber: Subscriber): () => void {
  const set = subscribers.get(id) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(id, set);
  return () => {
    set.delete(subscriber);
    if (set.size === 0) subscribers.delete(id);
  };
}

function emit(id: string, event: JobEvent): void {
  for (const subscriber of subscribers.get(id) ?? []) {
    try {
      subscriber(event);
    } catch {
      // A dead SSE connection must never break the build.
    }
  }
}

/** Handle handed to a job's worker so it can report progress. */
export type JobLogger = {
  jobId: string;
  log: (message: string, level?: LogLevel) => void;
  step: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
  command: (message: string) => void;
};

/**
 * Register a job and run `worker` in the background. Returns immediately with
 * the job id so the HTTP request does not wait for the build.
 */
export function startJob(
  kind: string,
  worker: (logger: JobLogger) => Promise<unknown>,
): Job {
  const id = randomUUID();
  const job: Job = {
    id,
    kind,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  const logFile = path.join(PATHS.jobs, `${id}.log`);
  const write = (message: string, level: LogLevel = "info") => {
    const entry: LogEntry = { at: new Date().toISOString(), level, message };
    job.log.push(entry);
    emit(id, { type: "log", entry });
    // Best-effort disk copy so a finished build is still readable after restart.
    void mkdir(PATHS.jobs, { recursive: true })
      .then(() => appendFile(logFile, `[${entry.at}] ${level}: ${message}\n`))
      .catch(() => {});
  };

  const logger: JobLogger = {
    jobId: id,
    log: write,
    step: (message) => write(message, "step"),
    success: (message) => write(message, "success"),
    warn: (message) => write(message, "warn"),
    command: (message) => write(message, "command"),
  };

  void (async () => {
    try {
      const result = await worker(logger);
      job.status = "done";
      job.result = result;
      job.finishedAt = new Date().toISOString();
      emit(id, { type: "status", status: "done", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = "error";
      job.error = message;
      job.finishedAt = new Date().toISOString();
      write(message, "error");
      emit(id, { type: "status", status: "error", error: message });
    }
  })();

  return job;
}
