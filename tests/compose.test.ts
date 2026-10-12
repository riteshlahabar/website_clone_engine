import { describe, expect, it } from "vitest";
import { composePage, validateDocument } from "../server/elementor/compose.ts";
import { listBlocks } from "../server/elementor/registry.ts";
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
