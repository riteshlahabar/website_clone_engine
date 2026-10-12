/**
 * The site brief: the single source of truth for a build.
 *
 * Shared by the server and the browser form, so one schema validates both the
 * UI input and the request payload. Round-trips to YAML for reproducible builds.
 */
import { z } from "zod";

const slug = z
  .string()
  .min(1, "Required")
  .max(50)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers and single dashes (e.g. bright-smile).",
  );

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour such as #0F766E.");

export const siteSchema = z.object({
  name: z.string().min(1, "Give the site a name."),
  slug,
  tagline: z.string().default(""),
  adminUser: z.string().min(1).default("admin"),
  adminEmail: z.email("Enter a valid email address."),
  /** Generated when absent so a build never blocks on a password prompt. */
  adminPassword: z.string().min(6).optional(),
});

export const brandSchema = z.object({
  colors: z.object({
    primary: hexColor.default("#0F766E"),
    secondary: hexColor.default("#134E4A"),
    text: hexColor.default("#1F2937"),
    accent: hexColor.default("#F59E0B"),
  }),
  fonts: z.object({
    heading: z.string().default("Poppins"),
    body: z.string().default("Inter"),
  }),
});

/** A chosen block plus the text/images that fill its placeholders. */
export const sectionSchema = z.object({
  /** Must match a block id in server/elementor/blocks/. */
  block: z.string().min(1),
  content: z.record(z.string(), z.unknown()).default({}),
});

export const pageSchema = z.object({
  title: z.string().min(1, "Every page needs a title."),
  slug,
  isFrontPage: z.boolean().default(false),
  sections: z.array(sectionSchema).default([]),
});

export const premiumPluginSchema = z.object({
  /** Filename inside vendor-plugins/, uploaded through the UI. */
  zip: z.string().min(1),
  /** Env var name or literal key used for `wp elementor license activate`. */
  licenseKey: z.string().optional(),
});

export const briefSchema = z.object({
  site: siteSchema,
  brand: brandSchema,
  theme: z.string().default("hello-elementor"),
  plugins: z
    .object({
      free: z.array(z.string()).default(["elementor"]),
      premium: z.array(premiumPluginSchema).default([]),
    })
    .default({ free: ["elementor"], premium: [] }),
  pages: z.array(pageSchema).min(1, "Add at least one page."),
  menu: z
    .object({
      name: z.string().default("Primary"),
      /** Theme menu location slug; hello-elementor uses `menu-1`. */
      location: z.string().default("menu-1"),
    })
    .default({ name: "Primary", location: "menu-1" }),
});

export type Brief = z.infer<typeof briefSchema>;
export type Page = z.infer<typeof pageSchema>;
export type Section = z.infer<typeof sectionSchema>;

/**
 * Validate an unknown payload, collecting every problem rather than stopping at
 * the first, so the form can highlight all bad fields at once.
 */
export function parseBrief(
  input: unknown,
): { ok: true; brief: Brief } | { ok: false; errors: string[] } {
  const result = briefSchema.safeParse(input);
  if (result.success) return { ok: true, brief: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "brief"}: ${issue.message}`,
    ),
  };
}

/** Exactly one page must be the front page; default to the first otherwise. */
export function resolveFrontPage(brief: Brief): Page {
  return brief.pages.find((page) => page.isFrontPage) ?? brief.pages[0]!;
}
