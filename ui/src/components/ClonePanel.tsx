import { useCallback, useEffect, useMemo, useState } from "react";
import {
  checkCloneTarget,
  startClone,
  startDiscover,
  streamJob,
  type JobStatus,
  type LogEntry,
} from "../api.ts";
import FolderPicker from "./FolderPicker.tsx";
import {
  emptyCloneDraft,
  normalizeCloneDraft,
  toClonePayload,
  type CloneDraft,
  type CloneResult,
  type DiscoveredPage,
} from "../types.ts";

const DRAFT_KEY = "wp-site-builder:clone-draft";

const LEVEL_COLOR: Record<LogEntry["level"], string> = {
  info: "text-slate-600",
  step: "font-medium text-slate-900",
  success: "text-emerald-700",
  warn: "text-amber-700",
  error: "text-rose-700",
  command: "text-sky-700",
};

function loadDraft(): CloneDraft {
  try {
    const stored = localStorage.getItem(DRAFT_KEY);
    if (stored) return normalizeCloneDraft(JSON.parse(stored));
  } catch {
    // Private windows and blocked storage both land here; defaults are fine.
  }
  return emptyCloneDraft();
}

/** One labelled input, so the form markup stays readable. */
function Field(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-800">{props.label}</span>
      {props.children}
      {props.hint ? (
        <span className="mt-1 block text-xs text-slate-500">{props.hint}</span>
      ) : null}
    </label>
  );
}

const INPUT_CLASS =
  "mt-1 w-full rounded-md border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:ring-2 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-500";

