import { useCallback, useEffect, useState } from "react";
import { fetchFolders, type FolderListing } from "../api.ts";

/**
 * Browse htdocs and pick (or name) the folder the clone installs into.
 *
 * The browser cannot supply an absolute path on its own — a directory input
 * only exposes the files inside a folder, and an empty folder exposes nothing,
 * which is the case that matters here. The server lists htdocs instead and
 * this walks that listing.
 *
 * Creating a new folder is the primary action, because the clone needs an
 * empty target: existing folders are shown mainly so the user can see what is
 * already taken.
 */
export default function FolderPicker(props: {
  onChoose: (absolutePath: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (relative: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await fetchFolders(relative));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const separator = listing?.base.includes("/") ? "/" : "\\";
  const trimmed = newName.trim().replace(/[\\/]+/g, "");
  const newPath = listing && trimmed ? `${listing.current}${separator}${trimmed}` : "";

  return (
    <div className="mt-2 rounded-lg bg-white ring-1 ring-slate-300">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div className="min-w-0 text-xs text-slate-600">
          <button
            type="button"
            onClick={() => void load("")}
            className="font-medium text-slate-800 underline decoration-slate-300 hover:decoration-slate-600"
          >
            htdocs
          </button>
          {listing?.relative
            ? listing.relative.split("/").map((part, index, parts) => (
                <span key={`${part}-${index}`}>
                  <span className="mx-1 text-slate-400">/</span>
                  <button
                    type="button"
                    onClick={() => void load(parts.slice(0, index + 1).join("/"))}
                    className="underline decoration-slate-300 hover:decoration-slate-600"
                  >
                    {part}
                  </button>
                </span>
              ))
            : null}
        </div>
        <button
          type="button"
          onClick={props.onClose}
          className="shrink-0 text-xs text-slate-500 underline hover:text-slate-800"
        >
          Close
        </button>
      </div>

      {/* Create a new folder — the usual case, since the clone needs an empty one. */}
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-3">
        <label className="block text-xs font-medium text-slate-700">
          New folder name
        </label>
        <div className="mt-1 flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="my-clone"
            className="min-w-0 flex-1 rounded-md border-0 px-2 py-1.5 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-slate-900"
          />
          <button
            type="button"
            disabled={!newPath}
            onClick={() => {
              props.onChoose(newPath);
              props.onClose();
            }}
            className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Use this
          </button>
        </div>
        {newPath ? (
          <p className="mt-1 truncate text-xs text-slate-500">
            Will create <code>{newPath}</code>
          </p>
        ) : null}
      </div>

      <div className="max-h-56 overflow-y-auto">
        {loading ? (
          <p className="px-3 py-3 text-xs text-slate-500">Loading…</p>
        ) : error ? (
          <p className="px-3 py-3 text-xs text-rose-700">{error}</p>
        ) : listing && listing.entries.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {listing.entries.map((entry) => (
              <li key={entry.path} className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => void load(entry.relative)}
                  className="min-w-0 flex-1 text-left"
                  title="Open this folder"
                >
                  <span className="block truncate text-sm text-slate-900">
                    {entry.name}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {entry.hasWordPress
                      ? "already a WordPress site"
                      : entry.isEmpty
                        ? "empty"
                        : `${entry.childFolders} subfolder${entry.childFolders === 1 ? "" : "s"}`}
                  </span>
                </button>
                {entry.isEmpty && !entry.hasWordPress ? (
                  <button
                    type="button"
                    onClick={() => {
                      props.onChoose(entry.path);
                      props.onClose();
                    }}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
                  >
                    Use
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-slate-400">in use</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-3 text-xs text-slate-500">No folders here.</p>
        )}
      </div>
    </div>
  );
}
