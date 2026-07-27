// Fetch live metrics for a published Medium story by opening its page in a
// background tab (user's own session) and scraping the rendered engagement
// counters — Medium has no public read API. Shaped as the AnalyticsData series
// the backend's extractMetrics / traffic pipeline consumes.
//
// OFF BY DEFAULT (ENGAGE_MEDIUM_ENABLED) — this drives medium.com with the
// user's personal session, which Medium flags like the other risk-controlled
// platforms. The metrics.runner gates on the same flag before calling this.

import { AnalyticsSeries } from './executor.types';
import { closeTab, openTab, runInPage } from '@gitroom/extension/utils/tab-automation';

const RENDER_SETTLE_MS = 2_500;
const NOW_ISO = () => new Date().toISOString();

function point(total: number): AnalyticsSeries['data'] {
  return [{ total, date: NOW_ISO() }];
}

/**
 * Parse a compact engagement count like "1.2K" / "3.4M" / "857" into a number.
 * Returns null when the text isn't a recognizable count (so a missing counter
 * is dropped, never reported as 0).
 */
export function parseCompactNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = String(raw)
    .replace(/[,\s]/g, '')
    .match(/^(\d+(?:\.\d+)?)([KM])?$/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') n *= 1_000;
  else if (suffix === 'M') n *= 1_000_000;
  return Math.round(n);
}

interface ScrapedMediumMetrics {
  found: boolean;
  claps: number | null;
  responses: number | null;
}

/**
 * Runs INSIDE the medium.com article page (self-contained). Heuristically reads
 * the claps count (near the applause button) and the responses count. Medium's
 * markup is an unstable SPA, so this is best-effort with several fallbacks.
 */
function scrapeMediumMetricsInPage(): ScrapedMediumMetrics {
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

  // Claps: the applause button carries an aria-label like "clap"; the count is
  // rendered right next to it. Probe the button, its parent, and siblings.
  let claps: number | null = null;
  const clapBtn =
    document.querySelector<HTMLElement>('button[aria-label*="clap" i]') ||
    document.querySelector<HTMLElement>('button[data-testid*="clap" i]');
  if (clapBtn) {
    const candidates: (string | null | undefined)[] = [
      clapBtn.textContent,
      clapBtn.getAttribute('aria-label'),
      clapBtn.parentElement?.textContent,
      clapBtn.nextElementSibling?.textContent,
      clapBtn.parentElement?.nextElementSibling?.textContent,
    ];
    for (const c of candidates) {
      const n = parse((c || '').match(/(\d[\d.,]*[KM]?)/i)?.[1]);
      if (n != null) {
        claps = n;
        break;
      }
    }
  }

  // Responses: a link/button referencing responses with a leading number.
  let responses: number | null = null;
  const respEl =
    document.querySelector<HTMLElement>('a[href*="responses" i]') ||
    Array.from(document.querySelectorAll<HTMLElement>('button, a')).find((el) =>
      /response/i.test(el.textContent || '')
    ) ||
    null;
  if (respEl) {
    responses = parse((respEl.textContent || '').match(/(\d[\d.,]*[KM]?)/i)?.[1]);
  }

  return { found: claps != null || responses != null, claps, responses };
}

export async function fetchMediumMetrics(
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const url = String(releaseURL || '').trim();
  if (!/^https?:\/\/([a-z0-9-]+\.)?medium\.com\//i.test(url)) return null;

  const handle = await openTab(url, { settleMs: RENDER_SETTLE_MS });
  if (!handle) return null;
  try {
    const raw = await runInPage(handle.tabId, scrapeMediumMetricsInPage);
    if (!raw?.found) return null;
    const series: AnalyticsSeries[] = [];
    if (raw.claps != null) series.push({ label: 'claps', data: point(raw.claps) });
    if (raw.responses != null)
      series.push({ label: 'comments', data: point(raw.responses) });
    return series.length ? series : null;
  } finally {
    await closeTab(handle.tabId);
  }
}
