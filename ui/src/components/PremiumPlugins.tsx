import { useCallback, useEffect, useRef, useState } from "react";
import type { PremiumFile } from "../api.ts";
import { deletePremiumZip, fetchPremiumZips, uploadPremiumZip } from "../api.ts";

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function PremiumPlugins({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const [files, setFiles] = useState<PremiumFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await fetchPremiumZips());
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await uploadPremiumZip(file);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      await deletePremiumZip(name);
      onChange(selected.filter((item) => item !== name));
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) =>
    onChange(
      selected.includes(name)
        ? selected.filter((item) => item !== name)
        : [...selected, name],
    );

  return (
    <div className="mt-3 rounded-md bg-amber-50 px-3 py-3 ring-1 ring-amber-200">
      <p className="text-xs text-amber-900">
        Elementor Pro and other paid plugins are not on wordpress.org, so they cannot be
        downloaded automatically. Upload the <code>.zip</code> here and tick it to install.
      </p>

      {files.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {files.map((file) => (
            <li
              key={file.name}
              className="flex items-center gap-2 rounded bg-white px-2.5 py-1.5 text-sm ring-1 ring-amber-200"
            >
              <input
                type="checkbox"
                id={`premium-${file.name}`}
                checked={selected.includes(file.name)}
                disabled={disabled || busy}
                onChange={() => toggle(file.name)}
                className="size-4 accent-slate-900"
              />
              <label htmlFor={`premium-${file.name}`} className="min-w-0 flex-1 truncate">
                {file.name}
              </label>
              <span className="shrink-0 text-xs text-slate-500">
                {formatSize(file.size)}
              </span>
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => void remove(file.name)}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".zip"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
          className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-slate-700"
        />
        {busy ? <span className="shrink-0 text-xs text-slate-600">Working…</span> : null}
      </div>

      {error ? <p className="mt-2 text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}
