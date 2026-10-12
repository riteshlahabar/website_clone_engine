/**
 * The block library.
 *
 * Every layout the builder can produce comes from here. Blocks are
 * hand-authored, verified Elementor JSON with `{{token}}` placeholders; nothing
 * in the pipeline is allowed to invent Elementor schema, because the schema is
 * large and version-sensitive and invalid JSON silently renders a blank page.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../lib/env.ts";

export type BlockParam = {
  key: string;
  label: string;
  type: "text" | "textarea" | "color";
  default: string;
  /** Links this param to a brand colour so the palette drives the design. */
  brand?: "primary" | "secondary" | "accent" | "text" | "surface";
};

export type BlockMeta = {
  id: string;
  name: string;
  description: string;
  params: BlockParam[];
};

export type Block = BlockMeta & {
  /** The raw Elementor element tree, still containing {{tokens}}. */
  template: unknown;
};

let cache: Map<string, Block> | null = null;

async function load(): Promise<Map<string, Block>> {
  if (cache) return cache;

  const entries = await readdir(PATHS.blocks);
  const ids = entries
    .filter((name) => name.endsWith(".meta.json"))
    .map((name) => name.replace(/\.meta\.json$/, ""));

  const blocks = new Map<string, Block>();
  for (const id of ids) {
    const [metaRaw, templateRaw] = await Promise.all([
      readFile(path.join(PATHS.blocks, `${id}.meta.json`), "utf8"),
      readFile(path.join(PATHS.blocks, `${id}.json`), "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as BlockMeta;
    if (meta.id !== id) {
      throw new Error(`Block ${id}.meta.json declares a mismatched id "${meta.id}".`);
    }
    blocks.set(id, { ...meta, template: JSON.parse(templateRaw) });
  }

  cache = blocks;
  return blocks;
}

export async function getBlock(id: string): Promise<Block> {
  const blocks = await load();
  const block = blocks.get(id);
  if (!block) {
    throw new Error(
      `Unknown block "${id}". Available: ${[...blocks.keys()].join(", ")}`,
    );
  }
  return block;
}

/** Catalogue for the UI's block picker — metadata only, no templates. */
export async function listBlocks(): Promise<BlockMeta[]> {
  const blocks = await load();
  return [...blocks.values()]
    .map(({ template: _template, ...meta }) => meta)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Drop the cache so edits to block files are picked up without a restart. */
export function clearBlockCache(): void {
  cache = null;
}
