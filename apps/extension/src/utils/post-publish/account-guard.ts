// Publish-time guard against posting as the WRONG account.
//
// The extension publishes in-browser with whatever session the browser is
// logged into. That session is not necessarily the account the post was
// composed for: the user picks an account in the web editor, but the browser
// may be logged into a different one on that platform. Posting to the wrong
// account cannot be undone, so the queue refuses to publish on a mismatch
// rather than surfacing it afterwards.
//
// This is the LAST line of defence and the only one that always applies —
// scheduled posts and batch publishes never pass through the web editor, so a
// check there alone would leave them unguarded.

import type {
  PublishPostItem,
  PublishTargetAccount,
} from '@gitroom/helpers/extension/post-publish';
import {
  probeSessionAccount,
  type SessionAccountProbe,
} from '@gitroom/extension/utils/social-sessions';

/**
 * Compare account ids across sources that spell the same account differently:
 * Reddit's Integration carries the bare base36 id (`abc123`) while a browser
 * session reports the `t2_`-prefixed fullname (`t2_abc123`). Case is ignored
 * because these ids are case-insensitive in practice on both platforms.
 *
 * The @ / u/ stripping matters for the extension-only platforms, where the
 * Integration's `internalId` IS the username (hackernews / medium / quora
 * connect with just a handle). Providers normalize it on the way in, but a
 * historical row may still carry the @ — and a false MISMATCH there would block
 * a legitimate post, so strip on both sides. Real numeric ids never carry these
 * prefixes, so this cannot collapse two distinct accounts.
 */
export function normalizeAccountId(raw: string | undefined | null): string {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/^t2_/, '')
    .replace(/^@/, '')
    .replace(/^\/?u\//, '');
}

/** Strip the decorations each platform puts in front of a username. */
export function normalizeHandle(raw: string | undefined | null): string {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^u\//, '')
    .replace(/^\/?u\//, '');
}

/** How the target account should be named in a message to the user. */
function describeTarget(target: PublishTargetAccount): string {
  if (target.handle) return `@${normalizeHandle(target.handle)}`;
  if (target.name) return target.name;
  return `account ${target.id}`;
}

/** How the live session should be named in a message to the user. */
function describeSession(probe: SessionAccountProbe): string {
  if (probe.handle) return `@${normalizeHandle(probe.handle)}`;
  if (probe.id) return `account ${probe.id}`;
  return 'a different account';
}

export interface AccountGuardResult {
  /** True when publishing may proceed. */
  ok: boolean;
  /** User-facing reason, set only when `ok` is false. */
  error?: string;
}

const ALLOW: AccountGuardResult = { ok: true };

/**
 * Decide whether `item` may publish with the browser's current session.
 *
 * Allows (deliberately) when:
 *   - the post carries no targetAccount — no bound account, so "whoever is
 *     logged in" IS the intent (operation-plan posts publish by platform);
 *   - the platform has no session probe — an unknown session is not evidence of
 *     a mismatch, and failing every such post would take the feature offline;
 *   - the session reports no id — same reason: cannot conclude a mismatch. When
 *     a handle is available on both sides it is compared as a fallback, since
 *     that IS evidence.
 *
 * Blocks when the platform is logged out (nothing would publish anyway, and the
 * reason is actionable) or when the ids/handles genuinely disagree.
 */
export async function checkPublishAccount(
  item: PublishPostItem
): Promise<AccountGuardResult> {
  const target = item.targetAccount;
  if (!target || !target.id) return ALLOW;

  let probe: SessionAccountProbe;
  try {
    probe = await probeSessionAccount(item.platform);
  } catch (e) {
    // A probe failure is not evidence of a mismatch. Publishing as intended is
    // the far more likely case, and blocking here would make a cookie-API
    // hiccup look like a wrong-account error.
    //
    // Logged because this is one of only two ways a post goes out WITHOUT the
    // account being verified. A wrong-account publish is irreversible and gets
    // reported after the fact, so "was the guard able to check?" has to be
    // answerable from the log — otherwise it reads identically to a pass.
    console.warn(
      '[aisee][guard] session probe failed — publishing unverified',
      { taskId: item.taskId, platform: item.platform },
      e
    );
    return ALLOW;
  }

  if (!probe.supported) return ALLOW;

  if (!probe.loggedIn) {
    return {
      ok: false,
      error: `Not logged in to ${item.platform} in this browser. This post publishes as ${describeTarget(
        target
      )} — sign in to that account and it will go out on the next attempt.`,
    };
  }

  const targetId = normalizeAccountId(target.id);
  const sessionId = normalizeAccountId(probe.id);

  if (sessionId) {
    if (sessionId === targetId) return ALLOW;
    return {
      ok: false,
      error: `Wrong ${item.platform} account: this browser is signed in as ${describeSession(
        probe
      )}, but the post is for ${describeTarget(
        target
      )}. Switch accounts to publish it — nothing was posted.`,
    };
  }

  // No id from the session. A handle on both sides is still real evidence, so
  // use it; otherwise there is nothing to compare and the post proceeds.
  const targetHandle = normalizeHandle(target.handle);
  const sessionHandle = normalizeHandle(probe.handle);
  if (targetHandle && sessionHandle && targetHandle !== sessionHandle) {
    return {
      ok: false,
      error: `Wrong ${item.platform} account: this browser is signed in as @${sessionHandle}, but the post is for @${targetHandle}. Switch accounts to publish it — nothing was posted.`,
    };
  }

  // The second fail-open exit: signed in, but the session named neither a
  // comparable id nor a comparable handle. Same reason as the probe-throw
  // above — the post publishes without the account ever being verified, and
  // that must be distinguishable in the log from a real match.
  console.warn(
    '[aisee][guard] session account unresolved — publishing unverified',
    { taskId: item.taskId, platform: item.platform }
  );
  return ALLOW;
}
