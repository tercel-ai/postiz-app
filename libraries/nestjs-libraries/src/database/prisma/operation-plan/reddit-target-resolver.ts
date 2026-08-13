import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { SUBREDDIT_NAME_RE as SHARED_SUBREDDIT_NAME_RE } from '@gitroom/nestjs-libraries/engage/engage-scan-target';
import {
  matchRedditFlairLabel,
  RedditChannelCapability,
} from '@gitroom/nestjs-libraries/engage/reddit-channel-capability';

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
//            (EngageTrackedAccount, platform='reddit'). Those are user-curated
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
// restrictions) — that remains an accepted residual failure, and no API exposes
// it either.
//
// A subreddit's flair OPTION SET is now knowable here, but not because anything
// in this module got smarter: Reddit's flair endpoints answer USER_REQUIRED to
// an unauthenticated caller (verified against r/ClaudeAI in a run where
// about.json returned 200, so it is the auth check and not the WAF), and the
// OAuth route that would answer needs API credentials this deployment does not
// have. What DOES see the real option set is the browser extension, which
// Reddit shows the picker to whenever it publishes. Those observations come
// back through EngageTrackedAccount.metadata and reach this module as
// deps.getCapability, so flair data is learned by POSTING, one community at a
// time; a subreddit this org has never published to still resolves exactly as
// it did before (label passed through unverified).
//
// Two things are learned that way, and they travel separately. The option SET
// validates and rewrites the generated label. Whether a community FORCES flair
// rides in `flairRequired`, NOT in `is_flair_required` — that field would make
// the settings DTO demand a `flair: {id, name}` nothing here can supply, so it
// stays hard-false (see its comment). The executor uses `flairRequired` to skip
// a submit it knows will bounce and open Reddit's own page directly.
//
// A rule can only ever be learned as TRUE — a rejection is evidence, a success
// is not evidence of the opposite — so it carries a TTL (REDDIT_RULE_TTL_MS)
// rather than living forever. The first post to a flair-forcing community still
// costs one rejected submit, and so does the first post after each TTL lapse;
// everything in between goes straight to the tab.

// A subreddit name is 3–21 chars of letters/digits/underscore (no hyphen, unlike
// a username). We clamp the min to 2 only to satisfy the DTO's @MinLength(2);
// Reddit itself rejects <3, which the probe's 404 then catches.
// Shared with the scan-target write boundary (engage-scan-target.ts), so a name
// this resolver would reject can no longer be stored as a monitored channel in
// the first place. Two copies previously drifted: the write path validated a
// community key with the reddit USERNAME alphabet, which admits `-` and 30
// chars, so `foo-bar` was storable and then silently dropped from the Tier-1
// pool here.
const SUBREDDIT_NAME_RE = SHARED_SUBREDDIT_NAME_RE;

// Newest post must be at most this old for a Tier-2 candidate to count as
// "alive" — a community nobody has posted to in 48h is not worth seeding into.
export const REDDIT_ACTIVITY_WINDOW_MS = 48 * 60 * 60 * 1000;

// How long an observed POSTING RULE is trusted before it has to be re-earned.
//
// The rule can only ever be learned as `true` (a rejection is evidence; a
// success is not evidence of the opposite, so nothing ever writes `false`).
// Without an expiry, a community whose mods later drop the flair requirement
// would be routed through the browser-tab path forever. Letting the record go
// stale costs exactly one doomed submit per window — after which Reddit either
// rejects again, re-stamping observedAt, or accepts, and the rule stays lapsed.
//
// Deliberately NOT applied to `flairs`: a stale option list still matches most
// labels and its failure mode is a hand-off, whereas a stale rule silently
// changes which publish path is taken.
export const REDDIT_RULE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** True when a capability record's rule observation is still within its TTL. */
export function isRuleObservationFresh(
  observedAt: string | undefined,
  now: number
): boolean {
  if (!observedAt) return false;
  const at = Date.parse(observedAt);
  return Number.isFinite(at) && now - at <= REDDIT_RULE_TTL_MS;
}

