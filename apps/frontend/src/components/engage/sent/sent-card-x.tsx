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
    // Flat, normalized metrics from the API (preferred over parsing `analytics`).
    metrics?: {
      impressions?: number;
      likes?: number;
      retweets?: number;
      replies?: number;
      quotes?: number;
      bookmarks?: number;
      trafficScore?: number;
    };
  };
  opportunity: {
    platform: string;
    externalPostUrl: string;
    postContent: string;
    authorUsername: string;
    authorDisplayName?: string;
    authorFollowers?: number | null;
    authorAvatarUrl?: string | null;
    matchedKeywords?: string[];
  };
}

// Compact follower count: 4747631 → "4.7M", 12400 → "12.4K".
function formatFollowers(n?: number | null): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface SentCardXProps {
  reply: SentReply;
  sentReplyId: string;
  onSubmitUrl?: (id: string) => void;
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

export const SentCardX: FC<SentCardXProps> = ({ reply, sentReplyId, onSubmitUrl }) => {
  const { post, opportunity } = reply;
  const analytics = post.analytics;
  const m = post.metrics;
  const noUrl = !post.releaseURL;

  // Prefer the flat `metrics` object; fall back to parsing `analytics` so the
  // card still works against an older API response.
  const impressions = m?.impressions ?? post.impressions ?? getMetric(analytics, /impression|views/i);
  const likes = m?.likes ?? getMetric(analytics, /like|reaction/i);
  const retweets = m?.retweets ?? getMetric(analytics, /retweet|repost/i);
  const replies = m?.replies ?? getMetric(analytics, /reply|comment/i);
  const bookmarks = m?.bookmarks ?? getMetric(analytics, /bookmark|save/i);

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
        {noUrl && (
          <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
            ⚠ 未提交回复链接
          </span>
        )}
        {reply.authorReplied && (
          <span className="text-xs bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded">
            Author replied ✓
          </span>
        )}
        <span className="text-xs text-gray-500 ml-auto">
          {new Date(post.publishDate).toLocaleDateString()}
        </span>
      </div>

      {/* Original author + post snippet */}
      <div className="flex items-center gap-2 mb-1">
        {opportunity.authorAvatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={opportunity.authorAvatarUrl}
            alt={opportunity.authorUsername}
            className="w-5 h-5 rounded-full shrink-0"
          />
        )}
        <span className="text-xs text-gray-400 truncate">
          {opportunity.authorDisplayName || opportunity.authorUsername}
          <span className="text-gray-600"> @{opportunity.authorUsername}</span>
        </span>
        {formatFollowers(opportunity.authorFollowers) && (
          <span className="text-xs text-gray-600 shrink-0">
            · {formatFollowers(opportunity.authorFollowers)} followers
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-1 truncate">
        {opportunity.postContent.slice(0, 60)}…
      </p>

      {/* Matched keywords — why this opportunity surfaced */}
      {opportunity.matchedKeywords && opportunity.matchedKeywords.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mb-2">
          {opportunity.matchedKeywords.map((kw) => (
            <span
              key={kw}
              className="text-xs bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded"
              title="Matched keyword"
            >
              # {kw}
            </span>
          ))}
        </div>
      )}

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

      {noUrl && onSubmitUrl && (
        <button
          onClick={() => onSubmitUrl(sentReplyId)}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors mt-2 block"
        >
          + Submit reply URL
        </button>
      )}

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
