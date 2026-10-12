import { useEffect, useState } from "react";
import { fetchTemplate, fetchTemplates, type TemplateSummary } from "../api.ts";
import type { BriefDraft } from "../types.ts";
import { uid } from "../types.ts";

/**
 * Applies a template over a draft, keeping everything only the user can know —
 * business name, address, admin details — and replacing the design and content.
 */
async function applyTemplate(id: string, draft: BriefDraft): Promise<BriefDraft> {
  const template = await fetchTemplate(id);
  return {
    ...draft,
    site: draft.site, // never overwritten
    brand: template.brand,
    theme: template.theme,
    plugins: { free: template.plugins.free, premium: draft.plugins.premium },
    menu: template.menu,
    pages: template.pages.map((page) => ({
      uid: uid(),
      title: page.title,
      slug: page.slug,
      isFrontPage: page.isFrontPage,
      sections: page.sections.map((section) => ({
        uid: uid(),
        block: section.block,
        content: { ...section.content },
      })),
    })),
  };
}

function Swatches({ colors }: { colors: TemplateSummary["colors"] }) {
  return (
    <span className="flex gap-1" aria-hidden="true">
      {[colors.primary, colors.secondary, colors.accent, colors.text].map((color) => (
        <span
          key={color}
          style={{ background: color }}
          className="size-4 rounded-full ring-1 ring-black/10"
        />
      ))}
    </span>
  );
}

export default function TemplatePicker({
  draft,
  disabled,
  onApply,
}: {
  draft: BriefDraft;
  disabled: boolean;
  onApply: (next: BriefDraft) => void;
}) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTemplates()
      .then(setTemplates)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  const hasWork = draft.pages.some((page) => page.sections.length > 0);

  const apply = async (template: TemplateSummary) => {
    setApplying(template.id);
    setConfirming(null);
    setError(null);
    try {
      onApply(await applyTemplate(template.id, draft));
      setApplied(template.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setApplying(null);
    }
  };

  // Ask inline rather than with window.confirm: a native modal blocks the page
  // and reads as an error rather than a choice.
  const choose = (template: TemplateSummary) => {
    if (hasWork && applied !== template.id) {
      setConfirming(template.id);
      return;
    }
    void apply(template);
  };

  if (templates.length === 0 && !error) return null;

  return (
    <section className="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-slate-200">
      <h2 className="font-semibold">Start from a template</h2>
      <p className="mt-1 text-sm text-slate-600">
        Fills in pages, sections, wording and colours. Everything stays editable, and your
        business details are never overwritten.
      </p>

      {error ? (
        <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          {error}
        </p>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {templates.map((template) => (
          <div
            key={template.id}
            className={`rounded-lg border p-3 transition-colors ${
              applied === template.id
                ? "border-slate-900 bg-slate-50"
                : "border-slate-200"
            }`}
          >
            <button
              type="button"
              disabled={disabled || applying !== null}
              onClick={() => choose(template)}
              className="w-full text-left disabled:opacity-60"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{template.name}</span>
                <Swatches colors={template.colors} />
              </span>
              <span className="mt-1 block text-xs text-slate-600">
                {template.description}
              </span>
              <span className="mt-1.5 block text-[11px] text-slate-500">
                {template.industry} · {template.pageCount} pages ·{" "}
                {template.sectionCount} sections
                {applying === template.id ? " · applying…" : ""}
                {applied === template.id && applying === null ? " · applied" : ""}
              </span>
            </button>

            {confirming === template.id ? (
              <div className="mt-2 rounded-md bg-amber-50 px-2.5 py-2 ring-1 ring-amber-200">
                <p className="text-[11px] text-amber-900">
                  This replaces your current pages and sections. Business details are
                  kept.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void apply(template)}
                    className="rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-white"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