// Reddit rejects a submit whose title exceeds 300 chars. The title is the
// content item's themeTitle (usually short), but clamp defensively so a long
// theme can never turn into a submit failure.
const REDDIT_TITLE_MAX = 300;
const clampTitle = (title: string): string =>
  title.length > REDDIT_TITLE_MAX ? title.slice(0, REDDIT_TITLE_MAX) : title;

/**
 * Prefix the subreddit's required title tag ("[D]") onto the post title, then
 * clamp. Idempotent: a title that already carries the tag is left alone, so a
 * re-run during sweeper recovery can't produce "[D] [D] …". Tagging happens HERE
 * rather than in the generated themeTitle because themeTitle is shared by every
 * platform entry of the same content item — prefixing it there would leak "[D]"
 * into the X and LinkedIn copies of the same post.
 */
export function applyTitleTag(
  title: string,
  titleTag: string | null | undefined
): string {
  const tag = (titleTag || '').trim();
  if (!tag) return clampTitle(title);
  if (title.toLowerCase().includes(tag.toLowerCase())) return clampTitle(title);
  return clampTitle(`${tag} ${title}`);
}

/**
 * Canonical bare subreddit name, or null when the input can't be one. Strips a
 * leading `r/` or `/r/`, a trailing slash, surrounding whitespace, then
 * lowercases and validates the charset. Lowercasing is safe: Reddit subreddit
 * lookups are case-insensitive, and storing one canonical form keeps the
 * scan-target key (EngageTrackedAccount.username on reddit rows) stable across
 * paths.
 *
 * Relationship to normalizeUsername('reddit', …): the two agree on every input
 * this one ACCEPTS, with one exception — whitespace between the prefix and the
 * name (`r/ foo`), which this function trims a second time after stripping the
 * prefix and normalizeUsername does not. Nothing feeds a value into both today;
 * the note is here because the equivalence is load-bearing (the write path keys
 * a row through normalizeUsername, this resolver reads it back through here).
 * Unlike normalizeUsername, this one also VALIDATES — null for anything unusable.
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
  /**
   * What a subreddit requires of a post, as last observed by whoever published
   * there — see reddit-channel-capability.ts. Optional: with no source of
   * capability data the resolver behaves exactly as it did before (flair
   * unverified, is_flair_required false), which is also what happens for a
   * subreddit nobody has posted to yet.
   *
   * This is the ONLY way the resolver can learn a flair list. Reddit's flair
   * endpoints answer USER_REQUIRED to unauthenticated callers, so the public
   * probe above — which is all this module can do on its own — cannot read one.
   */
  getCapability?: (subreddit: string) => Promise<RedditChannelCapability>;
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
  /**
   * ALWAYS false, and the literal type is load-bearing rather than lazy.
   *
   * This field is copied verbatim into settings.subreddit[].value, where
   * RedditSettingsDtoInner makes `flair` conditionally REQUIRED on it
   * (`@ValidateIf((e) => e.is_flair_required) @IsDefined() flair`). Nothing here
   * can supply a `flair` — it is `{id, name}` and a flair id is unreadable
   * without OAuth (see this file's header) — so emitting `true` would make
   * every such generated post fail CreatePostDto validation the moment it is
   * saved or re-submitted through mapTypeToPost.
   *
   * Whether a community actually forces flair travels in `flairRequired`
   * below — a carrier outside the DTO-validated `is_flair_required`/`flair`
   * pair, the same sidestep `flairLabel` already makes.
   */
  is_flair_required: false;
  /**
   * Set only when a previous publish was ACTUALLY rejected for a missing flair
   * (the extension reports the SUBMIT_VALIDATION_FLAIR_REQUIRED it saw). Absent
   * means "not observed", never "flair is optional".
   *
   * The executor uses it to skip a blind /api/submit that is guaranteed to be
   * rejected — which today costs two submits and a forced session refresh, since
   * the poster retries once on any error before reading the rejection.
   */
  flairRequired?: true;
  /**
   * The post flair to apply, as a human-readable LABEL — never a flair id (see
   * the OAuth note in this file's header: ids are unreadable from here). Absent
   * when generation proposed none, or when the one proposed is known not to
   * exist in this community.
   *
   * When the subreddit's real option set IS known, this carries REDDIT'S OWN
   * text for the matched option rather than the generated label, so the
   * executor's exact-match pass hits instead of falling through to its
   * decoration-stripping fallback. When it is not known, the generated label is
   * passed through unverified — the executor reconciles it against the live
   * picker, where a wrong label can only fail to match, never select the wrong
   * flair.
   */
  flairLabel?: string;
}

