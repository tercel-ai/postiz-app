// Fetch live metrics for a published Quora post/answer by opening its page in a
// background tab (user's own session) and scraping the rendered counters —
// Quora has no public read API. Shaped as the AnalyticsData series the backend's
// extractMetrics / traffic pipeline consumes.
//
// This drives quora.com with the user's personal session, which Quora flags
// aggressively. The gate is server-side: the /posts/metrics/due response only
// includes Quora posts when the platform is in the backend scan allowlist.

import { AnalyticsSeries } from './executor.types';
import { closeTab, openTab, runInPage } from '@gitroom/extension/utils/tab-automation';

const RENDER_SETTLE_MS = 2_500;
const NOW_ISO = () => new Date().toISOString();

function point(total: number): AnalyticsSeries['data'] {
  return [{ total, date: NOW_ISO() }];
}

interface ScrapedQuoraMetrics {
  found: boolean;
  upvotes: number | null;
  views: number | null;
}

/**
 * Runs INSIDE the quora.com page (self-contained). Heuristically reads the
 * upvote count (near the upvote button) and the view count ("N views"). Quora's
 * markup is an unstable, obfuscated SPA, so this is best-effort with fallbacks.
 */
function scrapeQuoraMetricsInPage(): ScrapedQuoraMetrics {
  const parse = (raw: string | null | undefined): number | null => {
    if (!raw) return null;
    const m = String(raw).replace(/[,\s]/g, '').match(/^(\d+(?:\.\d+)?)([KM])?$/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const s = (m[2] || '').toUpperCase();
    if (s === 'K') n *= 1000;
    else if (s === 'M') n *= 1000000;
    return Math.round(n);
  };
  const firstNumber = (s: string | null | undefined): number | null =>
    parse((s || '').match(/(\d[\d.,]*[KM]?)/i)?.[1]);

  // Upvotes: the upvote control carries an aria-label containing "upvote"; the
  // count sits on the button or an adjacent node.
  let upvotes: number | null = null;
  const upBtn =
    document.querySelector<HTMLElement>('[aria-label*="upvote" i]') ||
    document.querySelector<HTMLElement>('button[class*="upvote" i]');
  if (upBtn) {
    upvotes =
      firstNumber(upBtn.textContent) ??
      firstNumber(upBtn.getAttribute('aria-label')) ??
      firstNumber(upBtn.parentElement?.textContent) ??
      null;
  }

  // Views: rendered as "1.2K views" somewhere in the answer footer/meta.
  let views: number | null = null;
  const viewEl = Array.from(
    document.querySelectorAll<HTMLElement>('a, span, div')
  ).find((el) => /\bviews?\b/i.test(el.textContent || '') && (el.textContent || '').length < 40);
  if (viewEl) {
    views = firstNumber(viewEl.textContent);
  }

  return { found: upvotes != null || views != null, upvotes, views };
}

export async function fetchQuoraMetrics(
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const url = String(releaseURL || '').trim();
  if (!/^https?:\/\/([a-z0-9-]+\.)?quora\.com\//i.test(url)) return null;

  const handle = await openTab(url, { settleMs: RENDER_SETTLE_MS });
  if (!handle) return null;
  try {
    const raw = await runInPage(handle.tabId, scrapeQuoraMetricsInPage);
    if (!raw?.found) return null;
    const series: AnalyticsSeries[] = [];
    if (raw.upvotes != null)
      series.push({ label: 'upvotes', data: point(raw.upvotes) });
    if (raw.views != null)
      series.push({ label: 'impressions', data: point(raw.views) });
    return series.length ? series : null;
  } finally {
    await closeTab(handle.tabId);
  }
}
