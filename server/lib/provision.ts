/**
 * Phase: provision — get a working WordPress install on XAMPP with the theme
 * and plugins in place, ready for Elementor content.
 *
 * Every step is idempotent so a brief can be re-run after a partial failure.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DB, PATHS, siteUrlFor, sitePathFor } from "./env.ts";
import type { JobLogger } from "./jobs.ts";
import { wp } from "./wpcli.ts";
import { ensureWordPressCore } from "./wpcore.ts";
import type { Brief } from "../shared/brief.ts";

export type ProvisionResult = {
  sitePath: string;
  siteUrl: string;
  adminUrl: string;
  adminUser: string;
  adminPassword: string;
  /** True when this run created the install rather than reusing one. */
  created: boolean;
};

function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

/** Run a WP-CLI command, echoing it and its output into the job log. */
async function run(
  logger: JobLogger,
  args: string[],
  options: { sitePath?: string; allowFailure?: boolean } = {},
) {
  logger.command(`wp ${args.join(" ")}`);
  return wp(args, {
    sitePath: options.sitePath,
    throwOnError: !options.allowFailure,
    onLine: (line) => {
      if (line.trim()) logger.log(line.trimEnd());
    },
  });
}

/**
 * Write WordPress's standard rewrite rules.
 *
 * `wp rewrite structure --hard` would do this, but it re-invokes WP-CLI as a
 * subprocess and fails when the phar path contains a space. The ruleset is
 * fixed and well-known, so writing it directly is both simpler and reliable.
 */
async function writeHtaccess(
  sitePath: string,
  slug: string,
  logger: JobLogger,
): Promise<void> {
  const base = `/${slug}/`;
  const rules = [
    "# BEGIN WordPress",
    "<IfModule mod_rewrite.c>",
    "RewriteEngine On",
    `RewriteBase ${base}`,
    `RewriteRule ^index\\.php$ - [L]`,
    "RewriteCond %{REQUEST_FILENAME} !-f",
    "RewriteCond %{REQUEST_FILENAME} !-d",
    `RewriteRule . ${base}index.php [L]`,
    "</IfModule>",
    "# END WordPress",
    "",
  ].join("\n");

  await writeFile(path.join(sitePath, ".htaccess"), rules, "utf8");
  logger.log("Wrote .htaccess rewrite rules.");
}

export async function provision(
  brief: Brief,
  logger: JobLogger,
): Promise<ProvisionResult> {
  const { slug } = brief.site;
  const sitePath = sitePathFor(slug);
  const siteUrl = siteUrlFor(slug);
  const dbName = DB.nameFor(slug);

  logger.step(`Provisioning WordPress at ${sitePath}`);

  // 1. WordPress core files. See wpcore.ts for why `wp core download` is avoided.
  await ensureWordPressCore(sitePath, logger);

  // 2. wp-config.php pointing at the XAMPP MariaDB.
  if (existsSync(path.join(sitePath, "wp-config.php"))) {
    logger.log("wp-config.php already exists — skipping.");
  } else {
    logger.step("Writing wp-config.php…");
    await run(logger, [
      "config",
      "create",
      `--dbname=${dbName}`,
      `--dbuser=${DB.user}`,
      `--dbpass=${DB.password}`,
      `--dbhost=${DB.host}:${DB.port}`,
      "--skip-check",
    ], { sitePath });
  }

  // 3. Database. `wp db create` fails harmlessly when it already exists.
  logger.step(`Ensuring database ${dbName} exists…`);
  const dbCreate = await run(logger, ["db", "create"], {
    sitePath,
    allowFailure: true,
  });
  if (dbCreate.exitCode !== 0) {
    const alreadyExists = /database exists|already exists/i.test(
      dbCreate.stderr + dbCreate.stdout,
    );
    if (!alreadyExists) {
      throw new Error(
        `Could not create database ${dbName}: ${dbCreate.stderr || dbCreate.stdout}`,
      );
    }
    logger.log(`Database ${dbName} already exists — reusing it.`);
  }

  // 4. Core install.
  const adminPassword = brief.site.adminPassword ?? generatePassword();
  const installed = await run(logger, ["core", "is-installed"], {
    sitePath,
    allowFailure: true,
  });
  let created = false;
  if (installed.exitCode === 0) {
    logger.log("WordPress is already installed — keeping existing content.");
  } else {
    logger.step("Installing WordPress…");
    await run(logger, [
      "core",
      "install",
      `--url=${siteUrl}`,
      `--title=${brief.site.name}`,
      `--admin_user=${brief.site.adminUser}`,
      `--admin_password=${adminPassword}`,
      `--admin_email=${brief.site.adminEmail}`,
      "--skip-email",
    ], { sitePath });
    created = true;
  }

  if (brief.site.tagline) {
    await run(logger, ["option", "update", "blogdescription", brief.site.tagline], {
      sitePath,
    });
  }

  // 5. Theme.
  logger.step(`Installing theme: ${brief.theme}`);
  await run(logger, ["theme", "install", brief.theme, "--activate", "--force"], {
    sitePath,
  });

  // 6. Free plugins from wordpress.org.
  for (const plugin of brief.plugins.free) {
    logger.step(`Installing plugin: ${plugin}`);
    await run(logger, ["plugin", "install", plugin, "--activate"], { sitePath });
  }

  // 7. Premium plugins uploaded by the user. These cannot be fetched from
  //    wordpress.org, so they are installed from vendor-plugins/.
  for (const premium of brief.plugins.premium) {
    const zipPath = path.join(PATHS.vendorPlugins, premium.zip);
    if (!existsSync(zipPath)) {
      logger.warn(
        `Skipping ${premium.zip} — not found in vendor-plugins/. Upload it and re-run.`,
      );
      continue;
    }
    logger.step(`Installing premium plugin: ${premium.zip}`);
    await run(logger, ["plugin", "install", zipPath, "--activate", "--force"], {
      sitePath,
    });

    const license = premium.licenseKey && (process.env[premium.licenseKey] ?? premium.licenseKey);
    if (license && /elementor-pro/i.test(premium.zip)) {
      logger.step("Activating Elementor Pro license…");
      const activation = await run(logger, ["elementor", "license", "activate", license], {
        sitePath,
        allowFailure: true,
      });
      if (activation.exitCode !== 0) {
        logger.warn("License activation failed — Pro widgets may be unavailable.");
      }
    }
  }

  // 8. Pretty permalinks, so page slugs resolve as /about/ not /?p=12.
  logger.step("Setting permalinks…");
  await run(logger, ["rewrite", "structure", "/%postname%/"], { sitePath });
  await writeHtaccess(sitePath, slug, logger);

  logger.success(`WordPress ready at ${siteUrl}`);

  return {
    sitePath,
    siteUrl,
    adminUrl: `${siteUrl}/wp-admin/`,
    adminUser: brief.site.adminUser,
    adminPassword,
    created,
  };
}
