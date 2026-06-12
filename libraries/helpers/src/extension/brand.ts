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
  /** legacy page → extension: open X and fill a draft (dormant) */
  extensionTask: `${EXTENSION_BRAND}:extension-task`,
} as const;

/** Content-script root container id — unique per brand so two extensions on the
 *  same page (e.g. the official Postiz extension) never collide. */
export const EXTENSION_ROOT_ID = `${EXTENSION_BRAND}-extension-root`;
