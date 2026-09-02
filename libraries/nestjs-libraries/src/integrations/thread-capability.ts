import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  EXTENSION_PUBLISHABLE_PLATFORMS,
  SINGLE_SEGMENT_PLATFORMS,
} from '@gitroom/helpers/extension/post-publish';

/**
 * Whether a platform can publish a NATIVE THREAD — an anchor post followed by
 * parts 2..N that chain beneath it (an X thread, Reddit follow-up comments, a
 * LinkedIn comment chain, HN comment follow-ups).
 *
 * ONE definition for the whole app, because a post has TWO possible publish
 * paths and neither one alone answers the question:
 *
 *  - the server/API path chains through the provider's own `comment()`
 *    implementation (the same flag `isCommentable` checks at publish time);
 *  - the browser-extension path chains segments in-browser, and rejects a
 *    multi-segment item only for `SINGLE_SEGMENT_PLATFORMS` (article/long-form
 *    surfaces where a thread has no meaning).
 *
 * A platform is threadable when EITHER path can chain it. Using the `comment()`
 * capability alone — as this used to, in operation-plan.service.ts — silently
 * called Hacker News unthreadable: HN has NO write API at all (its provider's
 * `post()` throws by design), so every HN post goes out through the extension,
 * which chains HN follow-ups perfectly well.
 *
 * Takes a PROVIDER IDENTIFIER (`x`, `reddit`, `linkedin`, `hackernews`, …).
 * Callers holding a platform in another vocabulary normalize first — e.g.
 * engage's `normalizeEngagePlatform` maps its legacy `twitter` onto `x`.
 */
export function isThreadCapablePlatform(platform: string): boolean {
  if (!platform) return false;

  // Article/long-form surfaces: not threadable on ANY path, whatever else
  // says. Checked first so a provider that happens to expose `comment()` for
  // some other purpose can never re-enable threads on one of them.
  if ((SINGLE_SEGMENT_PLATFORMS as readonly string[]).includes(platform)) {
    return false;
  }

  if ((EXTENSION_PUBLISHABLE_PLATFORMS as readonly string[]).includes(platform)) {
    return true;
  }

  return !!socialIntegrationList.find((p) => p.identifier === platform)?.comment;
}

/** The threadable subset of `platforms`, order preserved. */
export function threadCapablePlatforms(platforms: string[]): string[] {
  return platforms.filter(isThreadCapablePlatform);
}
