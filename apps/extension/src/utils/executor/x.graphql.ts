// Low-level X (Twitter) internal GraphQL client, used with the user's logged-in
// session. The extension can't use the documented v2 API (that needs OAuth app
// tokens and is exactly the tier-block being bypassed), so scan + metrics go
// through x.com's INTERNAL GraphQL the way the web client does:
//   - Authorization: the public web bearer (a long-lived client constant).
//   - x-csrf-token: the `ct0` cookie value, echoed back per X's CSRF scheme.
//   - credentials:'include': sends the `auth_token` + `ct0` session cookies.
//
// ⚠️ BRITTLE BY NATURE: the per-operation queryId and the `features` set are
// undocumented and X rotates them; a stale value yields 404 (bad queryId) or
// 400 (missing feature). Everything here fails GRACEFULLY (logs + returns null)
// so a broken X path never crashes the scan/metrics loop or the Reddit path.
// When X changes them, update X_QUERIES + X_SEARCH_FEATURES below.

// Public web-app bearer. Stable for years; shared by all unauthenticated &
// session web requests (the per-user identity comes from the cookies).
const X_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const X_GRAPHQL_BASE = 'https://x.com/i/api/graphql';

// Operation name → queryId. These ROTATE — update when X returns 404s.
export const X_QUERIES = {
  SearchTimeline: 'nK1dw4oV3k4w5TdtcAdSww',
  TweetResultByRestId: '0hWvDhmW8YQ-S_ib3azIrw',
} as const;

/** Read the `ct0` (CSRF) cookie X sets for the logged-in session. */
async function getCt0(): Promise<string | null> {
  try {
    const c = await chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' });
    if (c?.value) return c.value;
    // Fallback: some sessions only carry it on the twitter.com origin.
    const t = await chrome.cookies.get({
      url: 'https://twitter.com/',
      name: 'ct0',
    });
    return t?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Issue an authenticated GET GraphQL call. Returns the parsed `data` object, or
 * null on any failure (no session, missing ct0, non-2xx, unparseable body).
 */
export async function xGraphqlGet<T = any>(
  operation: keyof typeof X_QUERIES,
  params: {
    variables: Record<string, unknown>;
    features?: Record<string, unknown>;
    fieldToggles?: Record<string, unknown>;
  }
): Promise<T | null> {
  const ct0 = await getCt0();
  if (!ct0) {
    console.warn('[aisee][x] no ct0 cookie — user not logged into x.com?');
    return null;
  }

  const qs = new URLSearchParams();
  qs.set('variables', JSON.stringify(params.variables));
  if (params.features) qs.set('features', JSON.stringify(params.features));
  if (params.fieldToggles)
    qs.set('fieldToggles', JSON.stringify(params.fieldToggles));

  const url = `${X_GRAPHQL_BASE}/${X_QUERIES[operation]}/${operation}?${qs.toString()}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Authorization: `Bearer ${X_WEB_BEARER}`,
        'x-csrf-token': ct0,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': 'en',
        'content-type': 'application/json',
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      console.warn(`[aisee][x] ${operation} rate-limited (429)`);
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[aisee][x] ${operation} ${res.status} (queryId/features may be stale): ${body.slice(0, 200)}`
      );
      return null;
    }
    const json = await res.json();
    return (json?.data ?? null) as T | null;
  } catch (e) {
    console.warn(`[aisee][x] ${operation} fetch failed`, e);
    return null;
  }
}

// A reasonably complete SearchTimeline feature set. X 400s on MISSING features,
// so this errs toward including them; update as X adds/removes flags.
export const X_SEARCH_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};
