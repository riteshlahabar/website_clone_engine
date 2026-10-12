import { describe, expect, it } from "vitest";
import { composePage, validateDocument } from "../server/elementor/compose.ts";
import { getBlock, listBlocks } from "../server/elementor/registry.ts";
import { getTemplate, listTemplates } from "../server/templates/registry.ts";
import { briefSchema, type Brief, type Page } from "../server/shared/brief.ts";

const BRAND = {
  primary: "#112233",
  secondary: "#445566",
  text: "#778899",
  accent: "#AABBCC",
};

function briefWith(sections: Page["sections"]): Brief {
  return briefSchema.parse({
    site: { name: "Test Site", slug: "test-site", adminEmail: "a@b.com" },
    brand: { colors: BRAND, fonts: { heading: "Poppins", body: "Inter" } },
    pages: [{ title: "Home", slug: "home", isFrontPage: true, sections }],
  });
}

describe("block library", () => {
  it("every block composes into a valid Elementor document", async () => {
    const blocks = await listBlocks();
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const brief = briefWith([{ block: block.id, content: {} }]);
      const elements = await composePage(brief.pages[0]!, brief);
      expect(validateDocument(elements), `block ${block.id}`).toEqual([]);
    }
  });

  it("gives every element across a multi-section page a unique id", async () => {
    const blocks = await listBlocks();
    const brief = briefWith(blocks.map((block) => ({ block: block.id, content: {} })));
    const elements = await composePage(brief.pages[0]!, brief);

    const ids: string[] = [];
    const walk = (node: { id: string; elements?: unknown[] }) => {
      ids.push(node.id);
      for (const child of node.elements ?? []) {
        walk(child as { id: string; elements?: unknown[] });
      }
    };
    elements.forEach(walk);

    expect(ids.length).toBeGreaterThan(blocks.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{7}$/.test(id))).toBe(true);
  });

  it("leaves no unsubstituted placeholders", async () => {
    const blocks = await listBlocks();
    const brief = briefWith(blocks.map((block) => ({ block: block.id, content: {} })));
    const elements = await composePage(brief.pages[0]!, brief);
    expect(JSON.stringify(elements)).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe("content and brand resolution", () => {
  it("prefers supplied content over the block default", async () => {
    const brief = briefWith([
      { block: "hero-centered", content: { heading: "A specific headline" } },
    ]);
    const elements = await composePage(brief.pages[0]!, brief);
    const json = JSON.stringify(elements);

    expect(json).toContain("A specific headline");
    expect(json).not.toContain("A headline that says what you do");
  });

  it("applies the brand palette to brand-linked parameters", async () => {
    const brief = briefWith([{ block: "hero-centered", content: {} }]);
    const elements = await composePage(brief.pages[0]!, brief);
    const json = JSON.stringify(elements);

    // hero-centered marks accentColor as brand "primary" and headingColor as "text".
    expect(json).toContain(BRAND.primary);
    expect(json).toContain(BRAND.text);
  });

  it("lets an explicit colour override the brand palette", async () => {
    const brief = briefWith([
      { block: "hero-centered", content: { accentColor: "#FF0000" } },
    ]);
    const elements = await composePage(brief.pages[0]!, brief);
    expect(JSON.stringify(elements)).toContain("#FF0000");
  });
});

describe("validateDocument", () => {
  it("rejects duplicate element ids", () => {
    const duplicate = {
      id: "aaaaaaa",
      elType: "container",
      settings: {},
      elements: [
        { id: "aaaaaaa", elType: "widget", widgetType: "heading", settings: {}, elements: [] },
      ],
    };
    expect(validateDocument([duplicate])).toContainEqual(
      expect.stringContaining("duplicate element id"),
    );
  });

  it("rejects a widget with no widgetType", () => {
    const broken = { id: "bbbbbbb", elType: "widget", settings: {}, elements: [] };
    expect(validateDocument([broken])).toContainEqual(
      expect.stringContaining("missing widgetType"),
    );
  });

  it("rejects a malformed id", () => {
    const broken = {
      id: "TOO-LONG",
      elType: "container",
      settings: {},
      elements: [],
    };
    expect(validateDocument([broken])).toContainEqual(
      expect.stringContaining("not 7 hex characters"),
    );
  });
});

describe("brief schema", () => {
  it("rejects a slug with spaces or capitals", () => {
    const result = briefSchema.safeParse({
      site: { name: "X", slug: "Not A Slug", adminEmail: "a@b.com" },
      brand: { colors: BRAND, fonts: { heading: "A", body: "B" } },
      pages: [{ title: "Home", slug: "home" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one page", () => {
    const result = briefSchema.safeParse({
      site: { name: "X", slug: "x", adminEmail: "a@b.com" },
      brand: { colors: BRAND, fonts: { heading: "A", body: "B" } },
      pages: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("image parameters", () => {
  it("always defines the companion _id token so nothing is left unsubstituted", async () => {
    // text-image-split references {{imageUrl}} and {{imageUrl_id}} as a pair.
    // When no import happened the id must resolve to "" rather than survive.
    const brief = briefWith([{ block: "text-image-split", content: {} }]);
    const elements = await composePage(brief.pages[0]!, brief);

    expect(validateDocument(elements)).toEqual([]);
    expect(JSON.stringify(elements)).not.toContain("imageUrl_id");
  });

  it("uses the attachment id the apply phase injected", async () => {
    const brief = briefWith([
      {
        block: "text-image-split",
        content: {
          imageUrl: "http://localhost/site/wp-content/uploads/hero.jpg",
          imageUrl_id: "42",
        },
      },
    ]);
    const elements = await composePage(brief.pages[0]!, brief);
    const json = JSON.stringify(elements);

    expect(json).toContain('"id":"42"');
    expect(json).toContain("uploads/hero.jpg");
  });
});

describe("block library coverage", () => {
  it("declares a param for every token appearing in a template", async () => {
    const blocks = await listBlocks();
    for (const meta of blocks) {
      const block = await getBlock(meta.id);
      const tokens = new Set(
        [...JSON.stringify(block.template).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!),
      );
      const declared = new Set(meta.params.map((param) => param.key));
      // `<key>_id` companions are derived from an image param, not declared.
      const undeclared = [...tokens].filter(
        (token) =>
          !declared.has(token) &&
          !(token.endsWith("_id") && declared.has(token.slice(0, -3))),
      );
      expect(undeclared, `block ${meta.id} has undeclared tokens`).toEqual([]);
    }
  });

  it("uses only Elementor free widgets", async () => {
    // These are Pro-only; Elementor registers upgrade stubs for them, so a
    // block referencing one renders an "Upgrade" prompt instead of content.
    const proOnly = [
      "price-table", "form", "slides", "flip-box", "call-to-action",
      "nav-menu", "posts", "portfolio", "testimonial-carousel",
      "animated-headline", "countdown", "share-buttons", "lottie",
    ];
    const blocks = await listBlocks();
    for (const meta of blocks) {
      const block = await getBlock(meta.id);
      const used = [
        ...JSON.stringify(block.template).matchAll(/"widgetType":"([^"]+)"/g),
      ].map((match) => match[1]!);
      const offenders = used.filter((widget) => proOnly.includes(widget));
      expect(offenders, `block ${meta.id} uses Pro widgets`).toEqual([]);
    }
  });
});

describe("starter templates", () => {
  it("loads and validates every template file", async () => {
    const templates = await listTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(template.pageCount).toBeGreaterThan(0);
      expect(template.sectionCount).toBeGreaterThan(0);
    }
  });

  it("references only blocks that exist", async () => {
    for (const summary of await listTemplates()) {
      const template = await getTemplate(summary.id);
      for (const page of template.pages) {
        for (const section of page.sections) {
          // getBlock throws on an unknown id, which is the assertion.
          await expect(getBlock(section.block)).resolves.toBeDefined();
        }
      }
    }
  });

  it("only sets content keys the chosen block declares", async () => {
    for (const summary of await listTemplates()) {
      const template = await getTemplate(summary.id);
      for (const page of template.pages) {
        for (const section of page.sections) {
          const block = await getBlock(section.block);
          const declared = new Set(block.params.map((param) => param.key));
          const unknown = Object.keys(section.content).filter(
            (key) => !declared.has(key),
          );
          // A typo'd key is silently ignored at compose time, so the copy just
          // never appears. Catch it here instead.
          expect(
            unknown,
            `${summary.id} / ${page.slug} / ${section.block}`,
          ).toEqual([]);
        }
      }
    }
  });

  it("composes every template page into a valid document", async () => {
    for (const summary of await listTemplates()) {
      const template = await getTemplate(summary.id);
      const brief = briefSchema.parse({
        site: { name: "T", slug: "t", adminEmail: "a@b.com" },
        brand: template.brand,
        theme: template.theme,
        plugins: { free: template.plugins.free, premium: [] },
        pages: template.pages,
        menu: template.menu,
      });

      for (const page of brief.pages) {
        const elements = await composePage(page, brief);
        expect(
          validateDocument(elements),
          `${summary.id} / ${page.slug}`,
        ).toEqual([]);
      }
    }
  });

  it("gives each template exactly one front page", async () => {
    for (const summary of await listTemplates()) {
      const template = await getTemplate(summary.id);
      const fronts = template.pages.filter((page) => page.isFrontPage);
      expect(fronts.length, `${summary.id}`).toBe(1);
    }
  });

  it("uses unique page slugs within a template", async () => {
    for (const summary of await listTemplates()) {
      const template = await getTemplate(summary.id);
      const slugs = template.pages.map((page) => page.slug);
      expect(new Set(slugs).size, `${summary.id}`).toBe(slugs.length);
    }
  });
});
