import {
  AccountMetrics,
  AnalyticsData,
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { RedditSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/reddit.dto';
import { timer } from '@gitroom/helpers/utils/timer';
import dayjs from 'dayjs';
import { groupBy } from 'lodash';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { lookup } from 'mime-types';
import axios from 'axios';
import WebSocket from 'ws';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';
import { Integration } from '@prisma/client';

// @ts-ignore
global.WebSocket = WebSocket;

// Reddit requires every request to carry a unique, descriptive User-Agent.
// Missing or generic UAs (e.g. undici's default "node") are blocked with HTTP
// 403 ("whoa there, pardner!"). Format recommended by Reddit:
//   <platform>:<app id>:<version> (by /u/<reddit username>)
const REDDIT_USER_AGENT =
  process.env.REDDIT_USER_AGENT || 'web:postiz:v1.0 (by /u/postiz-app)';

export class RedditProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 1; // Reddit has strict rate limits (1 request per second)
  identifier = 'reddit';
  name = 'Reddit';
  isBetweenSteps = false;
  scopes = ['read', 'identity', 'submit', 'flair'];
  // flair is optional — posting works without it; only flair selection requires it
  requiredScopes = ['read', 'identity', 'submit'];
  editor = 'normal' as const;
  dto = RedditSettingsDto;

  maxLength() {
    return 10000;
  }

  // Inject Reddit's required User-Agent into every request. Reddit blocks the
  // undici default ("node") with HTTP 403, so this must be set on all calls —
  // token exchange, OAuth, posting and analytics alike. Caller-supplied headers
  // win, but none set User-Agent, so REDDIT_USER_AGENT always applies.
  override fetch(
    url: string,
    options: RequestInit = {},
    identifier = '',
    totalRetries = 0,
    ignoreConcurrency = false
  ): Promise<Response> {
    return super.fetch(
      url,
      {
        ...options,
        headers: {
          'User-Agent': REDDIT_USER_AGENT,
          ...(options.headers as Record<string, string> | undefined),
        },
      },
      identifier,
      totalRetries,
      ignoreConcurrency
    );
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const tokenRes = await this.fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    // Guard before parsing: a revoked/expired refresh token returns a non-2xx
    // error body, so destructuring would yield `accessToken: undefined` and the
    // /me call below would send "Bearer undefined" — masking the real failure.
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '<unreadable>');
      throw new Error(
        `Reddit token refresh failed (HTTP ${tokenRes.status}): ${body.slice(0, 200)}`
      );
    }
    const {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: expiresIn,
    } = await tokenRes.json();

    const meRes = await this.fetch('https://oauth.reddit.com/api/v1/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!meRes.ok) {
      const body = await meRes.text().catch(() => '<unreadable>');
      throw new Error(
        `Reddit identity fetch failed after token refresh (HTTP ${meRes.status}): ${body.slice(0, 200)}`
      );
    }
    const { name, id, icon_img } = await meRes.json();

    // Reddit omits refresh_token when the existing token is still valid (RFC 6749 §6).
    // Fall back to the caller-supplied token so we never overwrite it with undefined.
    return {
      id,
      name,
      accessToken,
      refreshToken: newRefreshToken ?? refreshToken,
      expiresIn,
      picture: icon_img?.split?.('?')?.[0] || '',
      username: name,
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    const codeVerifier = makeId(30);
    const redirectUri = `${process.env.FRONTEND_URL}/integrations/social/reddit`;
    const url = `https://www.reddit.com/api/v1/authorize?client_id=${
      process.env.REDDIT_CLIENT_ID
    }&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&duration=permanent&scope=${encodeURIComponent(this.scopes.join(' '))}&approval_prompt=force`;
    return {
      url,
      codeVerifier,
      state,
    };
  }

  async authenticate(params: { code: string; codeVerifier: string }) {
    const redirectUri = `${process.env.FRONTEND_URL}/integrations/social/reddit`;
    const clientId = process.env.REDDIT_CLIENT_ID || '';
    const clientSecret = process.env.REDDIT_CLIENT_SECRET || '';

    // Use npm undici's fetch with an explicit ProxyAgent so the proxy is guaranteed
    // regardless of global dispatcher state. globalThis.fetch in Node.js 22 uses a
    // separate internal undici instance that is not affected by npm undici's
    // setGlobalDispatcher, so we must pass the dispatcher explicitly here.
    const proxyUrl = process.env.REDDIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

    // 'as any' is required because undici.RequestInit.dispatcher is not in DOM RequestInit
    const tokenRes = await (undiciFetch as any)('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_USER_AGENT,
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: redirectUri,
      }).toString(),
      ...(dispatcher && { dispatcher }),
    });

    const bodyText = await tokenRes.text();
    // `server: snooserv` means the response came from Reddit's own app layer; any
    // other value (or none) means an intermediary (proxy/edge) answered — the usual
    // cause of an opaque "Forbidden" that never reached Reddit. We log it (plus
    // whether the proxy was applied) so a 403 can be diagnosed without guesswork.
    const upstreamServer = tokenRes.headers.get('server') || 'unknown';
    if (process.env.NODE_ENV !== 'production') {
      // NEVER log the body here: on a 2xx it is the token-exchange JSON and would
      // leak the access_token / refresh_token. The raw body is logged only on the
      // !ok branch below, where it is an error payload, not a credential.
      console.debug(
        `[reddit.authenticate] token HTTP ${tokenRes.status} server=${upstreamServer} ` +
          `proxy=${dispatcher ? 'yes' : 'no'} hasClientId=${!!clientId} hasClientSecret=${!!clientSecret}`
      );
    }

    if (!tokenRes.ok) {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(`[reddit.authenticate] token error body=${bodyText.slice(0, 200)}`);
      }
      const errBody = (() => { try { return JSON.parse(bodyText); } catch { return {}; } })();
      const fromReddit = upstreamServer === 'snooserv';
      const hint = !fromReddit
        ? ` (response served by "${upstreamServer}", not Reddit — likely an edge/proxy block; check REDDIT_PROXY/HTTPS_PROXY and the proxy's exit IP)`
        : tokenRes.status === 403
        ? ` (Reddit returned 403 — the authorization code is likely already used or expired; retry with a fresh login)`
        : '';
      throw new Error(
        `Reddit token exchange failed (HTTP ${tokenRes.status}): ${errBody?.message || bodyText}${hint}`
      );
    }

    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      scope,
    } = JSON.parse(bodyText);

    this.checkScopes(this.requiredScopes, scope);

    const { name, id, icon_img } = await (
      await this.fetch('https://oauth.reddit.com/api/v1/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    ).json();

    return {
      id,
      name,
      accessToken,
      refreshToken,
      expiresIn,
      picture: icon_img?.split?.('?')?.[0] || '',
      username: name,
    };
  }

  private async uploadFileToReddit(accessToken: string, path: string) {
    const mimeType = lookup(path);
    const formData = new FormData();
    formData.append('filepath', path.split('/').pop());
    formData.append('mimetype', mimeType || 'application/octet-stream');

    const {
      args: { action, fields },
    } = await (
      await this.fetch(
        'https://oauth.reddit.com/api/media/asset',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          body: formData,
        },
        'reddit',
        0,
        true
      )
    ).json();

    const { data } = await axios.get(path, {
      responseType: 'arraybuffer',
    });

    const upload = (fields as { name: string; value: string }[]).reduce(
      (acc, value) => {
        acc.append(value.name, value.value);
        return acc;
      },
      new FormData()
    );

    upload.append(
      'file',
      new Blob([Buffer.from(data)], { type: mimeType as string })
    );

    const d = await fetch('https:' + action, {
      method: 'POST',
      body: upload,
    });

    return [...(await d.text()).matchAll(/<Location>(.*?)<\/Location>/g)][0][1];
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<RedditSettingsDto>[]
  ): Promise<PostResponse[]> {
    const [post] = postDetails;

    const valueArray: PostResponse[] = [];
    for (const firstPostSettings of post.settings.subreddit) {
      const postData = {
        api_type: 'json',
        title: firstPostSettings.value.title || '',
        kind:
          firstPostSettings.value.type === 'media'
            ? post.media[0].path.indexOf('mp4') > -1
              ? 'video'
              : 'image'
            : firstPostSettings.value.type,
        ...(firstPostSettings.value.flair
          ? { flair_id: firstPostSettings.value.flair.id }
          : {}),
        ...(firstPostSettings.value.type === 'link'
          ? {
              url: firstPostSettings.value.url,
            }
          : {}),
        ...(firstPostSettings.value.type === 'media'
          ? {
              url: await this.uploadFileToReddit(
                accessToken,
                post.media[0].path
              ),
              ...(post.media[0].path.indexOf('mp4') > -1
                ? {
                    video_poster_url: await this.uploadFileToReddit(
                      accessToken,
                      post.media[0].thumbnail
                    ),
                  }
                : {}),
            }
          : {}),
        text: post.message,
        sr: firstPostSettings.value.subreddit,
      };

      const all = await (
        await this.fetch('https://oauth.reddit.com/api/submit', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(postData),
        })
      ).json();

      const { id: redditId, name, url } = await new Promise<{
        id: string;
        name: string;
        url: string;
      }>((resolve, reject) => {
        // Reddit signals a rejected submit (banned subreddit, rule/flair
        // violation, rate-limit) as { json: { errors: [[code, msg, field]], data: null } }.
        // Surface those instead of blindly dereferencing data.websocket_url, which
        // would throw an opaque "Cannot read properties of null" and hide the cause.
        const errors = all?.json?.errors;
        if (Array.isArray(errors) && errors.length) {
          reject(
            new Error(
              `Reddit rejected submit to r/${firstPostSettings.value.subreddit}: ${errors
                .map((e: any) => (Array.isArray(e) ? e.slice(0, 2).join(' — ') : String(e)))
                .join('; ')}`
            )
          );
          return;
        }

        if (all?.json?.data?.id) {
          resolve(all.json.data);
          return;
        }

        const websocketUrl = all?.json?.data?.websocket_url;
        if (!websocketUrl) {
          reject(
            new Error(
              `Reddit submit to r/${firstPostSettings.value.subreddit} returned neither a post id nor a websocket_url`
            )
          );
          return;
        }

        const ws = new WebSocket(websocketUrl);
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ id: '', name: '', url: '' });
        }, 30_000);

        const finish = (result: { id: string; name: string; url: string }) => {
          clearTimeout(timeout);
          ws.close();
          resolve(result);
        };

        ws.on('message', (data: any) => {
          try {
            const parsedData = JSON.parse(data.toString());
            if (parsedData?.payload?.redirect) {
              const onlyId = parsedData?.payload?.redirect.replace(
                /https:\/\/www\.reddit\.com\/r\/.*?\/comments\/(.*?)\/.*/g,
                '$1'
              );
              finish({
                id: onlyId,
                name: `t3_${onlyId}`,
                url: parsedData?.payload?.redirect,
              });
            }
          } catch (err) {}
        });

        ws.on('error', () => finish({ id: '', name: '', url: '' }));
        ws.on('close', () => finish({ id: '', name: '', url: '' }));
      });

      valueArray.push({
        postId: redditId,
        releaseURL: url,
        id: post.id,
        status: 'published',
      });

      if (post.settings.subreddit.length > 1) {
        await timer(5000);
      }
    }

    return Object.values(groupBy(valueArray, (p) => p.id)).map((p) => ({
      id: p[0].id,
      postId: p.map((p) => p.postId).join(','),
      releaseURL: p.map((p) => p.releaseURL).join(','),
      status: 'published',
    }));
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<RedditSettingsDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;

    // Reddit uses thing_id format like t3_xxx for posts
    const thingId = postId.startsWith('t3_') ? postId : `t3_${postId}`;

    const {
      json: {
        data: {
          things: [
            {
              data: { id: commentId, permalink },
            },
          ],
        },
      },
    } = await (
      await this.fetch('https://oauth.reddit.com/api/comment', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          text: commentPost.message,
          thing_id: thingId,
          api_type: 'json',
        }),
      })
    ).json();

    return [
      {
        postId: commentId,
        releaseURL: 'https://www.reddit.com' + permalink,
        id: commentPost.id,
        status: 'published',
      },
    ];
  }

  @Tool({
    description: 'Get list of subreddits with information',
    dataSchema: [
      {
        key: 'word',
        type: 'string',
        description: 'Search subreddit by string',
      },
    ],
  })
  async subreddits(accessToken: string, data: any) {
    const {
      data: { children },
    } = await (
      await this.fetch(
        `https://oauth.reddit.com/subreddits/search?show=public&q=${data.word}&sort=activity&show_users=false&limit=10`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        'reddit',
        0,
        false
      )
    ).json();

    return children
      .filter(
        ({ data }: { data: any }) =>
          data.subreddit_type === 'public' && data.submission_type !== 'image'
      )
      .map(({ data: { title, url, id } }: any) => ({
        title,
        name: url,
        id,
      }));
  }

  private getPermissions(submissionType: string, allow_images: string) {
    const permissions = [];
    if (['any', 'self'].indexOf(submissionType) > -1) {
      permissions.push('self');
    }

    if (['any', 'link'].indexOf(submissionType) > -1) {
      permissions.push('link');
    }

    if (allow_images) {
      permissions.push('media');
    }

    return permissions;
  }

  @Tool({
    description: 'Get list of flairs and restrictions for a subreddit',
    dataSchema: [
      {
        key: 'subreddit',
        type: 'string',
        description: 'Search flairs and restrictions by subreddit key should be "/r/[name]"',
      },
    ],
  })
  async restrictions(accessToken: string, data: { subreddit: string }) {
    const {
      data: { submission_type, allow_images, ...all2 },
    } = await (
      await this.fetch(
        `https://oauth.reddit.com/${data.subreddit}/about`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        'reddit',
        0,
        false
      )
    ).json();

    const { is_flair_required, ...all } = await (
      await this.fetch(
        `https://oauth.reddit.com/api/v1/${
          data.subreddit.split('/r/')[1]
        }/post_requirements`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        'reddit',
        0,
        false
      )
    ).json();

    // eslint-disable-next-line no-async-promise-executor
    const newData = await new Promise<{ id: string; name: string }[]>(
      async (res) => {
        try {
          const flair = await (
            await this.fetch(
              `https://oauth.reddit.com/${data.subreddit}/api/link_flair_v2`,
              {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
              },
              'reddit',
              0,
              false
            )
          ).json();

          res(flair);
        } catch (err) {
          return res([]);
        }
      }
    );

    return {
      subreddit: data.subreddit,
      allow: this.getPermissions(submission_type, allow_images),
      is_flair_required: is_flair_required && newData.length > 0,
      flairs:
        newData?.map?.((p: any) => ({
          id: p.id,
          name: p.text,
        })) || [],
    };
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    try {
      // postId may be comma-separated for cross-posted Reddit posts; use the first
      const firstId = postId.split(',')[0];
      const thingId = firstId.startsWith('t3_') ? firstId : `t3_${firstId}`;

      const { data } = await (
        await this.fetch(
          `https://oauth.reddit.com/api/info?id=${thingId}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        )
      ).json();

      const post = data?.children?.[0]?.data;
      if (!post) return [];

      const result: AnalyticsData[] = [];

      if (post.score !== undefined) {
        result.push({
          label: 'Score',
          percentageChange: 0,
          data: [{ total: String(post.score), date: today }],
        });
      }

      if (post.ups !== undefined) {
        result.push({
          label: 'Upvotes',
          percentageChange: 0,
          data: [{ total: String(post.ups), date: today }],
        });
      }

      if (post.num_comments !== undefined) {
        result.push({
          label: 'Comments',
          percentageChange: 0,
          data: [{ total: String(post.num_comments), date: today }],
        });
      }

      if (post.upvote_ratio !== undefined) {
        result.push({
          label: 'Upvote Ratio',
          percentageChange: 0,
          data: [{ total: String(Math.round(post.upvote_ratio * 100)), date: today }],
        });
      }

      return result;
    } catch (err) {
      console.error('Error fetching Reddit post analytics:', err);
      return [];
    }
  }

  async accountMetrics(
    integrationId: string,
    accessToken: string
  ): Promise<AccountMetrics | null> {
    try {
      const { link_karma, comment_karma, total_karma } = await (
        await this.fetch('https://oauth.reddit.com/api/v1/me', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        })
      ).json();

      const result: AccountMetrics = {};
      if (total_karma !== undefined) result.karma = total_karma;
      if (link_karma !== undefined) result.linkKarma = link_karma;
      if (comment_karma !== undefined) result.commentKarma = comment_karma;
      return Object.keys(result).length > 0 ? result : null;
    } catch (err) {
      console.error('Error fetching Reddit account metrics:', err);
      return null;
    }
  }
}
