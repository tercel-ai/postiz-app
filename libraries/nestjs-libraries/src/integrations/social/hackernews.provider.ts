import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  ReferencePostSettingsContext,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { HackernewsSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/hackernews.settings.dto';

/**
 * Hacker News integration. HN has NO write API, so posts are published by the
 * BROWSER EXTENSION (in-browser, with the user's own news.ycombinator.com
 * session) — see apps/extension .../hackernews.poster.ts. The backend provider
 * exists so HN is a first-class channel in the Integration model (connect,
 * bind Posts, close the metrics loop via the extension's demand-driven
 * metrics-due path); server-side `post()` cannot publish and throws to park a
 * scheduled post with a clear message.
 *
 * Connection carries no secret — the real auth is the user's browser session —
 * so it "connects" with just the HN username (validated against HN's public
 * Firebase user API), stored as the integration identity + used as the tracked
 * scan handle.
 */
export class HackernewsProvider extends SocialAbstract implements SocialProvider {
  identifier = 'hackernews';
  name = 'Hacker News';
  isBetweenSteps = false;
  editor = 'normal' as const;
  scopes = [] as string[];
  extensionPublish = true;
  dto = HackernewsSettingsDto;

  override buildReferencePostSettings(
    context: ReferencePostSettingsContext
  ): Record<string, unknown> {
    return { __type: this.identifier, title: context.title };
  }

  maxLength() {
    // HN item text has no hard cap the way tweets do; keep it generous.
    return 20000;
  }

  async generateAuthUrl() {
    return {
      url: '',
      codeVerifier: makeId(10),
      state: makeId(6),
    };
  }

  async customFields() {
    return [
      {
        key: 'username',
        label: 'Hacker News username',
        validation: `/^[a-zA-Z0-9_-]{2,}$/`,
        type: 'text' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    let username = '';
    try {
      username = String(
        JSON.parse(Buffer.from(params.code, 'base64').toString()).username || ''
      ).trim();
    } catch {
      return 'Invalid credentials';
    }
    if (!username) return 'Invalid credentials';

    // Validate the handle against HN's public user API (case-sensitive ids).
    try {
      const user = await (
        await fetch(
          `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(
            username
          )}.json`
        )
      ).json();
      if (!user || !user.id) return 'Hacker News user not found';
      username = user.id;
    } catch {
      return 'Could not reach Hacker News to validate the username';
    }

    return {
      // No secret: publishing is done by the extension with the user's session.
      // The username doubles as the token/id so downstream code has a stable key.
      accessToken: username,
      refreshToken: '',
      expiresIn: 100 * 365 * 24 * 60 * 60,
      id: username,
      name: username,
      picture: '',
      username,
    };
  }

  async refreshToken(_refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async post(
    _id: string,
    _accessToken: string,
    postDetails: PostDetails[],
    _integration: Integration
  ): Promise<PostResponse[]> {
    // HN has no write API — the browser extension publishes it. A scheduled post
    // reaching the server can't be published here, so park it (bad_body is
    // terminal + user-notified in the post workflow, never crash-looped).
    throw new BadBody(
      this.identifier,
      '{}',
      JSON.stringify(postDetails?.[0] ?? {}),
      'Hacker News is published through the aisee browser extension, not the server. Open the aisee app with the extension installed and signed in to Hacker News to publish this post.'
    );
  }
}