export interface RedditTargetInput {
  // A stable key for logging/attribution (contentId:index); not used in logic.
  key: string;
  // The subreddit the LLM proposed for this post (Tier-2 candidate). May be null.
  llmSubreddit: string | null;
  // The post title Reddit requires — sourced from the content item's themeTitle.
  title: string;
  // Community filing rules the LLM proposed (both may be null): the flair label
  // to carry through to the executor, and the bracketed tag to prefix onto the
  // title. Neither is verified here — see ResolvedRedditTarget.flairLabel.
  llmFlairLabel?: string | null;
  llmTitleTag?: string | null;
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

  // Same injectable clock probeSubreddit uses, so the rule TTL below is as
  // deterministic in tests as the 48h activity window.
  const now = deps.now ?? Date.now;

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

  // Same memoization for the capability lookup, which is a DB read: N posts
  // round-robined onto one channel must not cost N queries. A lookup that
  // throws degrades to "nothing known" rather than failing generation — a plan
  // is still publishable without it, just with an unverified flair.
  const capabilityCache = new Map<string, Promise<RedditChannelCapability>>();
  const capabilityOf = (name: string): Promise<RedditChannelCapability> => {
    let c = capabilityCache.get(name);
    if (!c) {
      const onError = (error: unknown): RedditChannelCapability => {
        deps.log?.(
          `[reddit-target] capability lookup for r/${name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {};
      };
      // try/catch AND .catch: the dep is an injected function, so it can fail
      // synchronously (an object that simply does not implement it) as well as
      // reject. Either way this is an optional enrichment — a plan is still
      // publishable without it, just with an unverified flair, so nothing here
      // is allowed to fail generation.
      try {
        c = Promise.resolve(deps.getCapability?.(name) ?? {}).catch(onError);
      } catch (error) {
        c = Promise.resolve(onError(error));
      }
      capabilityCache.set(name, c);
    }
    return c;
  };

  /**
   * Build the resolved header for one post, folding in whatever is known about
   * the community's posting rules.
   *
   * The flair decision has three outcomes, and the middle one is the point of
   * this whole layer:
   *   - option set known AND the proposed label matches one → carry REDDIT'S
   *     text for that option, so the executor's exact match hits;
   *   - option set known and the label matches NOTHING → drop it. Sending a
   *     label that provably does not exist only makes the executor burn a
   *     match attempt before falling back to the same hand-off;
   *   - option set NOT known (nobody has published here yet) → pass the label
   *     through unverified, exactly as before this layer existed.
   */
  const buildTarget = async (
    subreddit: string,
    input: RedditTargetInput
  ): Promise<ResolvedRedditTarget> => {
    const capability = await capabilityOf(subreddit);
    const proposed = input.llmFlairLabel?.trim() || '';
    const known = capability.flairs?.length ? capability.flairs : undefined;

    let flairLabel: string | undefined;
    if (!proposed) {
      flairLabel = undefined;
    } else if (!known) {
      flairLabel = proposed;
    } else {
      const matched = matchRedditFlairLabel(proposed, known);
      if (matched) {
        flairLabel = matched.label;
      } else {
        deps.log?.(
          `[reddit-target] ${input.key}: flair "${proposed}" is not one of ` +
            `r/${subreddit}'s ${known.length} options; dropping the label`
        );
      }
    }

    return {
      subreddit,
      title: applyTitleTag(input.title, input.llmTitleTag),
      type: 'self',
      // Never the observed value — see ResolvedRedditTarget.is_flair_required
      // for why this field cannot carry it without breaking the settings DTO.
      is_flair_required: false,
      ...(capability.flairRequired === true &&
      isRuleObservationFresh(capability.observedAt, now())
        ? { flairRequired: true as const }
        : {}),
      ...(flairLabel ? { flairLabel } : {}),
    };
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
        target: await buildTarget(channel.name, input),
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
      target: await buildTarget(candidate, input),
    });
  }

  return { outputs, discovered: [...discovered.values()] };
}
