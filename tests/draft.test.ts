import { describe, expect, it } from "vitest";
import { emptyBrief, normalizeDraft, toPayload } from "../ui/src/types.ts";

describe("normalizeDraft", () => {
  it("repairs a draft saved before premium plugins existed", () => {
    // This exact shape crashed the Build button: toPayload called
    // draft.plugins.premium.map() on undefined.
    const legacy = {
      site: { name: "Old", slug: "old", adminEmail: "a@b.com" },
      plugins: { free: ["elementor"] },
      pages: [{ uid: "p1", title: "Home", slug: "home", isFrontPage: true, sections: [] }],
    };
    const draft = normalizeDraft(legacy);

    expect(draft.plugins.premium).toEqual([]);
    expect(() => toPayload(draft)).not.toThrow();
  });

  it("fills in fields added after the draft was saved", () => {
    const draft = normalizeDraft({ site: { name: "X" } });
    expect(draft.site.logoUrl).toBe("");
    expect(draft.site.adminUser).toBe("admin");
    expect(draft.brand.colors.primary).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(draft.menu.location).toBe("menu-1");
  });

  it("keeps the values a stored draft does have", () => {
    const draft = normalizeDraft({
      site: { name: "Kept", slug: "kept", adminEmail: "me@example.com" },
      brand: { colors: { primary: "#ABCDEF" } },
      theme: "astra",
    });
    expect(draft.site.name).toBe("Kept");
    expect(draft.site.adminEmail).toBe("me@example.com");
    expect(draft.brand.colors.primary).toBe("#ABCDEF");
    expect(draft.theme).toBe("astra");
  });

  it("guarantees exactly one front page", () => {
    const draft = normalizeDraft({
      pages: [
        { title: "A", slug: "a", isFrontPage: false, sections: [] },
        { title: "B", slug: "b", isFrontPage: false, sections: [] },
      ],
    });
    expect(draft.pages.filter((page) => page.isFrontPage)).toHaveLength(1);
    expect(draft.pages[0]!.isFrontPage).toBe(true);
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, 42, "nope", [], {}]) {
      expect(() => normalizeDraft(junk)).not.toThrow();
      expect(normalizeDraft(junk).pages.length).toBeGreaterThan(0);
    }
  });

  it("gives sections a uid so drag-reordering has stable keys", () => {
    const draft = normalizeDraft({
      pages: [
        {
          title: "Home", slug: "home", isFrontPage: true,
          sections: [{ block: "hero-centered", content: {} }],
        },
      ],
    });
    expect(draft.pages[0]!.sections[0]!.uid).toBeTruthy();
  });
});

describe("toPayload", () => {
  it("converts premium zip names into the shape the server expects", () => {
    const draft = emptyBrief();
    draft.plugins.premium = ["elementor-pro.zip"];
    expect(toPayload(draft).plugins.premium).toEqual([{ zip: "elementor-pro.zip" }]);
  });

  it("omits an empty admin password so the server generates one", () => {
    expect(toPayload(emptyBrief()).site.adminPassword).toBeUndefined();
  });
});
