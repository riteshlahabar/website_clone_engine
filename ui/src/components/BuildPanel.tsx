import { useEffect, useRef } from "react";
import type { JobStatus, LogEntry, LogLevel } from "../api.ts";
import type { BuildResult } from "../types.ts";

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: "text-slate-600",
  step: "text-slate-900 font-medium",
  command: "text-indigo-700",
  success: "text-emerald-700 font-medium",
  warn: "text-amber-700",
  error: "text-rose-700 font-medium",
};

function ResultPanel({ result }: { result: BuildResult }) {
  return (
    <div className="border-t border-slate-200 bg-emerald-50/50 px-4 py-4">
      <h3 className="font-semibold text-emerald-900">Your site is ready</h3>

      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={result.siteUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Open site
        </a>
        <a
          href={result.adminUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-white"
        >
          WordPress admin
        </a>
      </div>

      <table className="mt-4 w-full text-sm">
        <tbody>
          <tr className="border-t border-emerald-200/70">
            <td className="py-1.5 pr-4 text-slate-500">Admin login</td>
            <td className="py-1.5 font-mono text-xs">
              {result.adminUser} / {result.adminPassword}
            </td>
          </tr>
          <tr className="border-t border-emerald-200/70">
            <td className="py-1.5 pr-4 text-slate-500">Files</td>
            <td className="py-1.5 font-mono text-xs">{result.sitePath}</td>
          </tr>
          <tr className="border-t border-emerald-200/70">
            <td className="py-1.5 pr-4 text-slate-500">Brief saved</td>
            <td className="py-1.5 font-mono text-xs">{result.briefPath}</td>
          </tr>
        </tbody>
      </table>

      <h4 className="mt-4 text-sm font-medium">Pages</h4>
      <ul className="mt-1 space-y-1">
        {result.pages.map((page) => {
          const check = result.verification?.checks.find(
            (item) => item.url === page.url,
          );
          return (
            <li key={page.postId} className="flex flex-wrap items-center gap-2 text-sm">
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-slate-900 underline decoration-slate-300 hover:decoration-slate-900"
              >
                {page.title}
              </a>
              {page.isFrontPage ? (
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">
                  front page
                </span>
              ) : null}
              {check ? (
                <span
                  title={check.note ?? check.phpNotices[0] ?? ""}
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    check.ok
                      ? "bg-slate-100 text-slate-700"
                      : "bg-amber-100 text-amber-900"
                  }`}
                >
                  {check.ok
                    ? `✓ ${check.widgetCount} widgets`
                    : (check.note ?? `HTTP ${check.status}`)}
                </span>
              ) : null}
              <a
                href={page.editUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-700 hover:underline"
              >
                edit in Elementor →
              </a>
            </li>
          );
        })}
      </ul>

      {result.verification && !result.verification.ok ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
          The site was built, but some pages did not verify cleanly. Check the flagged
          pages above — the full log is in the panel.
        </p>
      ) : null}
    </div>
  );
}

export default function BuildPanel({
  status,
  log,
  result,
  error,
  onDismiss,
}: {
  status: JobStatus | null;
  log: LogEntry[];
  result: BuildResult | null;
  error: string | null;
  onDismiss: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the tail as new lines stream in.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log.length]);

  if (!status) return null;

  return (
    <section className="rounded-xl bg-panel shadow-sm ring-1 ring-slate-200">
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">
            {status === "running"
              ? "Building…"
              : status === "done"
                ? "Build finished"
                : "Build failed"}
          </h2>
          {status === "running" ? (
            <span className="size-2 animate-pulse rounded-full bg-indigo-500" />
          ) : null}
        </div>
        {status !== "running" ? (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            Close
          </button>
        ) : null}
      </header>

      <div
        ref={scroller}
        className="max-h-80 overflow-y-auto border-t border-slate-100 bg-slate-50 px-4 py-3 font-mono text-xs leading-relaxed"
      >
        {log.map((entry, index) => (
          <div key={index} className={LEVEL_STYLE[entry.level]}>
            {entry.level === "command" ? "$ " : ""}
            {entry.message}
          </div>
        ))}
        {log.length === 0 ? <div className="text-slate-500">Starting…</div> : null}
      </div>

      {error ? (
        <p className="border-t border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      {result ? <ResultPanel result={result} /> : null}
    </section>
  );
}
