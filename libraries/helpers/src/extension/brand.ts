// Single source of truth for the browser-extension brand + the postMessage
// protocol shared between the web app (apps/frontend) and the extension
// (apps/extension). BOTH sides import these, so the handshake can never drift.
//
// To rebrand: change EXTENSION_BRAND — every protocol string, the content-script
// root id, etc. derive from it. (Exception: the MAIN-world globals injected into
// x.com via executeScript must be string literals because the function is
// serialized — they live in apps/extension/src/pages/background/x.poster.ts and
// are extension-internal, so they don't need to match this value.)

export const EXTENSION_BRAND = 'aisee';

export const EXTENSION_MESSAGE = {
  /** source tag on page → extension messages */
  source: EXTENSION_BRAND, // 'aisee'
  /** page → extension: post an Engage reply */
  engageReply: `${EXTENSION_BRAND}:engage-reply`,
  /** source tag on extension → page result messages */
  resultSource: `${EXTENSION_BRAND}-extension`, // 'aisee-extension'
  /** extension → page: reply result (carries permalink + backfilled flag) */
  engageReplyResult: `${EXTENSION_BRAND}:engage-reply-result`,
  /** page → extension: run the authenticated user's due Engage scan loop */
  engageScan: `${EXTENSION_BRAND}:engage-scan`,
  /** extension → page: completed scan-loop summary or error */
  engageScanResult: `${EXTENSION_BRAND}:engage-scan-result`,
  /** page → extension: scrape one published reply's own metrics (by release URL) */
  engageMetrics: `${EXTENSION_BRAND}:engage-metrics`,
  /** extension → page: scraped reply metrics result (carries raw counters or error) */
  engageMetricsResult: `${EXTENSION_BRAND}:engage-metrics-result`,
  /** legacy page → extension: open X and fill a draft (dormant) */
  extensionTask: `${EXTENSION_BRAND}:extension-task`,
  /** page → extension: presence probe */
  ping: `${EXTENSION_BRAND}:ping`,
  /** extension → page: presence acknowledgement */
  pong: `${EXTENSION_BRAND}:pong`,
} as const;

/** Content-script root container id — unique per brand so two extensions on the
 *  same page (e.g. the official Postiz extension) never collide. */
export const EXTENSION_ROOT_ID = `${EXTENSION_BRAND}-extension-root`;
