import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { BadBody, SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { QuoraSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/quora.settings.dto';

/**
 * Quora integration. Quora has NO API at all, so posts are published by the
 * BROWSER EXTENSION (in-browser, with the user's own quora.com session) — see
 * apps/extension .../quora.poster.ts. The backend provider exists so Quora is a
 * first-class channel in the Integration model (connect, bind Posts, close the
 * metrics loop via the extension's demand-driven metrics-due path); server-side
 * `post()` cannot publish and throws to park a scheduled post.
 *
 * Connection carries no secret (the real auth is the browser session), so it
 * "connects" with just the Quora profile slug, stored as the integration
 * identity + used as the tracked scan handle. Quora has no public API to
 * validate the handle against, so it is accepted as entered.
 */
export class QuoraProvider extends SocialAbstract implements SocialProvider {
  identifier = 'quora';
  name = 'Quora';
  isBetweenSteps = false;
  editor = 'normal' as const;
  scopes = [] as string[];
  extensionPublish = true;
  dto = QuoraSettingsDto;
  maxLength() {
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
        label: 'Quora profile name (e.g. Jane-Doe)',
        validation: `/^[^/\\s]{2,}$/`,
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
      )
        .trim()
        .replace(/^\/?profile\//, '')
        .replace(/^\/+|\/+$/g, '');
    } catch {
      return 'Invalid credentials';
    }
    if (!username) return 'Invalid credentials';

    return {
      accessToken: username,
      refreshToken: '',
      expiresIn: 100 * 365 * 24 * 60 * 60,
      id: username,
      name: username.replace(/-/g, ' '),
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
    throw new BadBody(
      this.identifier,
      '{}',
      JSON.stringify(postDetails?.[0] ?? {}),
      'Quora is published through the aisee browser extension, not the server. Open the aisee app with the extension installed and signed in to Quora to publish this post.'
    );
  }
}
