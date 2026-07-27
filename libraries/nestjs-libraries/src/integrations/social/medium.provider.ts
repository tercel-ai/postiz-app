import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { BadBody, SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { MediumSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/medium.settings.dto';

/**
 * Medium integration. Medium DISCONTINUED its integration-token write API
 * (api.medium.com no longer issues tokens), so — like hackernews/quora — Medium
 * is published by the BROWSER EXTENSION (in-browser, with the user's own
 * medium.com session) — see apps/extension .../medium.poster.ts. This provider
 * is therefore `extensionPublish` and connects with just the Medium @handle (no
 * dead api-key), so it is a first-class channel (connect, bind Posts, close the
 * metrics loop via the extension's demand-driven metrics-due path); server-side
 * `post()` cannot publish and throws to park a scheduled post.
 */
export class MediumProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Medium has lenient publishing limits
  identifier = 'medium';
  name = 'Medium';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'markdown' as const;
  extensionPublish = true;
  dto = MediumSettingsDto;
  maxLength() {
    return 100000;
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: '',
      codeVerifier: makeId(10),
      state,
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

  async customFields() {
    return [
      {
        key: 'username',
        label: 'Medium @username',
        validation: `/^@?[^/\\s]{2,}$/`,
        type: 'text' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    // No secret: publishing is done by the extension with the user's session.
    // Medium has no simple public handle-validation endpoint (the /feed/@user
    // RSS is unreliable as a check), so — like Quora — the @handle is accepted
    // as entered and doubles as the tracked scan key.
    let username = '';
    try {
      username = String(
        JSON.parse(Buffer.from(params.code, 'base64').toString()).username || ''
      )
        .trim()
        .replace(/^@/, '');
    } catch {
      return 'Invalid credentials';
    }
    if (!username) return 'Invalid credentials';

    return {
      accessToken: username,
      refreshToken: '',
      expiresIn: 100 * 365 * 24 * 60 * 60,
      id: username,
      name: username,
      picture: '',
      username,
    };
  }

  async post(
    _id: string,
    _accessToken: string,
    postDetails: PostDetails[],
    _integration: Integration
  ): Promise<PostResponse[]> {
    // Medium's write API is discontinued — the browser extension publishes it.
    // A scheduled post reaching the server can't be published here, so park it
    // (bad_body is terminal + user-notified in the post workflow).
    throw new BadBody(
      this.identifier,
      '{}',
      JSON.stringify(postDetails?.[0] ?? {}),
      'Medium is published through the aisee browser extension, not the server (Medium discontinued its write API). Open the aisee app with the extension installed and signed in to Medium to publish this post.'
    );
  }
}
