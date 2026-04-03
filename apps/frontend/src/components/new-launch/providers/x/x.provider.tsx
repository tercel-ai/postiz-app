'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { ThreadFinisher } from '@gitroom/frontend/components/new-launch/finisher/thread.finisher';
import { Select } from '@gitroom/react/form/select';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { XDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/x.dto';
import { Input } from '@gitroom/react/form/input';
import { useCustomProviderFunction } from '@gitroom/frontend/components/launches/helpers/use.custom.provider.function';
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';

const whoCanReply = [
  {
    label: 'Everyone',
    value: 'everyone',
  },
  {
    label: 'Accounts you follow',
    value: 'following',
  },
  {
    label: 'Mentioned accounts',
    value: 'mentionedUsers',
  },
  {
    label: 'Subscribers',
    value: 'subscribers',
  },
  {
    label: 'Verified accounts',
    value: 'verified',
  },
];

const QuoteTweetPreview = ({ url }: { url: string }) => {
  const { get } = useCustomProviderFunction();
  const [tweet, setTweet] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const lastUrlRef = useRef('');

  const fetchTweet = useCallback(
    async (tweetUrl: string) => {
      if (!tweetUrl || lastUrlRef.current === tweetUrl) return;
      lastUrlRef.current = tweetUrl;
      setLoading(true);
      try {
        const result = await get('fetchTweet', { url: tweetUrl });
        setTweet(result);
      } catch {
        setTweet(null);
      } finally {
        setLoading(false);
      }
    },
    [get]
  );

  useEffect(() => {
    const clean = url?.split('?')[0] || '';
    if (/^https:\/\/(x|twitter)\.com\/\w+\/status\/\d+$/.test(clean)) {
      const timer = setTimeout(() => fetchTweet(clean), 500);
      return () => clearTimeout(timer);
    } else {
      setTweet(null);
      lastUrlRef.current = '';
    }
  }, [url, fetchTweet]);

  if (loading) {
    return (
      <div className="text-xs text-gray-400 mb-3">Loading tweet preview...</div>
    );
  }

  if (!tweet) return null;

  return (
    <div className="mb-3 rounded-lg border border-gray-700 p-3 text-sm">
      <div className="flex items-center gap-2 mb-1">
        {tweet.author?.profileImageUrl && (
          <img
            src={tweet.author.profileImageUrl}
            alt=""
            className="w-5 h-5 rounded-full"
          />
        )}
        <span className="font-semibold text-white">
          {tweet.author?.name}
        </span>
        <span className="text-gray-400">@{tweet.author?.username}</span>
      </div>
      <p className="text-gray-300 whitespace-pre-wrap">{tweet.text}</p>
      {tweet.media?.length > 0 && (
        <div className="flex gap-1 mt-2 overflow-hidden rounded">
          {tweet.media.map((m: any, i: number) => (
            <img
              key={i}
              src={m.url}
              alt=""
              className="max-h-[120px] rounded object-cover"
            />
          ))}
        </div>
      )}
    </div>
  );
};

const SettingsComponent = () => {
  const t = useT();
  const { register, watch, setValue } = useSettings();
  const quoteUrl = watch('quote_tweet_url');

  return (
    <>
      <Select
        label={t(
          'label_who_can_reply_to_this_post',
          'Who can reply to this post?'
        )}
        className="mb-5"
        hideErrors={true}
        {...register('who_can_reply_post', {
          value: 'everyone',
        })}
      >
        {whoCanReply.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </Select>

      <Input
        label={t('quote_tweet_url', 'Quote Tweet URL (uses ~24 chars from limit)')}
        placeholder="https://x.com/user/status/123456"
        className="mb-2"
        {...register('quote_tweet_url')}
      />
      <QuoteTweetPreview url={quoteUrl} />

      <Input
        label={
          'Post to a community, URL (Ex: https://x.com/i/communities/1493446837214187523)'
        }
        {...register('community')}
      />

      <ThreadFinisher />
    </>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: SettingsComponent,
  CustomPreviewComponent: undefined,
  dto: XDto,
  checkValidity: async (posts, settings, additionalSettings: any) => {
    const premium =
      additionalSettings?.find((p: any) => p?.title === 'Verified')?.value ||
      false;
    if (posts?.some((p) => (p?.length ?? 0) > 4)) {
      return 'There can be maximum 4 pictures in a post.';
    }
    if (
      posts?.some(
        (p) => p?.some((m) => (m?.path?.indexOf?.('mp4') ?? -1) > -1) && (p?.length ?? 0) > 1
      )
    ) {
      return 'There can be maximum 1 video in a post.';
    }
    for (const load of posts?.flatMap((p) => p?.flatMap((a) => a?.path)) ?? []) {
      if ((load?.indexOf?.('mp4') ?? -1) > -1) {
        const isValid = await checkVideoDuration(load, premium);
        if (!isValid) {
          return 'Video duration must be less than or equal to 140 seconds.';
        }
      }
    }
    return true;
  },
  maximumCharacters: (settings) => {
    if (settings?.[0]?.value) {
      return 4000;
    }
    return 280;
  },
});
const checkVideoDuration = async (
  url: string,
  isPremium = false
): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = url;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      // Check if the duration is less than or equal to 140 seconds
      const duration = video.duration;
      if ((!isPremium && duration <= 140) || isPremium) {
        resolve(true); // Video duration is acceptable
      } else {
        resolve(false); // Video duration exceeds 140 seconds
      }
    };
    video.onerror = () => {
      reject(new Error('Failed to load video metadata.'));
    };
  });
};
