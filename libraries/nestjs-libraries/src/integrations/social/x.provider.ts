import { PrismaClient } from '@prisma/client';
import { TweetV2, TwitterApi } from 'twitter-api-v2';
import {
  AccountMetrics,
  AnalyticsData,
  AuthTokenDetails,
  BatchPostAnalyticsResult,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { lookup } from 'mime-types';
import sharp from 'sharp';
import { readOrFetch } from '@gitroom/helpers/utils/read.or.fetch';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Plug } from '@gitroom/helpers/decorators/plug.decorator';
import { Integration } from '@prisma/client';
import { timer } from '@gitroom/helpers/utils/timer';
import { PostPlug } from '@gitroom/helpers/decorators/post.plug';
import dayjs from 'dayjs';
import { uniqBy } from 'lodash';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { XDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/x.dto';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { mergeAdditionalSettings, parseAdditionalSettings } from '@gitroom/nestjs-libraries/database/prisma/integrations/additional-settings.utils';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import {
  ioRedis,
  notifyOncePerCooldown,
} from '@gitroom/nestjs-libraries/redis/redis.service';

@Rules(
  'X can have maximum 4 pictures, or maximum one video, it can also be without attachments'
)
export class XProvider extends SocialAbstract implements SocialProvider {
  private static _prismaInstance: PrismaClient | null = null;
  private static get _prisma(): PrismaClient {
    if (!XProvider._prismaInstance) {
      XProvider._prismaInstance = new PrismaClient();
    }
    return XProvider._prismaInstance;
  }

  identifier = 'x';
  name = 'X';
  isBetweenSteps = false;
  scopes = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
  // OAuth 2.0 access tokens expire in ~2 hours; start the Temporal refresh workflow
  // so tokens are rotated proactively and never actually expire in practice.
  // OAuth 1.0a tokens are detected by isTokenPermanent() and bypassed entirely.
  refreshCron = true;
  override maxConcurrentJob = 1; // X has strict rate limits (300 posts per 3 hours)
  toolTip =
    'You will be logged in into your current account, if you would like a different account, change it first on X';

  editor = 'normal' as const;
  dto = XDto;

  /**
   * Detect whether a stored access token is in OAuth 1.0a format ("accessToken:accessSecret").
   * OAuth 1.0a tokens are permanent and must never be sent to the OAuth 2.0 refresh endpoint.
   * OAuth 2.0 bearer tokens are long alphanumeric strings without an embedded colon.
   */
  static isOAuth1Token(token: string): boolean {
    if (!token) return false;
    const colonIdx = token.indexOf(':');
    return colonIdx > 0 && token.length > colonIdx + 1;
  }

  /**
   * OAuth 1.0a tokens never expire, so the generic expiry / refresh logic must be skipped.
   */
  isTokenPermanent(token: string): boolean {
    return XProvider.isOAuth1Token(token);
  }

  /**
   * Build the appropriate TwitterApi client for the given access token.
   * - OAuth 1.0a ("token:secret"): uses the server-level app key/secret pair.
   * - OAuth 2.0 (bearer token): passes the token directly as a user-context bearer.
   */
  private buildClient(accessToken: string): TwitterApi {
    if (XProvider.isOAuth1Token(accessToken)) {
      const [tokenPart, secretPart] = accessToken.split(':');
      return new TwitterApi({
        appKey: process.env.X_API_KEY!,
        appSecret: process.env.X_API_SECRET!,
        accessToken: tokenPart,
        accessSecret: secretPart,
      });
    }
    return new TwitterApi(accessToken);
  }

  maxLength(isTwitterPremium: boolean) {
    return isTwitterPremium ? 4000 : 280;
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const client = new TwitterApi({
      clientId: process.env.X_CLIENT_ID!,
      clientSecret: process.env.X_CLIENT_SECRET!,
    });

    const {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    } = await client.refreshOAuth2Token(refreshToken);

    const newClient = new TwitterApi(accessToken);
    const { username, verified, profile_image_url, name, id } =
      await this._getUserInfo(newClient);

    return {
      id: String(id),
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
      name,
      picture: profile_image_url || '',
      username,
    };
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry';
        value: string;
      }
    | undefined {
    if (body.includes('Unsupported Authentication') || body.includes('invalid_grant')) {
      return {
        type: 'refresh-token',
        value: 'X authentication has expired, please reconnect your account',
      };
    }

    if (body.includes('"code":503') || body.includes('Service Unavailable') || body.includes('ECONNRESET') || body.includes('ETIMEDOUT') || body.includes('TIMEOUT')) {
      return {
        type: 'retry',
        value: 'X API or network is temporarily unavailable, will retry',
      };
    }
    if (body.includes('"code":429') || body.includes('Too Many Requests')) {
      return {
        type: 'retry',
        value: 'X API rate limited (429), will retry',
      };
    }
    if (body.includes('"code":500') || body.includes('Internal Server Error')) {
      return {
        type: 'retry',
        value: 'X API internal error (500), will retry',
      };
    }
    if (body.includes('"status":403') || body.includes('You are not permitted to perform this action')) {
      return {
        type: 'bad-body',
        value: 'X rejected this post (403 Forbidden). This is usually caused by content that exceeds the character limit, contains restricted words, or triggers X\'s spam filter. Try shortening the text or removing special content.',
      };
    }
    if (body.includes('usage-capped')) {
      return {
        type: 'bad-body',
        value: 'Posting failed - capped reached. Please try again later',
      };
    }
    if (body.includes('duplicate-rules')) {
      return {
        type: 'bad-body',
        value:
          'You have already posted this post, please wait before posting again',
      };
    }
    if (body.includes('The Tweet contains an invalid URL.')) {
      return {
        type: 'bad-body',
        value: 'The Tweet contains a URL that is not allowed on X',
      };
    }
    if (
      body.includes(
        'This user is not allowed to post a video longer than 2 minutes'
      )
    ) {
      return {
        type: 'bad-body',
        value:
          'The video you are trying to post is longer than 2 minutes, which is not allowed for this account',
      };
    }
    return undefined;
  }

