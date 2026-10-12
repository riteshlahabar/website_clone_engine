import { useCallback, useEffect, useState } from "react";
import { api, type Check, type CheckStatus, type DoctorReport } from "../api.ts";

const DOT: Record<CheckStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-rose-500",
};

const BADGE: Record<CheckStatus, string> = {
  ok: "text-emerald-700 bg-emerald-50 ring-emerald-200",
  warn: "text-amber-700 bg-amber-50 ring-amber-200",
  fail: "text-rose-700 bg-rose-50 ring-rose-200",
};

function CheckRow({
  check,
  busy,
  onFix,
}: {
  check: Check;
  busy: boolean;
  onFix: (action: string) => void;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 border-t border-slate-100 first:border-t-0">
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${DOT[check.status]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{check.label}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ring-1 ring-inset ${
              BADGE[check.status]
            }`}
          >
            {check.status}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-slate-600 break-words">{check.detail}</p>
      </div>
      {check.fixAction ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onFix(check.fixAction!)}
          className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Working…" : check.fixLabel}
        </button>
      ) : null}
    </li>
  );
}

export default function Doctor({
  onReadyChange,
}: {
  onReadyChange?: (ready: boolean) => void;
}) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const next = await api.doctor();
      setReport(next);
      onReadyChange?.(next.ready);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [onReadyChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fix = async (action: string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.fix(action);
      setReport(result.report);
      onReadyChange?.(result.report.ready);
      setNotice(result.message);
    } catch (cause) {
      setError((cause as Error).message);
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-panel shadow-sm ring-1 ring-slate-200">
      <header className="flex items-center justify-between px-4 py-3">
        <div>
          <h2 className="font-semibold">Environment</h2>
          <p className="text-sm text-slate-500">
            {report
              ? report.ready
                ? "Everything needed to build is in place."
                : "Fix the red items before building."
              : "Checking…"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
        >
          Re-check
        </button>
      </header>

      {notice ? (
        <p className="mx-4 mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="mx-4 mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {error}
        </p>
      ) : null}

      <ul className="border-t border-slate-100">
        {report?.checks.map((check) => (
          <CheckRow key={check.id} check={check} busy={busy} onFix={fix} />
        )) ?? <li className="px-4 py-6 text-sm text-slate-500">Running checks…</li>}
      </ul>
    </section>
  );
}
