/**
 * Phase: verify — prove the site actually works instead of assuming it does.
 *
 * Checks each page over HTTP for a 200, for PHP notices leaking into the
 * markup, and for the Elementor widgets we expected to be there. A build that
 * "succeeded" but renders a blank page should be reported as a problem.
 */
import type { JobLogger } from "./jobs.ts";
import type { AppliedPage } from "./apply.ts";

export type PageCheck = {
  title: string;
  url: string;
  status: number | null;
  widgetCount: number;
  phpNotices: string[];
  ok: boolean;
  note?: string;
};

export type VerifyReport = {
  checks: PageCheck[];
  ok: boolean;
};

/** PHP problems that leak into HTML when display_errors is on, as XAMPP has. */
const PHP_NOTICE = /\b(Warning|Notice|Fatal error|Parse error|Deprecated):\s[^<\n]{0,160}/g;

function countWidgets(html: string): number {
  return (html.match(/elementor-widget-/g) ?? []).length;
}

async function checkPage(page: AppliedPage, expectsContent: boolean): Promise<PageCheck> {
  try {
    const response = await fetch(page.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const html = await response.text();

    const notices = [...new Set(html.match(PHP_NOTICE) ?? [])].slice(0, 5);
    const widgetCount = countWidgets(html);

    let note: string | undefined;
    let ok = response.ok && notices.length === 0;

    if (response.ok && expectsContent && widgetCount === 0) {
      // The failure mode that matters most: a page that loads but is empty,
      // which is what a corrupted _elementor_data looks like from outside.
      ok = false;
      note = "Page loads but contains no Elementor widgets.";
    }

    return {
      title: page.title,
      url: page.url,
      status: response.status,
      widgetCount,
      phpNotices: notices,
      ok,
      note,
    };
  } catch (error) {
    return {
      title: page.title,
      url: page.url,
      status: null,
      widgetCount: 0,
      phpNotices: [],
      ok: false,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifySite(
  pages: AppliedPage[],
  sectionCountBySlug: Record<string, number>,
  logger: JobLogger,
): Promise<VerifyReport> {
  logger.step("Verifying the finished site…");

  const checks = await Promise.all(
    pages.map((page) => checkPage(page, (sectionCountBySlug[page.slug] ?? 0) > 0)),
  );

  for (const check of checks) {
    if (check.ok) {
      logger.success(
        `${check.title} — HTTP ${check.status}, ${check.widgetCount} widgets.`,
      );
      continue;
    }
    const reason =
      check.note ??
      (check.phpNotices.length > 0
        ? `PHP output: ${check.phpNotices[0]}`
        : `HTTP ${check.status}`);
    logger.warn(`${check.title} — ${reason}`);
  }

  const ok = checks.every((check) => check.ok);
  if (ok) {
    logger.success("All pages verified.");
  } else {
    logger.warn("Some pages did not verify cleanly — see the warnings above.");
  }
  return { checks, ok };
}