  @Plug({
    identifier: 'x-autoRepostPost',
    title: 'Auto Repost Posts',
    disabled: !!process.env.DISABLE_X_ANALYTICS,
    description:
      'When a post reached a certain number of likes, repost it to increase engagement (1 week old posts)',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
    ],
  })
  async autoRepostPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string }
  ) {
    const client = this.buildClient(integration.token);

    if (
      (await client.v2.tweetLikedBy(id)).meta.result_count >=
      +fields.likesAmount
    ) {
      await timer(2000);
      await client.v2.retweet(integration.internalId, id);
      return true;
    }

    return false;
  }

  @PostPlug({
    identifier: 'x-repost-post-users',
    title: 'Add Re-posters',
    description: 'Add accounts to repost your post',
    pickIntegration: ['x'],
    fields: [],
  })
  async repostPostUsers(
    integration: Integration,
    originalIntegration: Integration,
    postId: string,
    information: any
  ) {
    const client = this.buildClient(integration.token);

    let userId: string;
    try {
      userId = await this._getUserId(client);
    } catch {
      return;
    }

    try {
      await client.v2.retweet(userId, postId);
    } catch (err) {
      /** nothing **/
    }
  }

  @Plug({
    identifier: 'x-autoPlugPost',
    title: 'Auto plug post',
    disabled: !!process.env.DISABLE_X_ANALYTICS,
    description:
      'When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
      {
        name: 'post',
        type: 'richtext',
        placeholder: 'Post to plug',
        description: 'Message content to plug',
        validation: /^[\s\S]{3,}$/g,
      },
    ],
  })
  async autoPlugPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string; post: string }
  ) {
    const client = this.buildClient(integration.token);

    if (
      (await client.v2.tweetLikedBy(id)).meta.result_count >=
      +fields.likesAmount
    ) {
      await timer(2000);

      await client.v2.tweet({
        text: stripHtmlValidation('normal', fields.post, true),
        reply: { in_reply_to_tweet_id: id },
      });
      return true;
    }

    return false;
  }


  async generateAuthUrl() {
    const client = new TwitterApi({
      clientId: process.env.X_CLIENT_ID!,
      clientSecret: process.env.X_CLIENT_SECRET!,
    });

    const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
      (process.env.X_URL || process.env.FRONTEND_URL) +
        `/integrations/social/x`,
      {
        scope: this.scopes as any,
      }
    );

    return {
      url,
      codeVerifier,
      state,
    };
  }

  async authenticate(params: { code: string; codeVerifier: string }) {
    const { code, codeVerifier } = params;

    const client = new TwitterApi({
      clientId: process.env.X_CLIENT_ID!,
      clientSecret: process.env.X_CLIENT_SECRET!,
    });

    let accessToken: string;
    let refreshToken: string;
    let expiresIn: number;
    try {
      const {
        accessToken: acc,
        refreshToken: ref,
        expiresIn: exp,
      } = await client.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri:
          (process.env.X_URL || process.env.FRONTEND_URL) +
          `/integrations/social/x`,
      });
      accessToken = acc;
      refreshToken = ref!;
      expiresIn = exp;
    } catch (err: any) {
      const status = err?.code || err?.status || '';
      console.error(`X OAuth 2.0 login failed (${status}):`, err?.data || err?.message || err);
      return `X authentication failed: ${err?.data?.detail || err?.message || 'Service temporarily unavailable. Please try again.'}`;
    }

    const newClient = new TwitterApi(accessToken);
    const { username, verified, profile_image_url, name, id } =
      await this._getUserInfo(newClient);

    return {
      id: String(id),
      accessToken,
      name,
      refreshToken,
      expiresIn,
      picture: profile_image_url || '',
      username,
      additionalSettings: [
        {
          title: 'Verified',
          description: 'Is this a verified user? (Premium)',
          type: 'checkbox' as const,
          value: verified,
        },
      ],
    };
  }

  private async getClient(accessToken: string) {
    return this.buildClient(accessToken);
  }

  @Tool({
    description: 'Fetch tweet details by URL',
    dataSchema: [{ key: 'url', type: 'string', description: 'Tweet URL' }],
  })
  async fetchTweet(accessToken: string, data: { url: string }) {
    const tweetId = data.url?.split('/status/')?.pop()?.split('?')[0];
    if (!tweetId) {
      return null;
    }

    const client = await this.getClient(accessToken);
    try {
      const tweet = await client.v2.singleTweet(tweetId, {
        'tweet.fields': ['text', 'created_at', 'public_metrics', 'author_id', 'attachments'],
        expansions: ['author_id', 'attachments.media_keys'],
        'user.fields': ['name', 'username', 'profile_image_url'],
        'media.fields': ['url', 'preview_image_url', 'type'],
      });

      const author = tweet.includes?.users?.[0];
      const media = tweet.includes?.media?.map((m: any) => ({
        type: m.type,
        url: m.url || m.preview_image_url,
      })).filter((m: any) => m.url) || [];

      return {
        id: tweet.data.id,
        text: tweet.data.text,
        createdAt: tweet.data.created_at,
        metrics: tweet.data.public_metrics,
        author: author
          ? {
              name: author.name,
              username: author.username,
              profileImageUrl: author.profile_image_url,
            }
          : null,
        media,
      };
    } catch (err: any) {
      console.warn(`[x] fetchTweet failed for ${tweetId}:`, err?.message || err);
      return null;
    }
  }

  // v2.me() can be unstable; fallback to v1.1 verifyCredentials
  private async _getUserInfo(client: TwitterApi): Promise<{ id: string; username: string; verified: boolean; profile_image_url: string; name: string }> {
    let result: Awaited<ReturnType<typeof client.v2.me>>;
    try {
      result = await client.v2.me({
        'user.fields': [
          'username',
          'verified',
          'verified_type',
          'profile_image_url',
          'name',
        ],
      });
    } catch (err: any) {
      const status = err?.code || err?.data?.status || err?.status;
      if (status === 403) {
        if (this._isUserSuspendedError(err)) {
          throw new Error(
            'This X account is suspended. Please restore the account on X before connecting.'
          );
        }
        throw new Error(
          'X API returned 403 when fetching user info. ' +
          'Please ensure your X app has "users.read" scope enabled and OAuth 2.0 User Authentication is configured in the X Developer Portal.'
        );
      }
      throw err;
    }
    const { data } = result;
    return {
      id: data.id,
      username: data.username,
      verified: ['blue', 'business', 'government'].includes(data.verified_type as any) || !!data.verified,
      profile_image_url: data.profile_image_url!,
      name: data.name,
    };
  }

  /**
   * Search user's recent tweets (last 24h) for content matching the given text.
   * Used for idempotency: detect tweets that were posted successfully on X but
   * not recorded by Postiz (e.g. network timeout after X accepted the request).
   * Comparison strips t.co URLs since X auto-shortens all links.
   */
  private async _findExistingTweet(
    client: TwitterApi,
    userId: string,
    text: string
  ): Promise<{ id: string } | null> {
    try {
      const since = dayjs().subtract(24, 'hour').toISOString();
      const until = dayjs().toISOString();
      const tweets = await client.v2.userTimeline(userId, {
        'tweet.fields': ['id', 'text'],
        exclude: ['replies', 'retweets'],
        start_time: since,
        end_time: until,
        max_results: 20,
      });
      if (!tweets.data?.data?.length) return null;

      const normalize = (s: string) =>
        s.replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
      const needle = normalize(text);
      if (!needle) return null;

      const match = tweets.data.data.find(
        (t) => normalize(t.text) === needle
      );
      return match ? { id: match.id } : null;
    } catch (err) {
      console.warn('[x] _findExistingTweet failed, skipping duplicate check:', (err as Error)?.message || err);
      return null;
    }
  }

  /**
   * Sync the verified (premium) status from X API to the integration's additionalSettings.
   * Only updates the database when the value has actually changed.
   */
  private async _syncVerifiedStatus(integration: Integration, verified: boolean): Promise<void> {
    // Read fresh from DB to avoid overwriting account:* entries written by
    // updateAccountMetrics (which runs on a separate schedule). Using the
    // in-memory integration object here would cause a last-write-wins race.
    const fresh = await XProvider._prisma.integration.findUnique({
      where: { id: integration.id },
      select: { additionalSettings: true },
    });
    if (!fresh) return;

    const current = parseAdditionalSettings(fresh.additionalSettings);
    const verifiedSetting = current.find((s) => s.title === 'Verified');
    if (verifiedSetting && verifiedSetting.value === verified) {
      return; // no change
    }

    const newSettingsJson = mergeAdditionalSettings(fresh.additionalSettings, [
      { title: 'Verified', description: 'Is this a verified user? (Premium)', type: 'checkbox', value: verified },
    ]);

    await XProvider._prisma.integration.update({
      where: { id: integration.id },
      data: { additionalSettings: newSettingsJson },
    });
  }

  private async _getUserId(client: TwitterApi): Promise<string> {
    const { data } = await client.v2.me();
    return data.id;
  }

  private static readonly RATE_LIMIT_KEY = 'x:tweets:rate-limit-reset';

  private async _isRateLimited(): Promise<boolean> {
    const resetStr = await ioRedis.get(XProvider.RATE_LIMIT_KEY);
    if (!resetStr) return false;
    return Math.floor(Date.now() / 1000) < Number(resetStr);
  }

  private async _setRateLimited(resetEpoch: number): Promise<void> {
    const ttl = Math.max(resetEpoch - Math.floor(Date.now() / 1000), 60);
    await ioRedis.set(XProvider.RATE_LIMIT_KEY, String(resetEpoch), 'EX', ttl);
  }

  /**
   * Identify the X-side "this user account is suspended" 403 error. Tokens
   * remain valid in this state — when the platform reinstates the account, the
   * very next API call will start succeeding again with the same token. We
   * MUST NOT route this through `refreshNeeded`, which would force the user to
   * re-authenticate unnecessarily and freeze their scheduled queue.
   */
  // Extract only the useful fields from a twitter-api-v2 error so logs don't dump
  // axios/socket internals (which contain TLS cert bytes and circular refs).
  private formatTweetError(e: any) {
    return {
      code: e?.code,
      status: e?.data?.status ?? e?.status,
      title: e?.data?.title,
      detail: e?.data?.detail,
      type: e?.data?.type,
      errors: e?.data?.errors,
      message: e?.message,
      rateLimitRemaining: e?.rateLimit?.remaining,
      rateLimitReset: e?.rateLimit?.reset,
    };
  }

  private _isUserSuspendedError(err: any): boolean {
    if (!err || err.code !== 403) return false;
    const type =
      typeof err?.data?.type === 'string' ? err.data.type : '';
    if (type.includes('user-suspended') || type.includes('app-suspended')) {
      return true;
    }
    const detail =
      typeof err?.data?.detail === 'string' ? err.data.detail : '';
    if (detail.toLowerCase().includes('user used for authentication is suspended')) {
      return true;
    }
    return false;
  }

  /**
   * Notify the organisation that owns this integration that their X account has
   * been suspended by X. Deduped via Redis NX EX so cron retries do not spam the
   * inbox: at most one notification per cooldown window (default 24h, override
   * via X_SUSPENDED_NOTIFY_COOLDOWN_SECONDS).
   *
   * The Redis key auto-expires, so no manual clearing is required when the
   * platform reinstates the account — the next suspension event after the
   * cooldown elapses will simply notify again.
   *
   * Failures here must never break the caller (analytics / posting). Wrap and
   * swallow.
   */
  private async _notifyXSuspendedOnce(integrationId: string): Promise<void> {
    try {
      const cooldownSeconds = parseInt(
        process.env.X_SUSPENDED_NOTIFY_COOLDOWN_SECONDS || '86400',
        10
      );
      await notifyOncePerCooldown({
        provider: 'x',
        event: 'suspended',
        subjectId: integrationId,
        cooldownSeconds: Number.isFinite(cooldownSeconds)
          ? cooldownSeconds
          : 86400,
        notify: async () => {
          const integration = await XProvider._prisma.integration.findUnique({
            where: { id: integrationId },
            select: { id: true, name: true, organizationId: true },
          });
          if (!integration) return;

          const content =
            `Your X account "${integration.name}" has been suspended by X. ` +
            `Scheduled posts and analytics will keep failing until X reinstates the account. ` +
            `Please appeal at <a href="https://help.x.com/en/managing-your-account/suspended-x-accounts" target="_blank" rel="noopener noreferrer">help.x.com</a>. ` +
            `Postiz will resume automatically once your account is reinstated — no need to re-authorize.`;

          await XProvider._prisma.notifications.create({
            data: {
              organizationId: integration.organizationId,
              content,
            },
          });

          console.warn(
            `[x] Notified suspended account: integration=${integrationId} org=${integration.organizationId}`
          );
        },
      });
    } catch (err: any) {
      console.warn(
        `[x] Failed to send suspended notification for integration=${integrationId}: ${
          err?.message || err
        }`
      );
    }
  }

  /**
   * Synchronous wrapper around `_notifyXSuspendedOnce` that GUARANTEES no
   * exception ever escapes into the caller, regardless of failure mode:
   *   - Async rejections inside `_notifyXSuspendedOnce` → already caught by its
   *     own try/catch, but we add `.catch` here as an extra safety net.
   *   - Synchronous TypeError (e.g. method missing in some test/build edge
   *     case) → caught by the outer try/catch.
   *
   * Use this from every X API catch block. The notification fix MUST never
   * affect existing functionality, even in pathological failure modes.
   */
  private _safeFireSuspendedNotification(integrationId: string): void {
    try {
      this._notifyXSuspendedOnce(integrationId).catch((err: any) => {
        console.warn(
          `[x] suspended notification swallowed for integration=${integrationId}: ${
            err?.message || err
          }`
        );
      });
    } catch (err: any) {
      console.warn(
        `[x] suspended notification dispatcher failed for integration=${integrationId}: ${
          err?.message || err
        }`
      );
    }
  }

  private async uploadMedia(
    client: TwitterApi,
    postDetails: PostDetails<any>[]
  ) {
    return (
      await Promise.all(
        postDetails.flatMap((p) =>
          p?.media?.flatMap(async (m) => {
            return {
              id: await this.runInConcurrent(
                async () =>
                  client.v2.uploadMedia(
                    m.path.indexOf('mp4') > -1
                      ? Buffer.from(await readOrFetch(m.path))
                      : await sharp(await readOrFetch(m.path), {
                          animated: lookup(m.path) === 'image/gif',
                        })
                          .resize({
                            width: 1000,
                          })
                          .gif()
                          .toBuffer(),
                    {
                      media_type: (lookup(m.path) || '') as any,
                    }
                  ),
                true
              ),
              postId: p.id,
            };
          })
        )
      )
    ).reduce((acc, val) => {
      if (!val?.id) {
        return acc;
      }

      acc[val.postId] = acc[val.postId] || [];
      acc[val.postId].push(val.id);

      return acc;
    }, {} as Record<string, string[]>);
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<{
      active_thread_finisher: boolean;
      thread_finisher: string;
      community?: string;
      quote_tweet_url?: string;
      who_can_reply_post:
        | 'everyone'
        | 'following'
        | 'mentionedUsers'
        | 'subscribers'
        | 'verified';
    }>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const client = await this.getClient(accessToken);
    const { id: userId, username, verified } = await this._getUserInfo(client);

    // Best-effort sync — do not block posting if this fails
    this._syncVerifiedStatus(integration, verified).catch((err) =>
      console.warn('[x] Failed to sync verified status:', err?.message || err)
    );

    const [firstPost] = postDetails;

    // upload media for the first post
    const uploadAll = await this.uploadMedia(client, [firstPost]);

    const media_ids = (uploadAll[firstPost.id] || []).filter((f) => f);

    // Quote tweet handling. Two modes, controlled by env var X_QUOTE_TWEET_APPEND_URL:
    //   - Default (native): pass quote_tweet_id to v2.tweet — produces a real native quote
    //     tweet (counts toward quote_count, appears in the quote timeline). May return 403
    //     on restricted API tiers (e.g. Pay Per Use).
    //   - Fallback (X_QUOTE_TWEET_APPEND_URL=true): append the quote URL to the message text
    //     and let X auto-render it as a quote card. Works on all tiers but is not a true
    //     native quote (does not increment the source tweet's quote_count).
    //
    // Hard constraint from X's OpenAPI spec (TweetCreateRequest schema): `quote_tweet_id` is
    // **mutually exclusive** with `media`, `poll`, and `card_uri`. So when the post has any
    // attached media we MUST skip native mode and fall back to URL append, otherwise the
    // request will be rejected with 400.
    //
    // Query params (e.g. ?s=20) are stripped because they prevent X from rendering the card
    // in URL-append mode and are irrelevant to the parsed tweet id in native mode.
    const rawQuoteUrl = firstPost?.settings?.quote_tweet_url?.split('?')[0];
    const appendQuoteUrlMode =
      String(process.env.X_QUOTE_TWEET_APPEND_URL || '').toLowerCase() === 'true';
    const hasMedia = media_ids.length > 0;
    // Capture the original message *before* any mutation, so messageWithQuoteUrl below is
    // always derivable from the unmodified text regardless of which branch ran.
    const originalMessage = firstPost.message;
    let quoteTweetId: string | undefined;
    if (rawQuoteUrl) {
      const forceUrlAppend = appendQuoteUrlMode || hasMedia;
      if (forceUrlAppend) {
        firstPost.message = originalMessage
          ? `${originalMessage}\n${rawQuoteUrl}`
          : rawQuoteUrl;
      } else {
        const match = rawQuoteUrl.match(/\/status\/(\d+)/);
        if (match) {
          quoteTweetId = match[1];
        } else {
          // Could not parse a tweet id — degrade to URL append so the user still gets a card.
          console.warn(
            `[x] Could not parse tweet id from quote_tweet_url "${rawQuoteUrl}", falling back to URL append`
          );
          firstPost.message = originalMessage
            ? `${originalMessage}\n${rawQuoteUrl}`
            : rawQuoteUrl;
        }
      }
      // Observability: log which quote-tweet mode was selected for this post. This is the
      // *initial* mode decision; if v2 native fails it may still degrade via the fallback
      // chain below (those failures are logged separately as warns).
      const reason = hasMedia
        ? ' [forced url-append: post has media (mutually exclusive with quote_tweet_id)]'
        : appendQuoteUrlMode
        ? ' [forced url-append: X_QUOTE_TWEET_APPEND_URL=true]'
        : '';
      console.log(
        `[x] Quote tweet mode for post ${firstPost.id}: ${
          quoteTweetId
            ? `native (quote_tweet_id=${quoteTweetId})`
            : 'url-append'
        }${reason}`
      );
    }

    // Common v2.tweet params shared by every attempt below. Text and quote_tweet_id are
    // applied per-attempt so we can degrade gracefully if a native quote is rejected.
    const commonV2Params = {
      ...(!firstPost?.settings?.who_can_reply_post ||
      firstPost?.settings?.who_can_reply_post === 'everyone'
        ? {}
        : {
            reply_settings: firstPost?.settings?.who_can_reply_post,
          }),
      ...(firstPost?.settings?.community
        ? {
            share_with_followers: true,
            community_id:
              firstPost?.settings?.community?.split('/').pop() || '',
          }
        : {}),
      ...(media_ids.length ? { media: { media_ids } } : {}),
    };
    // Derived from originalMessage (not firstPost.message) so it stays correct even if a
    // branch above already mutated firstPost.message in URL-append mode.
    const messageWithQuoteUrl =
      rawQuoteUrl
        ? originalMessage
          ? `${originalMessage}\n${rawQuoteUrl}`
          : rawQuoteUrl
        : originalMessage;

    let tweetId: string;
    try {
      // @ts-ignore
      const { data }: { data: { id: string } } = await this.runInConcurrent(
        async () => {
          try {
            // @ts-ignore
            return await client.v2.tweet({
              ...commonV2Params,
              text: firstPost.message,
              ...(quoteTweetId ? { quote_tweet_id: quoteTweetId } : {}),
            });
          } catch (tweetErr: any) {
            // --- 403 idempotency fallback: check if the tweet already exists on X ---
            const is403 = tweetErr?.code === 403 || tweetErr?.data?.status === 403
              || String(tweetErr?.message || '').includes('403');
            if (is403) {
              const existing = await this._findExistingTweet(client, userId, firstPost.message);
              if (existing) {
                console.log(`[x] 403 on v2.tweet but found existing tweet ${existing.id} — treating as success`);
                return { data: { id: existing.id } };
              }
            }
            throw tweetErr;
          }
        }
      );
      tweetId = data.id;
    } catch (err: any) {
      // Intermediate fallback: if we attempted a native quote (quote_tweet_id) and v2 failed,
      // retry v2 *without* quote_tweet_id and append the URL to the text instead. This keeps
      // community_id / reply_settings intact for restricted-tier users (e.g. Pay Per Use).
      if (quoteTweetId && rawQuoteUrl) {
        console.warn(
          `[x] v2.tweet with quote_tweet_id=${quoteTweetId} failed for post ${firstPost.id}, retrying v2 with URL-append fallback. Original error:`,
          this.formatTweetError(err)
        );
        try {
          // @ts-ignore
          const { data }: { data: { id: string } } = await client.v2.tweet({
            ...commonV2Params,
            text: messageWithQuoteUrl,
          });
          tweetId = data.id;
        } catch (retryErr: any) {
          console.error(
            `[x] v2 URL-append retry also failed for post ${firstPost.id}. Error:`,
            this.formatTweetError(retryErr)
          );
          if (this._isUserSuspendedError(err) || this._isUserSuspendedError(retryErr)) {
            this._safeFireSuspendedNotification(integration.id);
          }
          throw retryErr;
        }
      } else {
        console.error(
          `[x] v2.tweet failed for post ${firstPost.id}. Error:`,
          this.formatTweetError(err)
        );
        if (this._isUserSuspendedError(err)) {
          this._safeFireSuspendedNotification(integration.id);
        }
        throw err;
      }
    }

    return [
      {
        postId: tweetId,
        id: firstPost.id,
        releaseURL: `https://twitter.com/${username}/status/${tweetId}`,
        status: 'posted',
      },
    ];
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<{
      active_thread_finisher: boolean;
      thread_finisher: string;
    }>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const client = await this.getClient(accessToken);
    const { username, verified } = await this._getUserInfo(client);

    // Best-effort sync — do not block posting if this fails
    this._syncVerifiedStatus(integration, verified).catch((err) =>
      console.warn('[x] Failed to sync verified status:', err?.message || err)
    );

    const [commentPost] = postDetails;

    // upload media for the comment
    const uploadAll = await this.uploadMedia(client, [commentPost]);

    const media_ids = (uploadAll[commentPost.id] || []).filter((f) => f);

    const replyToId = lastCommentId || postId;

    let tweetId: string;
    try {
      // @ts-ignore
      const { data }: { data: { id: string } } = await this.runInConcurrent(
        async () =>
          // @ts-ignore
          client.v2.tweet({
            text: commentPost.message,
            ...(media_ids.length ? { media: { media_ids } } : {}),
            reply: { in_reply_to_tweet_id: replyToId },
          })
      );
      tweetId = data.id;
    } catch (err: any) {
      console.error('[x] v2.tweet (comment) failed:', this.formatTweetError(err));
      throw err;
    }

    return [
      {
        postId: tweetId,
        id: commentPost.id,
        releaseURL: `https://twitter.com/${username}/status/${tweetId}`,
        status: 'posted',
      },
    ];
  }

  private loadAllTweets = async (
    client: TwitterApi,
    id: string,
    until: string,
    since: string,
    token = ''
  ): Promise<TweetV2[]> => {
    const tweets = await client.v2.userTimeline(id, {
      'tweet.fields': ['id'],
      'user.fields': [],
      'poll.fields': [],
      'place.fields': [],
      'media.fields': [],
      exclude: ['replies', 'retweets'],
      start_time: since,
      end_time: until,
      max_results: 100,
      ...(token ? { pagination_token: token } : {}),
    });

    return [
      ...tweets.data.data,
      ...(tweets.data.data.length === 100
        ? await this.loadAllTweets(
            client,
            id,
            until,
            since,
            tweets.meta.next_token
          )
        : []),
    ];
  };

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    if (process.env.DISABLE_X_ANALYTICS) {
      return [];
    }

    if (await this._isRateLimited()) {
      return [];
    }

    const until = dayjs().endOf('day');
    const since = dayjs().subtract(date, 'day');

    const client = this.buildClient(accessToken);

    try {
      const tweets = uniqBy(
        await this.loadAllTweets(
          client,
          id,
          until.format('YYYY-MM-DDTHH:mm:ssZ'),
          since.format('YYYY-MM-DDTHH:mm:ssZ')
        ),
        (p) => p.id
      );

      if (tweets.length === 0) {
        return [];
      }

      const data = await client.v2.tweets(
        tweets.map((p) => p.id),
        {
          'tweet.fields': ['public_metrics'],
        }
      );

      const metrics = data.data.reduce(
        (all, current) => {
          all.impression_count =
            (all.impression_count || 0) +
            +current.public_metrics.impression_count;
          all.bookmark_count =
            (all.bookmark_count || 0) + +current.public_metrics.bookmark_count;
          all.like_count =
            (all.like_count || 0) + +current.public_metrics.like_count;
          all.quote_count =
            (all.quote_count || 0) + +current.public_metrics.quote_count;
          all.reply_count =
            (all.reply_count || 0) + +current.public_metrics.reply_count;
          all.retweet_count =
            (all.retweet_count || 0) + +current.public_metrics.retweet_count;

          return all;
        },
        {
          impression_count: 0,
          bookmark_count: 0,
          like_count: 0,
          quote_count: 0,
          reply_count: 0,
          retweet_count: 0,
        }
      );

      return Object.entries(metrics).map(([key, value]) => ({
        label: key.replace('_count', '').replace('_', ' ').toUpperCase(),
        percentageChange: 5,
        data: [
          {
            total: String(0),
            date: since.format('YYYY-MM-DD'),
          },
          {
            total: String(value),
            date: until.format('YYYY-MM-DD'),
          },
        ],
      }));
    } catch (err: any) {
      if (err?.code === 429 || err?.rateLimit) {
        if (err?.rateLimit?.reset) {
          await this._setRateLimited(err.rateLimit.reset);
        }
        console.log(
          `X API rate limited for analytics, reset at ${err?.rateLimit?.reset || 'unknown'}`
        );
      } else {
        console.log(err);
      }
    }
    return [];
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    if (process.env.DISABLE_X_ANALYTICS) {
      return [];
    }

    if (await this._isRateLimited()) {
      return [];
    }

    const today = dayjs().format('YYYY-MM-DD');

    const client = await this.getClient(accessToken);

    try {
      // Fetch the specific tweet with public metrics
      const tweet = await client.v2.singleTweet(postId, {
        'tweet.fields': ['public_metrics', 'created_at'],
      });

      if (!tweet?.data?.public_metrics) {
        return [];
      }

      const metrics = tweet.data.public_metrics;

      const result: AnalyticsData[] = [];

      if (metrics.impression_count !== undefined) {
        result.push({
          label: 'Impressions',
          percentageChange: 0,
          data: [{ total: String(metrics.impression_count), date: today }],
        });
      }

      if (metrics.like_count !== undefined) {
        result.push({
          label: 'Likes',
          percentageChange: 0,
          data: [{ total: String(metrics.like_count), date: today }],
        });
      }

      if (metrics.retweet_count !== undefined) {
        result.push({
          label: 'Retweets',
          percentageChange: 0,
          data: [{ total: String(metrics.retweet_count), date: today }],
        });
      }

      if (metrics.reply_count !== undefined) {
        result.push({
          label: 'Replies',
          percentageChange: 0,
          data: [{ total: String(metrics.reply_count), date: today }],
        });
      }

      if (metrics.quote_count !== undefined) {
        result.push({
          label: 'Quotes',
          percentageChange: 0,
          data: [{ total: String(metrics.quote_count), date: today }],
        });
      }

      if (metrics.bookmark_count !== undefined) {
        result.push({
          label: 'Bookmarks',
          percentageChange: 0,
          data: [{ total: String(metrics.bookmark_count), date: today }],
        });
      }

      return result;
    } catch (err: any) {
      if (err?.code === 429 || err?.rateLimit) {
        if (err?.rateLimit?.reset) {
          await this._setRateLimited(err.rateLimit.reset);
        }
        console.log(
          `X API rate limited for post ${postId}, reset at ${err?.rateLimit?.reset || 'unknown'}`
        );
        throw err;
      }
      if (this._isUserSuspendedError(err)) {
        console.warn(
          `[x] post analytics skipped: integration=${integrationId} post=${postId} suspended by platform`
        );
        this._safeFireSuspendedNotification(integrationId);
        return [];
      }
      console.log('Error fetching X post analytics:', err);
    }

    return [];
  }

  async accountMetrics(
    integrationId: string,
    accessToken: string
  ): Promise<AccountMetrics | null> {
    if (process.env.DISABLE_X_ANALYTICS) {
      return null;
    }

    if (await this._isRateLimited()) {
      return null;
    }

    const client = await this.getClient(accessToken);

    try {
      const { data } = await client.v2.me({
        'user.fields': ['public_metrics'],
      });

      const metrics = data.public_metrics;
      if (!metrics) {
        return null;
      }

      const result: AccountMetrics = {};
      if (metrics.followers_count !== undefined) result.followers = metrics.followers_count;
      if (metrics.following_count !== undefined) result.following = metrics.following_count;
      if (metrics.tweet_count !== undefined) result.posts = metrics.tweet_count;
      if (metrics.listed_count !== undefined) result.listed = metrics.listed_count;
      return result;
    } catch (err: any) {
      if (err?.code === 429 || err?.rateLimit) {
        if (err?.rateLimit?.reset) {
          await this._setRateLimited(err.rateLimit.reset);
        }
      }
      if (this._isUserSuspendedError(err)) {
        console.warn(
          `[x] account metrics skipped: integration=${integrationId} suspended by platform`
        );
        // fire-and-forget; safe wrapper guarantees no exception escapes
        this._safeFireSuspendedNotification(integrationId);
        return null;
      }
      console.error('Error fetching X account metrics:', err);
      return null;
    }
  }

  async batchPostAnalytics(
    integrationId: string,
    accessToken: string,
    postIds: string[],
    date: number
  ): Promise<BatchPostAnalyticsResult> {
    if (process.env.DISABLE_X_ANALYTICS || postIds.length === 0) {
      return {};
    }

    if (await this._isRateLimited()) {
      return {};
    }

    const today = dayjs().format('YYYY-MM-DD');

    const client = await this.getClient(accessToken);

    const result: BatchPostAnalyticsResult = {};

    try {
      // X API v2.tweets accepts max 100 IDs per request
      for (let i = 0; i < postIds.length; i += 100) {
        const chunk = postIds.slice(i, i + 100);
        const data = await client.v2.tweets(chunk, {
          'tweet.fields': ['public_metrics'],
        });

        if (!data?.data?.length) continue;
        for (const tweet of data.data) {
          const metrics = tweet.public_metrics;
          if (!metrics) continue;

          const analytics: AnalyticsData[] = [];

          if (metrics.impression_count !== undefined) {
            analytics.push({
              label: 'Impressions',
              percentageChange: 0,
              data: [{ total: String(metrics.impression_count), date: today }],
            });
          }
          if (metrics.like_count !== undefined) {
            analytics.push({
              label: 'Likes',
              percentageChange: 0,
              data: [{ total: String(metrics.like_count), date: today }],
            });
          }
          if (metrics.retweet_count !== undefined) {
            analytics.push({
              label: 'Retweets',
              percentageChange: 0,
              data: [{ total: String(metrics.retweet_count), date: today }],
            });
          }
          if (metrics.reply_count !== undefined) {
            analytics.push({
              label: 'Replies',
              percentageChange: 0,
              data: [{ total: String(metrics.reply_count), date: today }],
            });
          }
          if (metrics.quote_count !== undefined) {
            analytics.push({
              label: 'Quotes',
              percentageChange: 0,
              data: [{ total: String(metrics.quote_count), date: today }],
            });
          }
          if (metrics.bookmark_count !== undefined) {
            analytics.push({
              label: 'Bookmarks',
              percentageChange: 0,
              data: [{ total: String(metrics.bookmark_count), date: today }],
            });
          }

          result[tweet.id] = analytics;
        }
      }
    } catch (err: any) {
      if (err?.code === 429 || err?.rateLimit) {
        if (err?.rateLimit?.reset) {
          await this._setRateLimited(err.rateLimit.reset);
        }
        console.log(
          `X API rate limited for batch post analytics, reset at ${err?.rateLimit?.reset || 'unknown'}`
        );
        throw err;
      }
      if (this._isUserSuspendedError(err)) {
        console.warn(
          `[x] batch post analytics skipped: integration=${integrationId} suspended by platform`
        );
        this._safeFireSuspendedNotification(integrationId);
        return result;
      }
      console.log('Error fetching X batch post analytics:', err);
    }

    return result;
  }

  override async mention(token: string, d: { query: string }) {
    const client = this.buildClient(token);

    try {
      const data = await client.v2.userByUsername(d.query, {
        'user.fields': ['username', 'name', 'profile_image_url'],
      });

      if (!data?.data?.username) {
        return [];
      }

      return [
        {
          id: data.data.username,
          image: data.data.profile_image_url,
          label: data.data.name,
        },
      ];
    } catch (err) {
      console.log(err);
    }
    return [];
  }

  mentionFormat(idOrHandle: string, name: string) {
    return `@${idOrHandle}`;
  }
}
