/**
 * The clone spec: the single source of truth for a clone run.
 *
 * The counterpart to brief.ts. A brief describes a site to invent; a spec
 * describes a site to reproduce, plus where to put it. Shared by the server
 * and the browser form so one schema validates both.
 *
 * Deliberately free of node imports — the UI imports this too.
 */
import { z } from "zod";

/**
 * Database names are interpolated into SQL as quoted string values by
 * lib/db.ts, so the character set is restricted rather than escaped. Hyphens
 * are allowed because the brief-based builder names its databases `wp_<slug>`
 * and slugs are hyphenated.
 */
export const DB_NAME_PATTERN = /^[A-Za-z0-9_$-]{1,64}$/;

/** A Windows absolute path: a drive letter, a colon, then a separator. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

const httpUrl = z
  .string()
  .min(1, "Required")
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    "Enter a full URL including http:// or https://",
  );

export const cloneSiteSchema = z.object({
  /** Falls back to the source page's <title> when left blank. */
  title: z.string().default(""),
  adminUser: z.string().min(1).default("admin"),
  adminEmail: z.email("Enter a valid email address.").default("admin@example.com"),
  adminPassword: z.string().min(6, "At least 6 characters.").optional(),
});

export const crawlSchema = z.object({
  /** Upper bound on pages, whatever discovery turns up. */
  maxPages: z.number().int().min(1).max(100).default(15),
  /**
   * The exact pages to clone. Empty means "discover them", which is what the
   * Discover step fills in before the user confirms.
   */
  urls: z.array(httpUrl).default([]),
  /** Obeying robots.txt is the default; the user can override it knowingly. */
  respectRobots: z.boolean().default(true),
});

export const fidelitySchema = z.object({
  /**
   * What a cloned band is turned into.
   *
   * `exact` keeps the source markup and lets the source's own stylesheet style
   * it, so the band renders as it did on the original — the same classes, the
   * same grid, the same pseudo-elements, the same hover states, the same
   * responsive behaviour. It is the only mode that can reproduce a page built
   * with a CSS framework, because the translation table below reads ~35
   * computed properties and a framework expresses layout with hundreds.
   *
   * `editable` translates bands into native Elementor widgets, which can be
   * edited in the Elementor canvas but look like an approximation of the
   * original rather than the original.
   *
   * `auto` keeps the markup for bands that would lose too much and translates
   * the rest — the old behaviour, and a reasonable middle.
   *
   * Default is `exact`: a clone that does not look like the source has failed
   * at the one job it has, and editability is worth nothing if the page is
   * wrong.
   */
  mode: z.enum(["exact", "auto", "editable"]).default("exact"),
  /**
   * `auto` only. How much of a section may fail to map before the whole section
   * falls back to an HTML widget carrying the original markup. 0 forces native
   * widgets everywhere, 1 never falls back.
   */
  htmlFallbackThreshold: z.number().min(0).max(1).default(0.25),
  /** Desktop width to capture at. Elementor's breakpoints are keyed to this. */
  viewportWidth: z.number().int().min(320).max(2560).default(1440),
  viewportHeight: z.number().int().min(320).max(2000).default(900),
});

export const cloneSpecSchema = z.object({
  sourceUrl: httpUrl,
  /**
   * Where WordPress is installed. Must sit under the XAMPP htdocs root so
   * Apache serves it without a vhost; lib/target.ts enforces that, because
   * this schema cannot touch the filesystem.
   */
  targetPath: z
    .string()
    .min(1, "Required")
    .regex(WINDOWS_ABSOLUTE, "Use a full path such as C:\\xampp\\htdocs\\my-clone."),
  /** A database the user already created, and which must be empty. */
  dbName: z
    .string()
    .min(1, "Required")
    .regex(DB_NAME_PATTERN, "Letters, digits, _ - and $ only, up to 64 characters."),
  dbUser: z.string().min(1).default("root"),
  dbPassword: z.string().default(""),
  site: cloneSiteSchema.prefault({}),
  crawl: crawlSchema.prefault({}),
  fidelity: fidelitySchema.prefault({}),
});

export type CloneSpec = z.infer<typeof cloneSpecSchema>;
export type CloneSite = z.infer<typeof cloneSiteSchema>;

/**
 * Validate an unknown payload, collecting every problem rather than stopping
 * at the first, so the form can highlight all bad fields at once.
 */
export function parseCloneSpec(
  input: unknown,
): { ok: true; spec: CloneSpec } | { ok: false; errors: string[] } {
  const result = cloneSpecSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`,
    ),
  };
}

/** The discovery step's output, shown as a checklist before a clone runs. */
export type DiscoveredPage = {
  url: string;
  /** Path-derived slug WordPress will use. */
  slug: string;
  title: string;
  depth: number;
  isFrontPage: boolean;
};
