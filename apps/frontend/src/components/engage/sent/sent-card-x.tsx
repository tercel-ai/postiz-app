'use client';

import { FC } from 'react';

interface SentReply {
  id: string;
  authorReplied: boolean;
  post: {
    id: string;
    content: string;
    state: string;
    releaseURL?: string | null;
    publishDate: string;
    impressions?: number;
    trafficScore?: number;
    analytics?: Array<{ label: string; data: Array<{ total: string }> }>;
  };
  opportunity: {
    platform: string;
    externalPostUrl: string;
    postContent: string;
    authorUsername: string;
  };
}

interface SentCardXProps {
  reply: SentReply;
}

function getMetric(
  analytics: SentReply['post']['analytics'],
  pattern: RegExp
): number {
  if (!analytics) return 0;
  const entry = analytics.find((a) => pattern.test(a.label));
  return Number(entry?.data?.[0]?.total ?? 0);
}

function stateBadge(state: string) {
  if (state === 'PUBLISHED') return 'bg-green-500/20 text-green-400';
  if (state === 'QUEUE') return 'bg-yellow-500/20 text-yellow-400';
  if (state === 'ERROR') return 'bg-red-500/20 text-red-400';
  return 'bg-gray-500/20 text-gray-400';
}

export const SentCardX: FC<SentCardXProps> = ({ reply }) => {
  const { post, opportunity } = reply;
  const analytics = post.analytics;

  const impressions = post.impressions ?? getMetric(analytics, /impression|views/i);
  const likes = getMetric(analytics, /like|reaction/i);
  const retweets = getMetric(analytics, /retweet|repost/i);
  const replies = getMetric(analytics, /reply|comment/i);
  const bookmarks = getMetric(analytics, /bookmark|save/i);

  return (
    <div className="bg-[#1a2035] rounded-lg p-4 border-l-4 border-l-white">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs bg-gray-800 text-white px-1.5 py-0.5 rounded uppercase font-medium">
          X
        </span>
        <span
          className={`text-xs px-1.5 py-0.5 rounded font-medium ${stateBadge(post.state)}`}
        >
          {post.state}
        </span>
        {reply.authorReplied && (
          <span className="text-xs bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded">
            Author replied ✓
          </span>
        )}
        <span className="text-xs text-gray-500 ml-auto">
          {new Date(post.publishDate).toLocaleDateString()}
        </span>
      </div>

      {/* Original post snippet */}
      <p className="text-xs text-gray-500 mb-1 truncate">
        @{opportunity.authorUsername}: {opportunity.postContent.slice(0, 60)}…
      </p>

      {/* Reply content */}
      <p className="text-sm text-gray-200 line-clamp-2 mb-3">{post.content}</p>

      {/* Metrics */}
      <div className="grid grid-cols-5 gap-2">
        {[
          { icon: '👁', label: 'Impressions', value: impressions, color: 'text-blue-400' },
          { icon: '♥', label: 'Likes', value: likes, color: 'text-red-400' },
          { icon: '🔁', label: 'Retweets', value: retweets, color: 'text-green-400' },
          { icon: '💬', label: 'Replies', value: replies, color: 'text-yellow-600' },
          { icon: '🔖', label: 'Bookmarks', value: bookmarks, color: 'text-purple-400' },
        ].map((m) => (
          <div key={m.label} className="text-center bg-[#0f1219] rounded-lg p-2">
            <div className="text-lg leading-none mb-0.5">{m.icon}</div>
            <div className={`text-sm font-bold ${m.color}`}>{m.value}</div>
            <div className="text-xs text-gray-600">{m.label}</div>
          </div>
        ))}
      </div>

      {(() => {
        const raw = post.releaseURL ?? '';
        // Render only when releaseURL is a full http(s) URL or a bare numeric
        // tweet id — anything else (empty string, internal id, malformed path)
        // would silently produce a broken https://x.com/i/web/status/...  link.
        const href = raw.startsWith('http')
          ? raw
          : /^\d+$/.test(raw)
          ? `https://x.com/i/web/status/${raw}`
          : null;
        if (!href) return null;
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline mt-2 block"
          >
            View on X ↗
          </a>
        );
      })()}
    </div>
  );
};