export default function ClonePanel({ ready }: { ready: boolean }) {
  const [draft, setDraft] = useState<CloneDraft>(loadDraft);
  const [advanced, setAdvanced] = useState(false);
  const [picking, setPicking] = useState(false);

  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [discovered, setDiscovered] = useState<DiscoveredPage[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [status, setStatus] = useState<JobStatus | null>(null);
  const [phase, setPhase] = useState<"discover" | "clone" | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Not worth interrupting the user over.
    }
  }, [draft]);

  const busy = status === "running";
  const set = useCallback(
    <K extends keyof CloneDraft>(key: K, value: CloneDraft[K]) => {
      setDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const reset = useCallback(() => {
    setErrors([]);
    setNotice(null);
    setFailure(null);
    setResult(null);
    setLog([]);
  }, []);

  /** Follow a job, routing its events into local state. */
  const follow = useCallback(
    (jobId: string, kind: "discover" | "clone") => {
      setPhase(kind);
      setStatus("running");
      streamJob(jobId, (event) => {
        if (event.type === "log") {
          setLog((current) => [...current, event.entry]);
          return;
        }
        setStatus(event.status);
        if (event.status === "error") {
          setFailure(event.error ?? `${kind === "clone" ? "Clone" : "Discovery"} failed.`);
          return;
        }
        if (kind === "discover") {
          const pages = (event.result as { pages?: DiscoveredPage[] } | null)?.pages ?? [];
          setDiscovered(pages);
          setSelected(new Set(pages.map((page) => page.url)));
          setNotice(
            `Found ${pages.length} page(s). Untick anything you do not want, then Clone.`,
          );
        } else {
          setResult(event.result as CloneResult);
        }
      });
    },
    [],
  );

  const check = useCallback(async () => {
    reset();
    const response = await checkCloneTarget(toClonePayload(draft));
    if (!response.ok) {
      setErrors(response.errors);
      return;
    }
    setNotice(`Looks good — the clone will be served at ${response.siteUrl}`);
  }, [draft, reset]);

  const discover = useCallback(async () => {
    reset();
    setDiscovered(null);
    const response = await startDiscover(toClonePayload(draft));
    if (!response.ok) {
      setErrors(response.errors);
      return;
    }
    follow(response.jobId, "discover");
  }, [draft, follow, reset]);

  const clone = useCallback(async () => {
    reset();
    const pages = (discovered ?? []).filter((page) => selected.has(page.url));
    // Keep exactly one front page: the first still-selected page takes the role
    // if the original front page was unticked.
    const withFront = pages.map((page, index) => ({
      ...page,
      isFrontPage: pages.some((entry) => entry.isFrontPage)
        ? page.isFrontPage
        : index === 0,
    }));
    const response = await startClone(toClonePayload(draft, withFront));
    if (!response.ok) {
      setErrors(response.errors);
      return;
    }
    follow(response.jobId, "clone");
  }, [discovered, draft, follow, reset, selected]);

  const toggle = useCallback((url: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const selectedCount = useMemo(
    () => (discovered ?? []).filter((page) => selected.has(page.url)).length,
    [discovered, selected],
  );

  const canClone = Boolean(draft.sourceUrl && draft.targetPath && draft.dbName) && ready;

  return (
    <section className="rounded-xl bg-panel p-5 shadow-sm ring-1 ring-slate-200">
      <header className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Clone a site</h2>
        <p className="mt-1 text-sm text-slate-600">
          Paste a URL, pick an empty folder under <code>htdocs</code>, and name a
          database you created in phpMyAdmin. The pages are rebuilt as Elementor
          documents you can edit.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <Field label="Website URL" hint="The page to start from; its whole site is crawled.">
            <input
              type="url"
              value={draft.sourceUrl}
              onChange={(event) => set("sourceUrl", event.target.value)}
              disabled={busy}
              placeholder="https://example.com"
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field
            label="Project folder"
            hint="Inside C:\xampp\htdocs, and empty or new. Browse to pick or name one."
          >
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={draft.targetPath}
                onChange={(event) => set("targetPath", event.target.value)}
                disabled={busy}
                placeholder="C:\xampp\htdocs\my-clone"
                className={`${INPUT_CLASS} mt-0 min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={() => setPicking((value) => !value)}
                disabled={busy}
                className="shrink-0 rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
              >
                {picking ? "Hide" : "Browse…"}
              </button>
            </div>
          </Field>
          {picking ? (
            <FolderPicker
              onChoose={(absolutePath) => set("targetPath", absolutePath)}
              onClose={() => setPicking(false)}
            />
          ) : null}
        </div>

        <Field label="Database name" hint="Create it empty in phpMyAdmin first.">
          <input
            type="text"
            value={draft.dbName}
            onChange={(event) => set("dbName", event.target.value)}
            disabled={busy}
            placeholder="my_clone"
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      <button
        type="button"
        onClick={() => setAdvanced((value) => !value)}
        className="mt-4 text-sm font-medium text-slate-700 underline decoration-slate-300 hover:decoration-slate-600"
      >
        {advanced ? "Hide" : "Show"} advanced options
      </button>

      {advanced ? (
        <div className="mt-3 grid gap-4 rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200 sm:grid-cols-2">
          <Field label="Database user">
            <input
              type="text"
              value={draft.dbUser}
              onChange={(event) => set("dbUser", event.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Database password" hint="Blank is the XAMPP default.">
            <input
              type="password"
              value={draft.dbPassword}
              onChange={(event) => set("dbPassword", event.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Site title" hint="Defaults to the source page's title.">
            <input
              type="text"
              value={draft.title}
              onChange={(event) => set("title", event.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="WordPress admin email">
            <input
              type="email"
              value={draft.adminEmail}
              onChange={(event) => set("adminEmail", event.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Admin username">
            <input
              type="text"
              value={draft.adminUser}
              onChange={(event) => set("adminUser", event.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Admin password" hint="Blank generates one for you.">
            <input
              type="password"
              value={draft.adminPassword}
              onChange={(event) => set("adminPassword", event.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={`Page limit: ${draft.maxPages}`}>
            <input
              type="range"
              min={1}
              max={60}
              value={draft.maxPages}
              onChange={(event) => set("maxPages", Number(event.target.value))}
              disabled={busy}
              className="mt-2 w-full"
            />
          </Field>
          <Field
            label="Fidelity"
            hint={
              draft.cloneMode === "exact"
                ? "Keeps the source's own markup and stylesheet, so the page renders as it did on the original. Edit it as theme files rather than in the Elementor canvas."
                : draft.cloneMode === "editable"
                  ? "Rebuilds every section as native Elementor widgets. Fully editable, but a page built with a CSS framework will only approximate the original."
                  : "Keeps the markup for sections that would lose too much, and rebuilds the rest as Elementor widgets."
            }
          >
            <select
              value={draft.cloneMode}
              onChange={(event) =>
                set("cloneMode", event.target.value as typeof draft.cloneMode)
              }
              disabled={busy}
              className={INPUT_CLASS}
            >
              <option value="exact">Exact — looks identical</option>
              <option value="auto">Balanced — exact where it matters</option>
              <option value="editable">Editable — native Elementor widgets</option>
            </select>
          </Field>
          {draft.cloneMode === "auto" ? (
            <Field
              label={`Keep native widgets up to ${Math.round(draft.htmlFallbackThreshold * 100)}% loss`}
              hint="Higher keeps more sections as editable widgets; lower favours exact looks."
            >
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(draft.htmlFallbackThreshold * 100)}
                onChange={(event) =>
                  set("htmlFallbackThreshold", Number(event.target.value) / 100)
                }
                disabled={busy}
                className="mt-2 w-full"
              />
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={draft.respectRobots}
              onChange={(event) => set("respectRobots", event.target.checked)}
              disabled={busy}
              className="h-4 w-4 rounded border-slate-300"
            />
            Respect robots.txt
          </label>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy || !draft.targetPath || !draft.dbName}
          className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
        >
          Check folder &amp; database
        </button>
        <button
          type="button"
          onClick={() => void discover()}
          disabled={busy || !draft.sourceUrl}
          className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy && phase === "discover" ? "Discovering…" : "Discover pages"}
        </button>
        <button
          type="button"
          onClick={() => void clone()}
          disabled={busy || !canClone}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy && phase === "clone"
            ? "Cloning…"
            : discovered
              ? `Clone ${selectedCount} page${selectedCount === 1 ? "" : "s"}`
              : "Clone site"}
        </button>
        <button
          type="button"
          onClick={() => setDraft(emptyCloneDraft())}
          disabled={busy}
          className="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Reset
        </button>
        {!ready ? (
          <span className="text-sm text-amber-700">Environment not ready</span>
        ) : null}
      </div>

      {notice ? (
        <p className="mt-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
          {notice}
        </p>
      ) : null}

      {errors.length > 0 ? (
        <ul className="mt-4 space-y-1 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {failure ? (
        <p className="mt-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">
          {failure}
        </p>
      ) : null}

      {/* Discovered pages: a checklist before committing to a run. */}
      {discovered && discovered.length > 0 && !result ? (
        <div className="mt-5 rounded-lg ring-1 ring-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
            <span className="text-sm font-medium text-slate-800">
              {selectedCount} of {discovered.length} selected
            </span>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setSelected(new Set(discovered.map((page) => page.url)))}
                className="text-slate-600 underline hover:text-slate-900"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-slate-600 underline hover:text-slate-900"
              >
                None
              </button>
            </div>
          </div>
          <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto">
            {discovered.map((page) => (
              <li key={page.url} className="flex items-start gap-3 px-4 py-2">
                <input
                  type="checkbox"
                  checked={selected.has(page.url)}
                  onChange={() => toggle(page.url)}
                  disabled={busy}
                  className="mt-1 h-4 w-4 rounded border-slate-300"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-900">
                    {page.title}
                    {page.isFrontPage ? (
                      <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">
                        front page
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-slate-500">{page.url}</span>
                </span>
                <code className="text-xs text-slate-400">/{page.slug}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Live log */}
      {status ? (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                status === "running"
                  ? "animate-pulse bg-sky-500"
                  : status === "done"
                    ? "bg-emerald-500"
                    : "bg-rose-500"
              }`}
            />
            <span className="text-sm font-medium text-slate-800">
              {status === "running"
                ? phase === "clone"
                  ? "Cloning…"
                  : "Discovering…"
                : status === "done"
                  ? "Finished"
                  : "Failed"}
            </span>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-xs leading-relaxed">
            {log.map((entry, index) => (
              <div
                key={`${entry.at}-${index}`}
                className={
                  entry.level === "command"
                    ? "text-sky-300"
                    : entry.level === "success"
                      ? "text-emerald-300"
                      : entry.level === "warn"
                        ? "text-amber-300"
                        : entry.level === "error"
                          ? "text-rose-300"
                          : entry.level === "step"
                            ? "font-semibold text-slate-100"
                            : "text-slate-400"
                }
              >
                {entry.level === "command" ? "$ " : ""}
                {entry.message}
              </div>
            ))}
            {log.length === 0 ? <div className="text-slate-500">Starting…</div> : null}
          </div>
        </div>
      ) : null}

      {/* Result */}
      {result ? (
        <div className="mt-5 space-y-4">
          <div className="rounded-lg bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200">
            <p className="text-sm font-medium text-emerald-900">
              Clone ready at{" "}
              <a href={result.siteUrl} target="_blank" rel="noreferrer" className="underline">
                {result.siteUrl}
              </a>
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-emerald-900 sm:grid-cols-4">
              <div>
                <dt className="text-emerald-700">Admin</dt>
                <dd>
                  {result.adminUser} / <code>{result.adminPassword}</code>
                </dd>
              </div>
              <div>
                <dt className="text-emerald-700">Images imported</dt>
                <dd>{result.stats.imagesImported}</dd>
              </div>
              <div>
                <dt className="text-emerald-700">Files localized</dt>
                <dd>{result.stats.assetsLocalized}</dd>
              </div>
              <div>
                <dt className="text-emerald-700">Cloned CSS</dt>
                <dd>{(result.stats.cssBytes / 1024).toFixed(0)} KB</dd>
              </div>
              <div>
                <dt className="text-emerald-700">Header / footer</dt>
                <dd>
                  {result.stats.hasHeader ? "cloned" : "not found"} /{" "}
                  {result.stats.hasFooter ? "cloned" : "not found"}
                </dd>
              </div>
              <div>
                <dt className="text-emerald-700">Menu items</dt>
                <dd>{result.stats.menuItems}</dd>
              </div>
              <div>
                <dt className="text-emerald-700">Theme</dt>
                <dd>
                  <code>{result.themeSlug}</code>
                </dd>
              </div>
              <div>
                <dt className="text-emerald-700">Database</dt>
                <dd>
                  <code>{result.dbName}</code>
                </dd>
              </div>
            </dl>
          </div>

          <div className="overflow-hidden rounded-lg ring-1 ring-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Page</th>
                  <th className="px-4 py-2 font-medium">Sections</th>
                  <th className="px-4 py-2 font-medium">Looks like the source</th>
                  <th className="px-4 py-2 font-medium">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.pages.map((page) => {
                  const native = page.decisions.filter((d) => d.mode === "native").length;
                  const html = page.decisions.length - native;
                  return (
                    <tr key={page.postId}>
                      <td className="px-4 py-2">
                        <span className="block text-slate-900">{page.title}</span>
                        <span className="block text-xs text-slate-500">/{page.slug}</span>
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600">
                        <span className="text-emerald-700">{native} native</span>
                        {html > 0 ? (
                          <>
                            {" · "}
                            <span className="text-amber-700">{html} as markup</span>
                          </>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-xs" title={page.visualSummary ?? ""}>
                        {page.visual ? (
                          <>
                            <span
                              className={
                                // Height is the tell for collapsed layout, and
                                // it is worth flagging on its own: a page can
                                // match colour for colour and still be wrong.
                                page.visual.heightRatio < 0.8 || page.visual.heightRatio > 1.25
                                  ? "text-rose-700"
                                  : "text-emerald-700"
                              }
                            >
                              {page.visual.heightRatio.toFixed(2)}× height
                            </span>
                            {" · "}
                            <span className="text-slate-600">
                              {(page.visual.difference * 100).toFixed(0)}% pixels differ
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-400">not checked</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-700 underline hover:text-slate-900"
                        >
                          View
                        </a>
                        {" · "}
                        <a
                          href={page.editUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-700 underline hover:text-slate-900"
                        >
                          Elementor
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
