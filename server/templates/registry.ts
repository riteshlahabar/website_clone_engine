/**
 * Starter templates: a whole brief, minus the details only the user knows.
 *
 * A template fills in pages, sections, copy, palette and fonts, so a usable
 * site is one click plus a business name away. It deliberately carries no
 * `site` block — name, slug and email always come from the person building.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../lib/env.ts";
import { brandSchema, pageSchema } from "../shared/brief.ts";

const TEMPLATES_DIR = path.join(PROJECT_ROOT, "server", "templates");

export const templateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  industry: z.string().min(1),
  brand: brandSchema,
  theme: z.string().default("hello-elementor"),
  plugins: z.object({ free: z.array(z.string()).default(["elementor"]) }),
  menu: z.object({ name: z.string(), location: z.string() }),
  pages: z.array(pageSchema).min(1),
});

export type SiteTemplate = z.infer<typeof templateSchema>;

/** Listing shape for the picker — enough to choose, without the whole brief. */
export type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  industry: string;
  pageCount: number;
  sectionCount: number;
  /** Palette swatch for the card. */
  colors: SiteTemplate["brand"]["colors"];
};

let cache: Map<string, SiteTemplate> | null = null;

async function load(): Promise<Map<string, SiteTemplate>> {
  if (cache) return cache;

  const entries = await readdir(TEMPLATES_DIR);
  const files = entries.filter((name) => name.endsWith(".json"));

  const templates = new Map<string, SiteTemplate>();
  for (const file of files) {
    const raw = await readFile(path.join(TEMPLATES_DIR, file), "utf8");
    const parsed = templateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Fail loudly at load rather than halfway through someone's build.
      throw new Error(
        `Template ${file} is invalid:\n  ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("\n  ")}`,
      );
    }
    const expectedId = file.replace(/\.json$/, "");
    if (parsed.data.id !== expectedId) {
      throw new Error(`Template ${file} declares a mismatched id "${parsed.data.id}".`);
    }
    templates.set(parsed.data.id, parsed.data);
  }

  cache = templates;
  return templates;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  const templates = await load();
  return [...templates.values()]
    .map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      industry: template.industry,
      pageCount: template.pages.length,
      sectionCount: template.pages.reduce(
        (total, page) => total + page.sections.length,
        0,
      ),
      colors: template.brand.colors,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplate(id: string): Promise<SiteTemplate> {
  const templates = await load();
  const template = templates.get(id);
  if (!template) {
    throw new Error(
      `Unknown template "${id}". Available: ${[...templates.keys()].join(", ")}`,
    );
  }
  return template;
}

export function clearTemplateCache(): void {
  cache = null;
}
