import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';

// Reddit posting is not "content-only" like X: the submit API (reddit.provider
// `post()`) hard-requires a target subreddit, a title, and a post `type`, and
// the settings DTO (RedditSettingsDtoInner) marks subreddit/title/type as
// @IsDefined(). Operation-plan generation, however, only produced free-form
// content — so every generated Reddit post was unpublishable. This resolver
// fills that gap by attaching a validated subreddit to each generated Reddit
// post BEFORE it is materialized, and dropping the post when no valid target can
// be found (rather than emitting a draft that can never publish).
//
// Two tiers, by design (see the design discussion):
//   Tier 1 — the project's Engage config already monitors Reddit channels
//            (EngageMonitoredChannel, platform='reddit'). Those are user-curated
//            and already the project's chosen communities, so we trust them and
//            only probe to learn the submission type (self vs link-only).
//   Tier 2 — no monitored channels: the LLM proposes a subreddit, which we
//            VALIDATE against Reddit's public API (existence + public + accepts
//            text posts + active in the last 48h). A validated Tier-2 subreddit
//            is persisted back into the Engage config so the next plan takes the
//            cheaper Tier-1 path and Engage scanning picks it up.
//
// Everything here is OAuth-free: it rides the same public *.reddit.com/*.json
// endpoints (loid + proxy WAF-bypass) the Engage scanner already uses, via
// redditPublicGet. That means it can verify a community exists and is alive, but
// it CANNOT prove this account may post there (karma/age gates, approved-user
// restrictions) or read a subreddit's flair requirements — those need OAuth. So
// is_flair_required is always emitted false; a subreddit that silently forces
// flair remains an accepted residual failure (documented, not solved here).

// A subreddit name is 3–21 chars of letters/digits/underscore (no hyphen, unlike
// a username). We clamp the min to 2 only to satisfy the DTO's @MinLength(2);
// Reddit itself rejects <3, which the probe's 404 then catches.
const SUBREDDIT_NAME_RE = /^[a-z0-9_]{2,21}$/;

// Newest post must be at most this old for a Tier-2 candidate to count as
// "alive" — a community nobody has posted to in 48h is not worth seeding into.
export const REDDIT_ACTIVITY_WINDOW_MS = 48 * 60 * 60 * 1000;

// Reddit rejects a submit whose title exceeds 300 chars. The title is the
// content item's themeTitle (usually short), but clamp defensively so a long
// theme can never turn into a submit failure.
const REDDIT_TITLE_MAX = 300;
const clampTitle = (title: string): string =>
  title.length > REDDIT_TITLE_MAX ? title.slice(0, REDDIT_TITLE_MAX) : title;

/**
 * Canonical bare subreddit name, or null when the input can't be one. Strips a
 * leading `r/` or `/r/`, a trailing slash, surrounding whitespace, then
 * lowercases and validates the charset. Lowercasing is safe: Reddit subreddit
 * lookups are case-insensitive, and storing one canonical form keeps the
 * EngageMonitoredChannel key (channelId) stable across paths.
 */
export function normalizeSubreddit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
  return SUBREDDIT_NAME_RE.test(name) ? name : null;
}

export interface SubredditProbe {
  // Both public calls completed (no WAF block / network failure). When false the
  // other flags are meaningless — a trusted Tier-1 channel is kept regardless,
  // an unverifiable Tier-2 candidate is rejected.
  reachable: boolean;
  // about.json returned a subreddit (HTTP 200 with data). false = 404/banned.
  exists: boolean;
  // subreddit_type === 'public' — restricted/private/employees-only can't be
  // posted to by an arbitrary account.
  isPublic: boolean;
  // submission_type allows a text (self) post. 'link'-only communities can't
  // take our generated text content.
  allowsSelf: boolean;
  // Newest post is within REDDIT_ACTIVITY_WINDOW_MS.
  active48h: boolean;
}

// The subset of a fetch-like Response redditPublicGet exposes.
type PublicGet = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RedditTargetResolverDeps {
  // Injectable for tests; defaults to the real WAF-bypassing public fetch.
  fetchPublic?: PublicGet;
  // Injectable clock for deterministic 48h-window tests.
  now?: () => number;
  log?: (message: string) => void;
}

