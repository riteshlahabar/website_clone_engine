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

// --- clone -------------------------------------------------------------

/** One page discovery found, as shown in the confirmation checklist. */
export type DiscoveredPage = {
  url: string;
  slug: string;
  title: string;
  depth: number;
  isFrontPage: boolean;
};

export type SectionDecision = {
  role: "header" | "footer" | "section";
  tag: string;
  mode: "native" | "html";
  reason?: string;
  widgets: number;
  unmapped: number;
  score: number;
};

export type ClonedPage = {
  title: string;
  slug: string;
  sourceUrl: string;
  url: string;
  editUrl: string;
  postId: number;
  isFrontPage: boolean;
  decisions: SectionDecision[];
  summary: string;
  /** Absent when the visual check could not run for this page. */
  visual?: VisualComparison;
  visualSummary?: string;
};

/** Mirrors VisualComparison in server/clone/compare.ts. */
export type VisualComparison = {
  source: { width: number; height: number };
  clone: { width: number; height: number };
  heightRatio: number;
  difference: number;
};

export type CloneResult = {
  siteUrl: string;
  adminUrl: string;
  adminUser: string;
  adminPassword: string;
  sitePath: string;
  dbName: string;
  themeSlug: string;
  pages: ClonedPage[];
  stats: {
    imagesImported: number;
    assetsLocalized: number;
    cssBytes: number;
    menuItems: number;
    hasHeader: boolean;
    hasFooter: boolean;
  };
};

/** The clone form's state. Mirrors cloneSpecSchema on the server. */
export type CloneDraft = {
  sourceUrl: string;
  targetPath: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  adminUser: string;
  adminEmail: string;
  adminPassword: string;
  title: string;
  maxPages: number;
  respectRobots: boolean;
  /** See fidelitySchema.mode in server/shared/clone.ts. */
  cloneMode: "exact" | "auto" | "editable";
  htmlFallbackThreshold: number;
  viewportWidth: number;
};

export function emptyCloneDraft(): CloneDraft {
  return {
    sourceUrl: "",
    // Deliberately empty. Pre-filling the htdocs root looked like a valid
    // value but was rejected on submit, which read as a bug.
    targetPath: "",
    dbName: "",
    dbUser: "root",
    dbPassword: "",
    adminUser: "admin",
    adminEmail: "admin@example.com",
    adminPassword: "",
    title: "",
    maxPages: 15,
    respectRobots: true,
    cloneMode: "exact",
    htmlFallbackThreshold: 0.25,
    viewportWidth: 1440,
  };
}

/**
 * Merge a stored draft against current defaults.
 *
 * The brief form learned this the hard way: a draft saved under an older
 * schema came back missing a field and broke the submit button with nothing
 * shown in the UI. Anything unreadable falls back to a default.
 */
export function normalizeCloneDraft(stored: unknown): CloneDraft {
  const defaults = emptyCloneDraft();
  if (!stored || typeof stored !== "object") return defaults;
  const raw = stored as Record<string, unknown>;

  const text = (key: keyof CloneDraft): string => {
    const value = raw[key];
    return typeof value === "string" ? value : (defaults[key] as string);
  };
  const number = (key: keyof CloneDraft): number => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : (defaults[key] as number);
  };
  const flag = (key: keyof CloneDraft): boolean => {
    const value = raw[key];
    return typeof value === "boolean" ? value : (defaults[key] as boolean);
  };

  return {
    sourceUrl: text("sourceUrl"),
    targetPath: text("targetPath"),
    dbName: text("dbName"),
    dbUser: text("dbUser") || defaults.dbUser,
    dbPassword: text("dbPassword"),
    adminUser: text("adminUser") || defaults.adminUser,
    adminEmail: text("adminEmail") || defaults.adminEmail,
    adminPassword: text("adminPassword"),
    title: text("title"),
    maxPages: Math.min(100, Math.max(1, Math.round(number("maxPages")))),
    cloneMode:
      raw.cloneMode === "auto" || raw.cloneMode === "editable" || raw.cloneMode === "exact"
        ? raw.cloneMode
        : defaults.cloneMode,
    respectRobots: flag("respectRobots"),
    htmlFallbackThreshold: Math.min(1, Math.max(0, number("htmlFallbackThreshold"))),
    viewportWidth: Math.min(2560, Math.max(320, Math.round(number("viewportWidth")))),
  };
}

/** Shape the draft into the server's cloneSpecSchema. */
export function toClonePayload(
  draft: CloneDraft,
  selectedPages: DiscoveredPage[] = [],
): Record<string, unknown> {
  return {
    sourceUrl: draft.sourceUrl.trim(),
    targetPath: draft.targetPath.trim(),
    dbName: draft.dbName.trim(),
    dbUser: draft.dbUser.trim() || "root",
    dbPassword: draft.dbPassword,
    site: {
      title: draft.title.trim(),
      adminUser: draft.adminUser.trim() || "admin",
      adminEmail: draft.adminEmail.trim(),
      // An empty password means "generate one", so it must be absent.
      ...(draft.adminPassword ? { adminPassword: draft.adminPassword } : {}),
    },
    crawl: {
      maxPages: draft.maxPages,
      urls: [],
      respectRobots: draft.respectRobots,
    },
    fidelity: {
      mode: draft.cloneMode,
      htmlFallbackThreshold: draft.htmlFallbackThreshold,
      viewportWidth: draft.viewportWidth,
      viewportHeight: 900,
    },
    selectedPages,
  };
}
