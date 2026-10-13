/**
 * Turns a user-supplied folder and database name into a provisioning target.
 *
 * The brief-based builder derives both from the slug and never asks. A clone
 * lets the user name them, which means the answers now have to be checked:
 * a path outside htdocs would install a site Apache cannot serve, and a path
 * that already holds files is probably something the user cares about.
 *
 * Nothing here touches the database — lib/db.ts owns that check.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { XAMPP } from "./env.ts";

export type ProvisionTarget = {
  sitePath: string;
  siteUrl: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  /**
   * The `RewriteBase` for .htaccess — the site's path below the document
   * root, without surrounding slashes.
   */
  rewriteBase: string;
};

/** Files that do not count as "the folder already has something in it". */
const IGNORABLE_ENTRIES = new Set([".gitkeep", "desktop.ini", "thumbs.db", ".ds_store"]);

/**
 * Is `child` inside `parent`? Compared on resolved, case-folded paths because
 * Windows paths are case-insensitive and users paste mixed case.
 */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export type ResolveTargetOptions = {
  /**
   * Allow installing into a folder that already contains files. A re-run
   * against a half-built clone needs this; a first run should not.
   */
  allowNonEmpty?: boolean;
};

/**
 * Validate the folder and build the target. Throws with an actionable message
 * rather than returning a result object, because every caller treats any
 * problem here as fatal before a job starts.
 */
export async function resolveCloneTarget(
  spec: { targetPath: string; dbName: string; dbUser: string; dbPassword: string },
  options: ResolveTargetOptions = {},
): Promise<ProvisionTarget> {
  const sitePath = path.resolve(spec.targetPath);

  // Checked before containment: htdocs itself is not "inside" htdocs, so the
  // containment message would otherwise fire and read as a contradiction
  // ("must be inside C:\xampp\htdocs. Got C:\xampp\htdocs").
  if (sitePath.toLowerCase() === path.resolve(XAMPP.htdocs).toLowerCase()) {
    throw new Error(
      `That is the htdocs folder itself. Give the clone its own folder inside ` +
        `it, such as ${path.join(XAMPP.htdocs, "my-clone")}.`,
    );
  }

  if (!isInside(XAMPP.htdocs, sitePath)) {
    throw new Error(
      `The target folder must be inside ${XAMPP.htdocs} so Apache can serve it. ` +
        `Got "${sitePath}". Use a path such as ${path.join(XAMPP.htdocs, "my-clone")}.`,
    );
  }

  const relative = path.relative(XAMPP.htdocs, sitePath);
  // A nested folder is fine; the URL just carries the same nesting.
  const urlPath = relative.split(path.sep).filter(Boolean).join("/");
  if (!urlPath) {
    throw new Error(
      `Refusing to install into the htdocs root itself. Give the clone its own folder.`,
    );
  }

  if (existsSync(sitePath) && !options.allowNonEmpty) {
    const entries = (await readdir(sitePath)).filter(
      (entry) => !IGNORABLE_ENTRIES.has(entry.toLowerCase()),
    );
    if (entries.length > 0) {
      // An existing WordPress is a re-run, which is worth saying plainly.
      const looksLikeWordPress = entries.includes("wp-config.php") ||
        entries.includes("wp-includes");
      throw new Error(
        looksLikeWordPress
          ? `"${sitePath}" already holds a WordPress install. Choose an empty ` +
            `folder, or delete that one first if it is no longer needed.`
          : `"${sitePath}" is not empty (${entries.length} item(s)). ` +
            `Choose an empty or non-existent folder.`,
      );
    }
  }

  return {
    sitePath,
    siteUrl: `http://localhost/${urlPath}`,
    dbName: spec.dbName,
    dbUser: spec.dbUser,
    dbPassword: spec.dbPassword,
    rewriteBase: urlPath,
  };
}

export type FolderEntry = {
  name: string;
  /** Absolute path, which is what the form needs. */
  path: string;
  /** Path relative to htdocs, for navigating. */
  relative: string;
  isEmpty: boolean;
  hasWordPress: boolean;
  childFolders: number;
};

export type FolderListing = {
  /** The htdocs root, always the top of the tree. */
  base: string;
  /** Absolute path being listed. */
  current: string;
  /** Relative path being listed; "" at the root. */
  relative: string;
  /** Relative path one level up, or null at the root. */
  parent: string | null;
  entries: FolderEntry[];
};

/**
 * List folders under htdocs so the browser can offer a picker.
 *
 * A browser cannot hand a server an absolute path — a directory input only
 * exposes the files inside a folder, and an empty folder exposes nothing at
 * all, which is exactly the case that matters here. Since this server runs on
 * the user's own machine, it can read the directory itself and let them click
 * through it instead of typing a path.
 *
 * Confined to htdocs: the clone has to live there anyway, and it keeps this
 * from being a general filesystem browser.
 */
export async function listHtdocsFolders(relativePath = ""): Promise<FolderListing> {
  const base = path.resolve(XAMPP.htdocs);
  const requested = path.resolve(base, relativePath);

  // Anything outside htdocs — including via `..` — snaps back to the root.
  const current = requested === base || isInside(base, requested) ? requested : base;
  const relative = path.relative(base, current).split(path.sep).filter(Boolean).join("/");
  const parentRelative = relative
    ? relative.split("/").slice(0, -1).join("/")
    : null;

  let names: string[] = [];
  try {
    const entries = await readdir(current, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    names = [];
  }

  const entries: FolderEntry[] = [];
  for (const name of names) {
    const absolute = path.join(current, name);
    let contents: string[] = [];
    let childFolders = 0;
    try {
      const dirents = await readdir(absolute, { withFileTypes: true });
      contents = dirents.map((entry) => entry.name);
      childFolders = dirents.filter((entry) => entry.isDirectory()).length;
    } catch {
      // An unreadable folder is reported as non-empty, which is the safe guess.
      contents = ["?"];
    }
    const meaningful = contents.filter(
      (entry) => !IGNORABLE_ENTRIES.has(entry.toLowerCase()),
    );
    entries.push({
      name,
      path: absolute,
      relative: relative ? `${relative}/${name}` : name,
      isEmpty: meaningful.length === 0,
      hasWordPress:
        contents.includes("wp-config.php") || contents.includes("wp-includes"),
      childFolders,
    });
  }

  return { base, current, relative, parent: parentRelative, entries };
}

/** A folder name usable as a WordPress slug, for naming the child theme. */
export function slugFromPath(sitePath: string): string {
  const base = path.basename(path.resolve(sitePath));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "clone";
}
