import { useCallback, useEffect, useState } from "react";
import {
  fetchBlocks,
  startBuild,
  streamJob,
  type JobStatus,
  type LogEntry,
} from "./api.ts";
import BriefForm from "./components/BriefForm.tsx";
import BuildPanel from "./components/BuildPanel.tsx";
import Doctor from "./components/Doctor.tsx";
import {
  emptyBrief,
  toPayload,
  type BlockMeta,
  type BriefDraft,
  type BuildResult,
} from "./types.ts";

const DRAFT_KEY = "wp-site-builder:draft";

/** Keep the in-progress brief across reloads; a long form is tedious to retype. */
function loadDraft(): BriefDraft {
  try {
    const stored = localStorage.getItem(DRAFT_KEY);
    if (stored) return JSON.parse(stored) as BriefDraft;
  } catch {
    // Private windows and blocked storage both land here; the default is fine.
  }
  return emptyBrief();
}

export default function App() {
  const [draft, setDraft] = useState<BriefDraft>(loadDraft);
  const [blocks, setBlocks] = useState<BlockMeta[]>([]);
  const [ready, setReady] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const [status, setStatus] = useState<JobStatus | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    fetchBlocks()
      .then(setBlocks)
      .catch((cause: Error) => setErrors([cause.message]));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Not being able to persist the draft is not worth interrupting the user.
    }
  }, [draft]);

  const build = useCallback(async () => {
    setErrors([]);
    setFailure(null);
    setResult(null);
    setLog([]);

    const response = await startBuild(toPayload(draft));
    if (!response.ok) {
      setErrors(response.errors);
      return;
    }

    setStatus("running");
    streamJob(response.jobId, (event) => {
      if (event.type === "log") {
        setLog((current) => [...current, event.entry]);
        return;
      }
      setStatus(event.status);
      if (event.status === "done") setResult(event.result as BuildResult);
      if (event.status === "error") setFailure(event.error ?? "Build failed.");
    });
  }, [draft]);

  const busy = status === "running";
  const sectionCount = draft.pages.reduce(
    (total, page) => total + page.sections.length,
    0,
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">WP Site Builder</h1>
        <p className="mt-1 text-slate-600">
          Describe a site below and it is built in WordPress with Elementor pages, a
          theme and plugins — no wp-admin clicking.
        </p>
      </header>

      <div className="space-y-6">
        <Doctor onReadyChange={setReady} />

        <BuildPanel
          status={status}
          log={log}
          result={result}
          error={failure}
          onDismiss={() => setStatus(null)}
        />

        <BriefForm
          draft={draft}
          blocks={blocks}
          disabled={busy}
          onChange={setDraft}
        />

        {errors.length > 0 ? (
          <ul className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}

        <div className="sticky bottom-4 flex items-center justify-between rounded-xl bg-panel px-4 py-3 shadow-lg ring-1 ring-slate-200">
          <p className="text-sm text-slate-600">
            {draft.pages.length} page{draft.pages.length === 1 ? "" : "s"},{" "}
            {sectionCount} section{sectionCount === 1 ? "" : "s"}
            {!ready ? " — environment not ready" : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDraft(emptyBrief())}
              disabled={busy}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => void build()}
              disabled={busy || !ready}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {busy ? "Building…" : "Build site"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
