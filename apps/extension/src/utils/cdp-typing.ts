// Types text into whatever element currently has focus in a tab by dispatching
// REAL (isTrusted) key events through the Chrome DevTools Protocol, instead of
// synthetic in-page KeyboardEvents + execCommand.
//
// Medium's own "cannot save your story" anti-tampering detector treats any DOM
// mutation it can't trace back to a genuine trusted keystroke as interference.
// Synthetic page-level events can never be trusted, and layering
// execCommand('insertText', ...) alongside them was verified live to
// sometimes double-insert characters (e.g. a duplicate space rendered as
// "word&nbsp; word") — Publish stayed disabled even though the fill LOOKED
// complete, and the failure was non-deterministic across runs. Dispatching
// through chrome.debugger goes through the browser's real input pipeline —
// the same code path a physical keystroke takes — so the page sees a single,
// correctly-timed, trusted keydown/keypress/beforeinput/input sequence per
// character, exactly like a human typing. No execCommand, no manual 'input'
// event dispatch, and no per-key virtual-keycode table is needed even for
// CJK/symbols: Chrome synthesizes the right native insertion whenever a
// keyDown event carries a `text` payload.

const CDP_PROTOCOL_VERSION = '1.3';
const KEY_DELAY_MS = 12;

/** Attach the DevTools protocol to a tab. Shows Chrome's "being debugged" infobar. */
export async function attachDebugger(tabId: number): Promise<boolean> {
  try {
    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    return true;
  } catch (e) {
    console.warn('[aisee][cdp] attach failed', e);
    return false;
  }
}

/** Best-effort detach — also clears Chrome's "being debugged" infobar. */
export async function detachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {
    // Already detached (e.g. the user dismissed the infobar themselves) — fine.
  }
}

async function dispatchKey(
  tabId: number,
  params: Record<string, unknown>
): Promise<void> {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', params);
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Type `text` character-by-character into whatever element the page currently
 * has focused (the caller is responsible for focusing the right field first).
 * Requires an active chrome.debugger session on `tabId` (see attachDebugger).
 */
export async function cdpTypeText(tabId: number, text: string): Promise<void> {
  for (const ch of text) {
    if (ch === '\n') {
      const opts = {
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      };
      await dispatchKey(tabId, { type: 'rawKeyDown', ...opts });
      await dispatchKey(tabId, { type: 'keyUp', ...opts });
    } else {
      await dispatchKey(tabId, { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
      await dispatchKey(tabId, { type: 'keyUp', key: ch });
    }
    await sleepMs(KEY_DELAY_MS);
  }
}
