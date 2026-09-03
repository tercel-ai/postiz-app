import 'reflect-metadata';

import { Injectable } from '@nestjs/common';
import { XProvider } from '@gitroom/nestjs-libraries/integrations/social/x.provider';
import { SocialProvider } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { LinkedinProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.provider';
import { RedditProvider } from '@gitroom/nestjs-libraries/integrations/social/reddit.provider';
import { DevToProvider } from '@gitroom/nestjs-libraries/integrations/social/dev.to.provider';
import { HashnodeProvider } from '@gitroom/nestjs-libraries/integrations/social/hashnode.provider';
import { MediumProvider } from '@gitroom/nestjs-libraries/integrations/social/medium.provider';
import { FacebookProvider } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { YoutubeProvider } from '@gitroom/nestjs-libraries/integrations/social/youtube.provider';
import { TiktokProvider } from '@gitroom/nestjs-libraries/integrations/social/tiktok.provider';
import { PinterestProvider } from '@gitroom/nestjs-libraries/integrations/social/pinterest.provider';
import { DribbbleProvider } from '@gitroom/nestjs-libraries/integrations/social/dribbble.provider';
import { LinkedinPageProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.page.provider';
import { ThreadsProvider } from '@gitroom/nestjs-libraries/integrations/social/threads.provider';
import { DiscordProvider } from '@gitroom/nestjs-libraries/integrations/social/discord.provider';
import { SlackProvider } from '@gitroom/nestjs-libraries/integrations/social/slack.provider';
import { MastodonProvider } from '@gitroom/nestjs-libraries/integrations/social/mastodon.provider';
import { MastodonCustomProvider } from '@gitroom/nestjs-libraries/integrations/social/mastodon.custom.provider';
import { BlueskyProvider } from '@gitroom/nestjs-libraries/integrations/social/bluesky.provider';
import { LemmyProvider } from '@gitroom/nestjs-libraries/integrations/social/lemmy.provider';
import { InstagramStandaloneProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.standalone.provider';
import { FarcasterProvider } from '@gitroom/nestjs-libraries/integrations/social/farcaster.provider';
import { TelegramProvider } from '@gitroom/nestjs-libraries/integrations/social/telegram.provider';
import { NostrProvider } from '@gitroom/nestjs-libraries/integrations/social/nostr.provider';
import { VkProvider } from '@gitroom/nestjs-libraries/integrations/social/vk.provider';
import { WordpressProvider } from '@gitroom/nestjs-libraries/integrations/social/wordpress.provider';
import { ListmonkProvider } from '@gitroom/nestjs-libraries/integrations/social/listmonk.provider';
import { GmbProvider } from '@gitroom/nestjs-libraries/integrations/social/gmb.provider';
import { KickProvider } from '@gitroom/nestjs-libraries/integrations/social/kick.provider';
import { TwitchProvider } from '@gitroom/nestjs-libraries/integrations/social/twitch.provider';
import { HackernewsProvider } from '@gitroom/nestjs-libraries/integrations/social/hackernews.provider';
import { QuoraProvider } from '@gitroom/nestjs-libraries/integrations/social/quora.provider';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { EXTENSION_PUBLISHABLE_PLATFORMS } from '@gitroom/helpers/extension/post-publish';

export const socialIntegrationList: Array<SocialAbstract & SocialProvider> = [
  new XProvider(),
  new LinkedinProvider(),
  new LinkedinPageProvider(),
  new RedditProvider(),
  new InstagramProvider(),
  new InstagramStandaloneProvider(),
  new FacebookProvider(),
  new ThreadsProvider(),
  new YoutubeProvider(),
  new GmbProvider(),
  new TiktokProvider(),
  new PinterestProvider(),
  new DribbbleProvider(),
  new DiscordProvider(),
  new SlackProvider(),
  new KickProvider(),
  new TwitchProvider(),
  new MastodonProvider(),
  new BlueskyProvider(),
  new LemmyProvider(),
  new FarcasterProvider(),
  new TelegramProvider(),
  new NostrProvider(),
  new VkProvider(),
  new MediumProvider(),
  new DevToProvider(),
  new HashnodeProvider(),
  // Extension-published (no server write API) — see each provider's extensionPublish flag.
  new HackernewsProvider(),
  new QuoraProvider(),
  new WordpressProvider(),
  new ListmonkProvider(),
  new MastodonCustomProvider(),
];

// Publishing routing (see isExtensionPublish): a platform publishes via the
// BROWSER EXTENSION rather than the backend either because it has no usable
// server write API at all (intrinsic — the provider's `extensionPublish` flag,
// e.g. hackernews/quora/medium) OR because an operator prefers the in-browser
// session path for a platform that CAN also use the backend API (settings
// override — the EXTENSION_PUBLISH_PLATFORMS allowlist, e.g. forcing x to the
// extension to dodge API cost / limits). The intrinsic flag can never be turned
// off; the env allowlist only ADDS dual-capable platforms.
//
// SYNC GUARD: whatever the flag/env say, routing is INTERSECTED with
// EXTENSION_PUBLISHABLE_PLATFORMS — the shared list of what the extension queue
// can actually publish. A platform the extension can't publish (e.g. a stray
// `EXTENSION_PUBLISH_PLATFORMS=devto`) is NOT diverted: it keeps the backend
// path instead of stranding in QUEUE with no executor.
const EXTENSION_PUBLISHABLE = new Set<string>(EXTENSION_PUBLISHABLE_PLATFORMS);
const ENV_EXTENSION_PUBLISH_PLATFORMS: string[] = (
  process.env.EXTENSION_PUBLISH_PLATFORMS ?? ''
)
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);

/**
 * The send path a post takes when it carries NO explicit publishMethod.
 *
 * Now 'extension' by default: the in-browser session path is the direction this
 * product is going and the backend API path is slated for removal, so a post
 * that does not choose goes to the extension for every platform the extension
 * can actually publish. EXTENSION_PUBLISH_PLATFORMS is therefore redundant for
 * those platforms (they are all routed already) and stays only for back-compat.
 *
 * OPERATIONAL ESCAPE HATCH: `DEFAULT_PUBLISH_METHOD=api` restores the previous
 * behaviour — divert only the platforms with no server write API at all, plus
 * whatever EXTENSION_PUBLISH_PLATFORMS names. Set it if the extension fleet is
 * down: without it, unchosen posts on the seven publishable platforms simply
 * wait in QUEUE for a browser that is not coming. An explicit
 * publishMethod=API on a post always wins over this default either way.
 */
const DEFAULT_TO_EXTENSION =
  (process.env.DEFAULT_PUBLISH_METHOD ?? 'extension').trim().toLowerCase() !==
  'api';

/**
 * Whether a provider identifier publishes through the browser extension instead
 * of the backend post workflow. Standalone (not an instance method) so callers
 * without the DI'd manager — including the post workflow's scheduling divert —
 * can use it. (`extensionPublish` flag OR EXTENSION_PUBLISH_PLATFORMS allowlist)
 * AND the extension can actually publish it (EXTENSION_PUBLISHABLE_PLATFORMS).
 */
export function isExtensionPublishProvider(providerIdentifier: string): boolean {
  const id = (providerIdentifier || '').toLowerCase();
  // The SYNC GUARD, unchanged and load-bearing: a platform the extension cannot
  // publish is never diverted, whatever the defaults say. Diverting one would
  // strand its posts in QUEUE with no executor — a silent stall, strictly worse
  // than publishing them through the backend.
  if (!id || !EXTENSION_PUBLISHABLE.has(id)) return false;
  const provider = socialIntegrationList.find((p) => p.identifier === id);
  if (provider?.extensionPublish) return true;
  if (DEFAULT_TO_EXTENSION) return true;
  return ENV_EXTENSION_PUBLISH_PLATFORMS.includes(id);
}

/**
 * The provider identifiers currently routed to the extension, ∩ publishable.
 * With the default send path set to the extension that is simply every
 * publishable platform; under DEFAULT_PUBLISH_METHOD=api it narrows back to
 * (intrinsic flag ∪ env allowlist). Must stay in agreement with
 * {@link isExtensionPublishProvider} — this list is what the publish-due query
 * matches legacy null-method posts against, so a platform routed by one and not
 * the other is a post that is never published by either path.
 */
export function extensionPublishProviderIds(): string[] {
  if (DEFAULT_TO_EXTENSION) return [...EXTENSION_PUBLISHABLE_PLATFORMS];
  const fromFlag = socialIntegrationList
    .filter((p) => p.extensionPublish)
    .map((p) => p.identifier);
  return Array.from(new Set([...fromFlag, ...ENV_EXTENSION_PUBLISH_PLATFORMS])).filter(
    (id) => EXTENSION_PUBLISHABLE.has(id)
  );
}

/** The persisted send-path decision (matches the Prisma PublishMethod enum, lowercased). */
export type PublishMethod = 'extension' | 'api';

/**
 * Thrown by {@link resolvePublishMethod} when the requested/derived method is
 * not achievable for a post. `code` is a stable machine string the API surfaces
 * per-post so the UI can prompt the right fix (e.g. connect an account).
 */
export class PublishMethodError extends Error {
  constructor(
    public readonly code:
      | 'ACCOUNT_BINDING_REQUIRED'
      | 'PLATFORM_NOT_EXTENSION_PUBLISHABLE',
    message: string
  ) {
    super(message);
    this.name = 'PublishMethodError';
  }
}

/**
 * Whether a platform intrinsically has NO usable backend write API and therefore
 * can ONLY be published through the extension (the provider's `extensionPublish`
 * flag — hackernews/medium/quora). Distinct from the env allowlist, which merely
 * PREFERS the extension for a platform that could also use the backend API.
 */
export function isExtensionOnlyProvider(providerIdentifier: string): boolean {
  const id = (providerIdentifier || '').toLowerCase();
  return !!socialIntegrationList.find((p) => p.identifier === id)?.extensionPublish;
}

/** Whether the browser extension can publish this platform in-browser at all. */
export function isExtensionPublishablePlatform(providerIdentifier: string): boolean {
  return EXTENSION_PUBLISHABLE.has((providerIdentifier || '').toLowerCase());
}

/**
 * Resolve the single send-path for a post at schedule time. This is the ONE
 * place both send paths agree on, so the same input can never route to two
 * executors (the double-publish guard). Capability model:
 *   - extensionCapable = platform is in EXTENSION_PUBLISHABLE_PLATFORMS.
 *   - apiCapable       = a social account is bound AND the platform is not
 *                        extension-only (it has a usable backend write API).
 * Rules:
 *   - explicit 'api'        -> require apiCapable, else ACCOUNT_BINDING_REQUIRED.
 *   - explicit 'extension'  -> require extensionCapable, else PLATFORM_NOT_EXTENSION_PUBLISHABLE.
 *   - no choice: the only capable path wins; when BOTH are capable (e.g. X with a
 *     bound account) default to 'extension' (personal-session posting, dodging
 *     API cost/limits); when NEITHER is capable -> ACCOUNT_BINDING_REQUIRED.
 */
export function resolvePublishMethod(input: {
  platform: string;
  hasBoundIntegration: boolean;
  choice?: PublishMethod | null;
}): PublishMethod {
  const platform = (input.platform || '').toLowerCase();
  const extensionCapable = EXTENSION_PUBLISHABLE.has(platform);
  const apiCapable = input.hasBoundIntegration && !isExtensionOnlyProvider(platform);

  if (input.choice === 'api') {
    if (!apiCapable) {
      throw new PublishMethodError(
        'ACCOUNT_BINDING_REQUIRED',
        `Cannot publish ${platform || 'this post'} via API: connect a ${platform || 'social'} account first`
      );
    }
    return 'api';
  }
  if (input.choice === 'extension') {
    if (!extensionCapable) {
      throw new PublishMethodError(
        'PLATFORM_NOT_EXTENSION_PUBLISHABLE',
        `${platform || 'This platform'} cannot be published by the browser extension`
      );
    }
    return 'extension';
  }

  // Auto: the only capable path wins; both -> extension; neither -> needs binding.
  if (extensionCapable) return 'extension';
  if (apiCapable) return 'api';
  throw new PublishMethodError(
    'ACCOUNT_BINDING_REQUIRED',
    `Cannot publish ${platform || 'this post'}: connect a ${platform || 'social'} account first`
  );
}

@Injectable()
export class IntegrationManager {
  /** Instance passthrough to {@link isExtensionPublishProvider}. */
  isExtensionPublish(providerIdentifier: string): boolean {
    return isExtensionPublishProvider(providerIdentifier);
  }

  /** Instance passthrough to {@link extensionPublishProviderIds}. */
  extensionPublishProviderIds(): string[] {
    return extensionPublishProviderIds();
  }

  async getAllIntegrations() {
    return {
      social: await Promise.all(
        socialIntegrationList.map(async (p) => ({
          name: p.name,
          identifier: p.identifier,
          toolTip: p.toolTip,
          editor: p.editor,
          isExternal: !!p.externalUrl,
          isWeb3: !!p.isWeb3,
          ...(p.customFields ? { customFields: await p.customFields() } : {}),
        }))
      ),
      article: [] as any[],
    };
  }

  getAllTools(): {
    [key: string]: {
      description: string;
      dataSchema: any;
      methodName: string;
    }[];
  } {
    return socialIntegrationList.reduce(
      (all, current) => ({
        ...all,
        [current.identifier]:
          Reflect.getMetadata('custom:tool', current.constructor.prototype) ||
          [],
      }),
      {}
    );
  }

  getAllRulesDescription(): {
    [key: string]: string;
  } {
    return socialIntegrationList.reduce(
      (all, current) => ({
        ...all,
        [current.identifier]:
          Reflect.getMetadata(
            'custom:rules:description',
            current.constructor
          ) || '',
      }),
      {}
    );
  }

  getAllPlugs() {
    return socialIntegrationList
      .map((p) => {
        return {
          name: p.name,
          identifier: p.identifier,
          plugs: (
            Reflect.getMetadata('custom:plug', p.constructor.prototype) || []
          )
            .filter((f: any) => !f.disabled)
            .map((p: any) => ({
              ...p,
              fields: p.fields.map((c: any) => ({
                ...c,
                validation: c?.validation?.toString(),
              })),
            })),
        };
      })
      .filter((f) => f.plugs.length);
  }

  getInternalPlugs(providerName: string) {
    const p = socialIntegrationList.find((p) => p.identifier === providerName)!;
    return {
      internalPlugs:
        (
          Reflect.getMetadata(
            'custom:internal_plug',
            p.constructor.prototype
          ) || []
        ).filter((f: any) => !f.disabled) || [],
    };
  }

  getAllowedSocialsIntegrations() {
    return socialIntegrationList.map((p) => p.identifier);
  }
  // Lean {identifier, name} list of every registered social provider — for admin
  // pickers (e.g. the operation-plan platform allowlist in aisee-manage) that
  // need the full provider set from a single source of truth instead of a
  // hardcoded subset that drifts as providers are added/removed.
  getSocialProviderList() {
    return socialIntegrationList.map((p) => ({
      identifier: p.identifier,
      name: p.name,
      // Static send-path capability, for the scheduling UI to render the method
      // choice. `extensionPublishable` = the browser extension can publish it
      // in-browser; `hasWriteApi` = it has a usable backend write API (false for
      // extension-only platforms like hackernews/medium/quora). The DYNAMIC half
      // — whether THIS org has a bound account (apiCapable) — the client derives
      // by intersecting `hasWriteApi` with its own integrations list. The backend
      // still enforces the full rules at commit time (resolvePublishMethod).
      extensionPublishable: isExtensionPublishablePlatform(p.identifier),
      hasWriteApi: !p.extensionPublish,
    }));
  }
  getSocialIntegration(integration: string): SocialProvider {
    return socialIntegrationList.find((i) => i.identifier === integration)!;
  }
}
