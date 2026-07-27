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
 * Whether a provider identifier publishes through the browser extension instead
 * of the backend post workflow. Standalone (not an instance method) so callers
 * without the DI'd manager — including the post workflow's scheduling divert —
 * can use it. (`extensionPublish` flag OR EXTENSION_PUBLISH_PLATFORMS allowlist)
 * AND the extension can actually publish it (EXTENSION_PUBLISHABLE_PLATFORMS).
 */
export function isExtensionPublishProvider(providerIdentifier: string): boolean {
  const id = (providerIdentifier || '').toLowerCase();
  if (!id || !EXTENSION_PUBLISHABLE.has(id)) return false;
  const provider = socialIntegrationList.find((p) => p.identifier === id);
  if (provider?.extensionPublish) return true;
  return ENV_EXTENSION_PUBLISH_PLATFORMS.includes(id);
}

/** The provider identifiers currently routed to the extension (flag ∪ env), ∩ publishable. */
export function extensionPublishProviderIds(): string[] {
  const fromFlag = socialIntegrationList
    .filter((p) => p.extensionPublish)
    .map((p) => p.identifier);
  return Array.from(new Set([...fromFlag, ...ENV_EXTENSION_PUBLISH_PLATFORMS])).filter(
    (id) => EXTENSION_PUBLISHABLE.has(id)
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
    }));
  }
  getSocialIntegration(integration: string): SocialProvider {
    return socialIntegrationList.find((i) => i.identifier === integration)!;
  }
}