async function readJson(
  fetchPublic: PublicGet,
  url: string
): Promise<{ status: number; json: any | null }> {
  const res = await fetchPublic(url);
  if (!res.ok) return { status: res.status, json: null };
  try {
    return { status: res.status, json: JSON.parse(await res.text()) };
  } catch {
    // A 200 whose body isn't JSON is a WAF interstitial masquerading as success;
    // treat it as unreachable, not as "exists".
    return { status: res.status, json: null };
  }
}

/**
 * Probe a subreddit over Reddit's public API. Never throws: any transport error
 * degrades to `reachable: false` so callers decide by tier.
 */
export async function probeSubreddit(
  name: string,
  deps: RedditTargetResolverDeps = {}
): Promise<SubredditProbe> {
  const fetchPublic = deps.fetchPublic ?? (redditPublicGet as unknown as PublicGet);
  const now = deps.now ?? Date.now;
  const fail: SubredditProbe = {
    reachable: false,
    exists: false,
    isPublic: false,
    allowsSelf: false,
    active48h: false,
  };
  try {
    const about = await readJson(
      fetchPublic,
      `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`
    );
    if (about.status === 404) {
      // A definitive answer: the subreddit does not exist / is banned.
      return { ...fail, reachable: true };
    }
    const data = about.json?.data;
    if (!data) return fail; // WAF/transport — unreachable, unknown.

    const subredditType = String(data.subreddit_type ?? '');
    const submissionType = String(data.submission_type ?? '');
    const isPublic = subredditType === 'public';
    const allowsSelf = submissionType === 'self' || submissionType === 'any' || submissionType === '';

    const listing = await readJson(
      fetchPublic,
      `https://www.reddit.com/r/${encodeURIComponent(name)}/new.json?limit=1`
    );
    const newest = listing.json?.data?.children?.[0]?.data?.created_utc;
    const active48h =
      typeof newest === 'number' &&
      now() - newest * 1000 <= REDDIT_ACTIVITY_WINDOW_MS;

    return { reachable: true, exists: true, isPublic, allowsSelf, active48h };
  } catch (error) {
    deps.log?.(
      `[reddit-target] probe r/${name} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return fail;
  }
}

// A monitored Reddit channel as read from EngageConfig (the subset we use).
export interface MonitoredRedditChannel {
  channelId: string; // the bare subreddit name (scan-unit key)
  channelName: string;
  audienceSize: number;
  enabled: boolean;
}

// The reddit-specific header attached to a generated post once resolved. Mirrors
// exactly what materializePlanPosts folds into settings.subreddit[].value.
export interface ResolvedRedditTarget {
  subreddit: string;
  title: string;
  type: 'self';
  is_flair_required: false;
}

export interface RedditTargetInput {
  // A stable key for logging/attribution (contentId:index); not used in logic.
  key: string;
  // The subreddit the LLM proposed for this post (Tier-2 candidate). May be null.
  llmSubreddit: string | null;
  // The post title Reddit requires — sourced from the content item's themeTitle.
  title: string;
}

export interface RedditTargetOutput {
  key: string;
  // null = drop this Reddit post (no valid target).
  target: ResolvedRedditTarget | null;
}

export interface ResolveRedditTargetsResult {
  outputs: RedditTargetOutput[];
  // Tier-2 subreddits that validated and are NOT already monitored — the caller
  // persists these back into the Engage config (channelId = subreddit).
  discovered: { subreddit: string }[];
}

/**
 * Resolve a subreddit for each generated Reddit post.
 *
 * `monitoredChannels` is the project's enabled Reddit channels (empty, or all
 * unpostable, ⇒ Tier 2 for every post). The Tier-1 pool is pre-validated once so
 * round-robin only ever lands on postable channels. Probing is deduplicated per
 * subreddit so N posts targeting the same community cost one probe. Deterministic
 * given the same inputs + probe results (round-robins the surviving Tier-1
 * channels by input order), so a re-run during sweeper recovery reaches the same
 * assignment.
 */
export async function resolveRedditTargets(
  inputs: RedditTargetInput[],
  monitoredChannels: MonitoredRedditChannel[],
  deps: RedditTargetResolverDeps = {}
): Promise<ResolveRedditTargetsResult> {
  if (!inputs.length) return { outputs: [], discovered: [] };

  // Tier-1 pool: enabled channels with a valid subreddit name, ordered by reach
  // (largest audience first) so the highest-value communities are used first,
  // then round-robined across posts to spread rather than dogpile one sub.
  const pool = monitoredChannels
    .filter((c) => c.enabled)
    .map((c) => ({ ...c, name: normalizeSubreddit(c.channelId) }))
    .filter((c): c is typeof c & { name: string } => c.name !== null)
    .sort((a, b) => b.audienceSize - a.audienceSize);
  const monitoredNames = new Set(pool.map((c) => c.name));

  // One probe per distinct subreddit, memoized.
  const probeCache = new Map<string, Promise<SubredditProbe>>();
  const probe = (name: string) => {
    let p = probeCache.get(name);
    if (!p) {
      p = probeSubreddit(name, deps);
      probeCache.set(name, p);
    }
    return p;
  };

  // Pre-validate the Tier-1 pool ONCE, up front, keeping only channels that can
  // actually take a text post. This is what makes round-robin safe: a post is
  // dropped only when EVERY monitored channel is unpostable — never merely
  // because its round-robin slot happened to land on a bad one while a good
  // channel sat unused. An UNREACHABLE probe keeps the channel (trust the
  // curation); only a definitive reachable verdict (link-only / not public /
  // gone) removes it.
  const tier1Pool: { name: string }[] = [];
  for (const channel of pool) {
    const p = await probe(channel.name);
    const postable = !p.reachable || (p.exists && p.isPublic && p.allowsSelf);
    if (postable) {
      tier1Pool.push(channel);
    } else {
      deps.log?.(
        `[reddit-target] monitored r/${channel.name} is unpostable ` +
          `(exists=${p.exists} public=${p.isPublic} self=${p.allowsSelf}); excluded from pool`
      );
    }
  }
  // Tier 1 only when at least one monitored channel survived validation. When
  // the project monitors Reddit but every channel is dead/link-only, fall through
  // to Tier 2 (validate the LLM's proposal) rather than drop every Reddit post.
  const useTier1 = tier1Pool.length > 0;

  const outputs: RedditTargetOutput[] = [];
  const discovered = new Map<string, { subreddit: string }>();

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];

    if (useTier1) {
      // Assign a validated curated channel, round-robined by input order.
      const channel = tier1Pool[i % tier1Pool.length];
      outputs.push({
        key: input.key,
        target: {
          subreddit: channel.name,
          title: clampTitle(input.title),
          type: 'self',
          is_flair_required: false,
        },
      });
      continue;
    }

    // Tier 2: validate the LLM's proposal against the public API.
    const candidate = normalizeSubreddit(input.llmSubreddit);
    if (!candidate) {
      deps.log?.(`[reddit-target] ${input.key}: no valid subreddit proposed; dropping`);
      outputs.push({ key: input.key, target: null });
      continue;
    }
    const p = await probe(candidate);
    const accepted =
      p.reachable && p.exists && p.isPublic && p.allowsSelf && p.active48h;
    if (!accepted) {
      deps.log?.(
        `[reddit-target] ${input.key}: r/${candidate} failed validation ` +
          `(reachable=${p.reachable} exists=${p.exists} public=${p.isPublic} ` +
          `self=${p.allowsSelf} active48h=${p.active48h}); dropping`
      );
      outputs.push({ key: input.key, target: null });
      continue;
    }
    if (!monitoredNames.has(candidate)) {
      discovered.set(candidate, { subreddit: candidate });
    }
    outputs.push({
      key: input.key,
      target: {
        subreddit: candidate,
        title: clampTitle(input.title),
        type: 'self',
        is_flair_required: false,
      },
    });
  }

  return { outputs, discovered: [...discovered.values()] };
}
