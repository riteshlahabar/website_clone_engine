/**
 * Direct MariaDB introspection, for the case where the user supplies a
 * database they created themselves in phpMyAdmin.
 *
 * The brief-based builder can lean on `wp db create`, which is happy either
 * way: it creates the database or shrugs when it already exists. A clone
 * targets a database the user named, and there the interesting questions are
 * ones WP-CLI cannot answer before wp-config.php exists — does it exist, and
 * does it already hold tables? Installing WordPress over someone's existing
 * tables is the one failure here that destroys data, so it is checked first.
 *
 * Queries go through the XAMPP `mysql` client the way services.ts already
 * does, rather than adding a MySQL driver dependency for three statements.
 */
import { execa } from "execa";
import { DB_NAME_PATTERN } from "../shared/clone.ts";
import { XAMPP } from "./env.ts";

export type DbCredentials = {
  user: string;
  password: string;
};

export type DbQueryResult =
  | { ok: true; rows: string[] }
  | { ok: false; error: string };

/** Run one statement and return its rows, tab-separated, header stripped. */
async function query(sql: string, credentials: DbCredentials): Promise<DbQueryResult> {
  const args = ["-u", credentials.user];
  // An empty password must not become `-p` with nothing after it, which makes
  // the client prompt interactively and hang.
  if (credentials.password) args.push(`-p${credentials.password}`);
  args.push("--batch", "--skip-column-names", "-e", sql);

  try {
    const result = await execa(XAMPP.mysql, args, {
      reject: false,
      timeout: 15_000,
    });
    if (result.exitCode !== 0) {
      const message = (result.stderr || result.stdout || "").trim();
      return { ok: false, error: message || `mysql exited ${result.exitCode}` };
    }
    const rows = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { ok: true, rows };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type DatabaseState = {
  exists: boolean;
  tableCount: number;
};

/**
 * Describe a database: whether it exists and how many tables it holds.
 * Throws when MariaDB itself cannot be reached, because that is a different
 * problem from the database being absent and deserves a different message.
 */
export async function inspectDatabase(
  name: string,
  credentials: DbCredentials,
): Promise<DatabaseState> {
  if (!DB_NAME_PATTERN.test(name)) {
    throw new Error(
      `"${name}" is not a usable database name. Use letters, digits, _ or $ only.`,
    );
  }

  const existsResult = await query(
    `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}'`,
    credentials,
  );
  if (!existsResult.ok) {
    throw new Error(
      `Could not reach MariaDB as "${credentials.user}": ${existsResult.error}. ` +
        `Check MariaDB is running and the credentials are right.`,
    );
  }
  if (existsResult.rows.length === 0) {
    return { exists: false, tableCount: 0 };
  }

  const countResult = await query(
    `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${name}'`,
    credentials,
  );
  if (!countResult.ok) {
    throw new Error(`Could not count tables in ${name}: ${countResult.error}`);
  }
  return { exists: true, tableCount: Number(countResult.rows[0] ?? 0) };
}

/**
 * Insist on a database that exists and is empty, the contract the clone panel
 * advertises: you create it in phpMyAdmin, we install into it.
 */
export async function requireEmptyDatabase(
  name: string,
  credentials: DbCredentials,
): Promise<void> {
  const state = await inspectDatabase(name, credentials);

  if (!state.exists) {
    throw new Error(
      `Database "${name}" does not exist. Create it in phpMyAdmin ` +
        `(http://localhost/phpmyadmin) and run this again.`,
    );
  }
  if (state.tableCount > 0) {
    throw new Error(
      `Database "${name}" already holds ${state.tableCount} table(s). ` +
        `Refusing to install over existing data — create an empty database, ` +
        `or drop these tables first if they are not needed.`,
    );
  }
}
