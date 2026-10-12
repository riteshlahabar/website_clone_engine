/** Shapes mirrored from server/shared/brief.ts and the block registry. */

export type BlockParam = {
  key: string;
  label: string;
  type: "text" | "textarea" | "color" | "image";
  default: string;
  brand?: "primary" | "secondary" | "accent" | "text" | "surface";
};

export type BlockMeta = {
  id: string;
  name: string;
  description: string;
  params: BlockParam[];
};

export type Section = {
  /** Client-side only, for stable list keys and drag reordering. */
  uid: string;
  block: string;
  content: Record<string, string>;
};

export type PageDraft = {
  uid: string;
  title: string;
  slug: string;
  isFrontPage: boolean;
  sections: Section[];
};

export type BriefDraft = {
  site: {
    name: string;
    slug: string;
    tagline: string;
    adminUser: string;
    adminEmail: string;
    adminPassword: string;
    logoUrl: string;
  };
  brand: {
    colors: { primary: string; secondary: string; text: string; accent: string };
    fonts: { heading: string; body: string };
  };
  theme: string;
  plugins: { free: string[]; premium: string[] };
  pages: PageDraft[];
  menu: { name: string; location: string };
};

export type AppliedPage = {
  title: string;
  slug: string;
  postId: number;
  url: string;
  editUrl: string;
  isFrontPage: boolean;
};

export type PageCheck = {
  title: string;
  url: string;
  status: number | null;
  widgetCount: number;
  phpNotices: string[];
  ok: boolean;
  note?: string;
};

export type VerifyReport = { checks: PageCheck[]; ok: boolean };

export type BuildResult = {
  siteUrl: string;
  adminUrl: string;
  adminUser: string;
  adminPassword: string;
  sitePath: string;
  briefPath: string;
  pages: AppliedPage[];
  verification?: VerifyReport;
};

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** "Bright Smile Dental" → "bright-smile-dental" */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function emptyBrief(): BriefDraft {
  return {
    site: {
      name: "",
      slug: "",
      tagline: "",
      adminUser: "admin",
      adminEmail: "",
      adminPassword: "",
      logoUrl: "",
    },
    brand: {
      colors: {
        primary: "#0F766E",
        secondary: "#134E4A",
        text: "#1F2937",
        accent: "#F59E0B",
      },
      fonts: { heading: "Poppins", body: "Inter" },
    },
    theme: "hello-elementor",
    plugins: { free: ["elementor"], premium: [] },
    pages: [
      {
        uid: uid(),
        title: "Home",
        slug: "home",
        isFrontPage: true,
        sections: [],
      },
    ],
    menu: { name: "Primary", location: "menu-1" },
  };
}

/**
 * Bring a stored draft up to the current shape.
 *
 * Drafts are persisted to localStorage, so one saved before a field existed
 * comes back missing it — and an absent `plugins.premium` used to crash the
 * build button outright. Merge against the defaults rather than trusting it.
 */
export function normalizeDraft(stored: unknown): BriefDraft {
  const base = emptyBrief();
  if (!stored || typeof stored !== "object") return base;
  const draft = stored as Partial<BriefDraft>;

  const pages = Array.isArray(draft.pages) && draft.pages.length > 0
    ? draft.pages.map((page) => ({
        uid: page?.uid ?? uid(),
        title: page?.title ?? "Page",
        slug: page?.slug ?? "page",
        isFrontPage: Boolean(page?.isFrontPage),
        sections: Array.isArray(page?.sections)
          ? page.sections.map((section) => ({
              uid: section?.uid ?? uid(),
              block: section?.block ?? "",
              content: section?.content ?? {},
            }))
          : [],
      }))
    : base.pages;

  return {
    site: { ...base.site, ...(draft.site ?? {}) },
    brand: {
      colors: { ...base.brand.colors, ...(draft.brand?.colors ?? {}) },
      fonts: { ...base.brand.fonts, ...(draft.brand?.fonts ?? {}) },
    },
    theme: draft.theme || base.theme,
    plugins: {
      free: Array.isArray(draft.plugins?.free) ? draft.plugins.free : base.plugins.free,
      premium: Array.isArray(draft.plugins?.premium) ? draft.plugins.premium : [],
    },
    // A draft with no front page would silently build the blog index instead.
    pages: pages.some((page) => page.isFrontPage)
      ? pages
      : pages.map((page, index) => ({ ...page, isFrontPage: index === 0 })),
    menu: { ...base.menu, ...(draft.menu ?? {}) },
  };
}

/** Strip client-only fields before sending to the API. */
export function toPayload(draft: BriefDraft) {
  return {
    site: {
      ...draft.site,
      adminPassword: draft.site.adminPassword || undefined,
    },
    brand: draft.brand,
    theme: draft.theme,
    plugins: {
      free: draft.plugins.free,
      // The server resolves each name against vendor-plugins/.
      premium: draft.plugins.premium.map((zip) => ({ zip })),
    },
    pages: draft.pages.map((page) => ({
      title: page.title,
      slug: page.slug,
      isFrontPage: page.isFrontPage,
      sections: page.sections.map((section) => ({
        block: section.block,
        content: section.content,
      })),
    })),
    menu: draft.menu,
  };
}
