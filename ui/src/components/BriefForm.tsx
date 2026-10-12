import type { BlockMeta, BriefDraft, PageDraft } from "../types.ts";
import { slugify, uid } from "../types.ts";
import PremiumPlugins from "./PremiumPlugins.tsx";
import SectionList from "./SectionList.tsx";

const FIELD =
  "w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-900 focus:outline-none";

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={className}>
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <span className="flex items-center gap-2">
        <input
          type="color"
          className="size-8 shrink-0 cursor-pointer rounded border border-slate-300"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className={FIELD}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </Field>
  );
}

function PageCard({
  page,
  blocks,
  canRemove,
  onChange,
  onRemove,
  onMakeFrontPage,
}: {
  page: PageDraft;
  blocks: BlockMeta[];
  canRemove: boolean;
  onChange: (next: PageDraft) => void;
  onRemove: () => void;
  onMakeFrontPage: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Page title">
          <input
            className={FIELD}
            value={page.title}
            onChange={(event) => {
              const title = event.target.value;
              // Keep the slug in step until the user edits it themselves.
              const autoSlug = slugify(page.title) === page.slug;
              onChange({
                ...page,
                title,
                slug: autoSlug ? slugify(title) : page.slug,
              });
            }}
          />
        </Field>
        <Field label="URL slug">
          <input
            className={FIELD}
            value={page.slug}
            onChange={(event) => onChange({ ...page, slug: slugify(event.target.value) })}
          />
        </Field>
        <div className="flex items-center gap-2 pb-1">
          <button
            type="button"
            onClick={onMakeFrontPage}
            disabled={page.isFrontPage}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 ${
              page.isFrontPage
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "text-slate-700 ring-slate-300 hover:bg-slate-50"
            }`}
          >
            {page.isFrontPage ? "Front page" : "Make front page"}
          </button>
          {canRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3">
        <SectionList
          sections={page.sections}
          blocks={blocks}
          onChange={(sections) => onChange({ ...page, sections })}
        />
      </div>
    </div>
  );
}

export default function BriefForm({
  draft,
  blocks,
  disabled,
  onChange,
}: {
  draft: BriefDraft;
  blocks: BlockMeta[];
  disabled: boolean;
  onChange: (next: BriefDraft) => void;
}) {
  const setSite = (patch: Partial<BriefDraft["site"]>) =>
    onChange({ ...draft, site: { ...draft.site, ...patch } });

  const setColor = (key: keyof BriefDraft["brand"]["colors"], value: string) =>
    onChange({
      ...draft,
      brand: { ...draft.brand, colors: { ...draft.brand.colors, [key]: value } },
    });

  const setPage = (index: number, next: PageDraft) => {
    const pages = [...draft.pages];
    pages[index] = next;
    onChange({ ...draft, pages });
  };

  return (
    <fieldset disabled={disabled} className="space-y-6 disabled:opacity-60">
      <section className="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-3 font-semibold">The site</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Business name">
            <input
              className={FIELD}
              value={draft.site.name}
              placeholder="Bright Smile Dental"
              onChange={(event) => {
                const name = event.target.value;
                const autoSlug = slugify(draft.site.name) === draft.site.slug;
                setSite({ name, slug: autoSlug ? slugify(name) : draft.site.slug });
              }}
            />
          </Field>
          <Field
            label="Folder / address"
            hint={
              draft.site.slug
                ? `Will be built at http://localhost/${draft.site.slug}`
                : "Lowercase letters, numbers and dashes."
            }
          >
            <input
              className={FIELD}
              value={draft.site.slug}
              placeholder="brightsmile"
              onChange={(event) => setSite({ slug: slugify(event.target.value) })}
            />
          </Field>
          <Field label="Tagline" className="sm:col-span-2">
            <input
              className={FIELD}
              value={draft.site.tagline}
              placeholder="Gentle dentistry in Pune"
              onChange={(event) => setSite({ tagline: event.target.value })}
            />
          </Field>
          <Field label="Admin username">
            <input
              className={FIELD}
              value={draft.site.adminUser}
              onChange={(event) => setSite({ adminUser: event.target.value })}
            />
          </Field>
          <Field label="Admin email">
            <input
              className={FIELD}
              type="email"
              value={draft.site.adminEmail}
              placeholder="you@example.com"
              onChange={(event) => setSite({ adminEmail: event.target.value })}
            />
          </Field>
          <Field
            label="Logo image URL"
            hint="Optional. Imported into the media library and set as the site logo."
            className="sm:col-span-2"
          >
            <input
              className={FIELD}
              value={draft.site.logoUrl}
              placeholder="https://example.com/logo.png"
              onChange={(event) => setSite({ logoUrl: event.target.value })}
            />
          </Field>
          <Field
            label="Admin password"
            hint="Leave empty and one is generated for you, shown when the build finishes."
            className="sm:col-span-2"
          >
            <input
              className={FIELD}
              value={draft.site.adminPassword}
              placeholder="Generated automatically"
              onChange={(event) => setSite({ adminPassword: event.target.value })}
            />
          </Field>
        </div>
      </section>

      <section className="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-1 font-semibold">Brand</h2>
        <p className="mb-3 text-sm text-slate-600">
          These colours flow into every section that doesn't override them.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          <ColorField
            label="Primary"
            value={draft.brand.colors.primary}
            onChange={(value) => setColor("primary", value)}
          />
          <ColorField
            label="Secondary"
            value={draft.brand.colors.secondary}
            onChange={(value) => setColor("secondary", value)}
          />
          <ColorField
            label="Accent"
            value={draft.brand.colors.accent}
            onChange={(value) => setColor("accent", value)}
          />
          <ColorField
            label="Text"
            value={draft.brand.colors.text}
            onChange={(value) => setColor("text", value)}
          />
        </div>
      </section>

      <section className="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-3 font-semibold">Theme and plugins</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Theme" hint="Any slug from wordpress.org.">
            <input
              className={FIELD}
              value={draft.theme}
              onChange={(event) => onChange({ ...draft, theme: event.target.value })}
            />
          </Field>
          <Field
            label="Plugins"
            hint="Comma-separated wordpress.org slugs. Elementor is required."
          >
            <input
              className={FIELD}
              value={draft.plugins.free.join(", ")}
              onChange={(event) =>
                onChange({
                  ...draft,
                  plugins: {
                    ...draft.plugins,
                    free: event.target.value
                      .split(",")
                      .map((slug) => slug.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Field>
        </div>
        <PremiumPlugins
          selected={draft.plugins.premium}
          disabled={disabled}
          onChange={(premium) =>
            onChange({ ...draft, plugins: { ...draft.plugins, premium } })
          }
        />
      </section>

      <section className="rounded-xl bg-panel p-4 shadow-sm ring-1 ring-slate-200">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Pages</h2>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...draft,
                pages: [
                  ...draft.pages,
                  {
                    uid: uid(),
                    title: "New page",
                    slug: `page-${draft.pages.length + 1}`,
                    isFrontPage: false,
                    sections: [],
                  },
                ],
              })
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            + Add page
          </button>
        </div>
        <div className="space-y-3">
          {draft.pages.map((page, index) => (
            <PageCard
              key={page.uid}
              page={page}
              blocks={blocks}
              canRemove={draft.pages.length > 1}
              onChange={(next) => setPage(index, next)}
              onRemove={() =>
                onChange({
                  ...draft,
                  pages: draft.pages.filter((item) => item.uid !== page.uid),
                })
              }
              onMakeFrontPage={() =>
                onChange({
                  ...draft,
                  pages: draft.pages.map((item) => ({
                    ...item,
                    isFrontPage: item.uid === page.uid,
                  })),
                })
              }
            />
          ))}
        </div>
      </section>
    </fieldset>
  );
}
