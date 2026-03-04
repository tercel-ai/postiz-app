import { TweetV2, TwitterApi } from 'twitter-api-v2';
import {
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
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

@Rules(
  'X can have maximum 4 pictures, or maximum one video, it can also be without attachments'
)
export class XProvider extends SocialAbstract implements SocialProvider {
  identifier = 'x';
  name = 'X';
  isBetweenSteps = false;
  scopes = [] as string[];
  override maxConcurrentJob = 1; // X has strict rate limits (300 posts per 3 hours)
  toolTip =
    'You will be logged in into your current account, if you would like a different account, change it first on X';

  editor = 'normal' as const;
  dto = XDto;

  maxLength(isTwitterPremium: boolean) {
    return isTwitterPremium ? 4000 : 200;
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry';
        value: string;
      }
    | undefined {
    if (body.includes('Unsupported Authentication')) {
      return {
        type: 'refresh-token',
        value: 'X authentication has expired, please reconnect your account',
      };
    }

    if (body.includes('"code":503') || body.includes('Service Unavailable')) {
      return {
        type: 'retry',
        value: 'X API is temporarily unavailable (503), will retry',
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
    // @ts-ignore
    // eslint-disable-next-line prefer-rest-params
    const [accessTokenSplit, accessSecretSplit] = integration.token.split(':');
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });

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
    const [accessTokenSplit, accessSecretSplit] = integration.token.split(':');
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });

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
    // @ts-ignore
    // eslint-disable-next-line prefer-rest-params
    const [accessTokenSplit, accessSecretSplit] = integration.token.split(':');
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });

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

  async refreshToken(): Promise<AuthTokenDetails> {
    return {
      id: '',
      name: '',
      accessToken: '',
      refreshToken: '',
      expiresIn: 0,
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
    });
    const { url, oauth_token, oauth_token_secret } =
      await client.generateAuthLink(
        (process.env.X_URL || process.env.FRONTEND_URL) +
          `/integrations/social/x`,
        {
          authAccessType: 'write',
          linkMode: 'authenticate',
          forceLogin: false,
        }
      );
    return {
      url,
      codeVerifier: oauth_token + ':' + oauth_token_secret,
      state: oauth_token,
    };
  }

  async authenticate(params: { code: string; codeVerifier: string }) {
    const { code, codeVerifier } = params;
    const [oauth_token, oauth_token_secret] = codeVerifier.split(':');

    const startingClient = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: oauth_token,
      accessSecret: oauth_token_secret,
    });

    let accessToken: string;
    let accessSecret: string;
    let client: TwitterApi;
    try {
      const loginResult = await startingClient.login(code);
      accessToken = loginResult.accessToken;
      accessSecret = loginResult.accessSecret;
      client = loginResult.client;
    } catch (err: any) {
      const status = err?.code || err?.status || '';
      console.error(`X OAuth login failed (${status}):`, err?.data || err?.message || err);
      return `X authentication failed: ${err?.data?.detail || err?.message || 'Service temporarily unavailable. Please try again.'}`;
    }

    // Try v2 first, fallback to v1.1 if v2 returns 503
    let username: string;
    let verified: boolean | undefined;
    let profile_image_url: string | undefined;
    let name: string;
    let id: string | number;

    try {
      const {
        data: { username: u, verified: v, profile_image_url: p, name: n, id: i },
      } = await client.v2.me({
        'user.fields': [
          'username',
          'verified',
          'verified_type',
          'profile_image_url',
          'name',
        ],
      });
      username = u;
      verified = v;
      profile_image_url = p;
      name = n;
      id = i;
    } catch (err: any) {
      const status = err?.code || err?.status || '';
      console.warn(`X v2.me failed (${status}), trying v1.1 fallback...`);

      try {
        const v1User = await client.v1.verifyCredentials();
        username = v1User.screen_name;
        verified = v1User.verified;
        profile_image_url = v1User.profile_image_url_https;
        name = v1User.name;
        id = v1User.id_str;
      } catch (v1Err: any) {
        const v1Status = v1Err?.code || v1Err?.status || '';
        console.error(`X v1.1 fallback also failed (${v1Status}):`, v1Err?.data || v1Err?.message || v1Err);
        return `Failed to fetch X account info: ${err?.data?.detail || err?.message || 'Service temporarily unavailable. Please try again.'}`;
      }
    }

    return {
      id: String(id),
      accessToken: accessToken + ':' + accessSecret,
      name,
      refreshToken: '',
      expiresIn: 999999999,
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
    const [accessTokenSplit, accessSecretSplit] = accessToken.split(':');
    return new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });
  }

  // v2.me() can be unstable; fallback to v1.1 verifyCredentials
  private async _getUsername(client: TwitterApi): Promise<string> {
    try {
      const { data } = await this.runInConcurrent(async () =>
        client.v2.me({ 'user.fields': 'username' })
      );
      return data.username;
    } catch (err) {
      try {
        const v1User = await client.v1.verifyCredentials();
        return v1User.screen_name;
      } catch {
        throw err;
      }
    }
  }

  private async _getUserId(client: TwitterApi): Promise<string> {
    try {
      const { data } = await client.v2.me();
      return data.id;
    } catch (err) {
      try {
        const v1User = await client.v1.verifyCredentials();
        return v1User.id_str;
      } catch {
        throw err;
      }
    }
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
      who_can_reply_post:
        | 'everyone'
        | 'following'
        | 'mentionedUsers'
        | 'subscribers'
        | 'verified';
    }>[]
  ): Promise<PostResponse[]> {
    const client = await this.getClient(accessToken);
    const username = await this._getUsername(client);

    const [firstPost] = postDetails;

    // upload media for the first post
    const uploadAll = await this.uploadMedia(client, [firstPost]);

    const media_ids = (uploadAll[firstPost.id] || []).filter((f) => f);

    let tweetId: string;
    try {
      // @ts-ignore
      const { data }: { data: { id: string } } = await this.runInConcurrent(
        async () =>
          // @ts-ignore
          client.v2.tweet({
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
            text: firstPost.message,
            ...(media_ids.length ? { media: { media_ids } } : {}),
          })
      );
      tweetId = data.id;
    } catch (err) {
      console.warn('[x] v2.tweet failed, trying v1.1 fallback...');
      try {
        const v1Result = await client.v1.tweet(firstPost.message, {
          ...(media_ids.length ? { media_ids: media_ids.join(',') } : {}),
        });
        tweetId = v1Result.id_str;
      } catch (v1Err: any) {
        console.error('[x] v1.1 tweet fallback also failed:', JSON.stringify(v1Err?.data || v1Err?.message || v1Err));
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
    const username = await this._getUsername(client);

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
    } catch (err) {
      console.warn('[x] v2.tweet (comment) failed, trying v1.1 fallback...');
      try {
        const v1Result = await client.v1.tweet(commentPost.message, {
          in_reply_to_status_id: replyToId,
          ...(media_ids.length ? { media_ids: media_ids.join(',') } : {}),
        });
        tweetId = v1Result.id_str;
      } catch (v1Err: any) {
        console.error('[x] v1.1 tweet (comment) fallback also failed:', JSON.stringify(v1Err?.data || v1Err?.message || v1Err));
        throw err;
      }
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

    const [accessTokenSplit, accessSecretSplit] = accessToken.split(':');
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });

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

    const [accessTokenSplit, accessSecretSplit] = accessToken.split(':');
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });

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
      console.log('Error fetching X post analytics:', err);
    }

    return [];
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

    const [accessTokenSplit, accessSecretSplit] = accessToken.split(':');
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });

    const result: BatchPostAnalyticsResult = {};

    try {
      // X API v2.tweets accepts max 100 IDs per request
      for (let i = 0; i < postIds.length; i += 100) {
        const chunk = postIds.slice(i, i + 100);
        const data = await client.v2.tweets(chunk, {
          'tweet.fields': ['public_metrics'],
        });

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
      console.log('Error fetching X batch post analytics:', err);
    }

    return result;
  }

  override async mention(token: string, d: { query: string }) {
    const [accessTokenSplit, accessSecretSplit] = token.split(':');
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessTokenSplit,
      accessSecret: accessSecretSplit,
    });

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
