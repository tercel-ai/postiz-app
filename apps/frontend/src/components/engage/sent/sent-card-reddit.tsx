'use client';

import { FC } from 'react';

interface SentReply {
  id: string;
  authorReplied: boolean;
  post: {
    content: string;
    state: string;
    releaseURL?: string | null;
    publishDate: string;
    impressions?: number;
    analytics?: Array<{ label: string; data: Array<{ total: string }> }>;
    // Flat, normalized metrics from the API (preferred over parsing `analytics`).
    metrics?: {
      upvotes?: number;
      comments?: number;
      estReach?: number;
      trafficScore?: number;
    };
  };
  opportunity: {
    platform: string;
    externalPostUrl: string;
    postContent: string;
    authorUsername: string;
  };
}

interface SentCardRedditProps {
  reply: SentReply;
  onSubmitUrl?: (id: string) => void;
  sentReplyId: string;
}

function getMetric(
  analytics: SentReply['post']['analytics'],
  pattern: RegExp
): number {
  if (!analytics) return 0;
  const entry = analytics.find((a) => pattern.test(a.label));
  return Number(entry?.data?.[0]?.total ?? 0);
}

export const SentCardReddit: FC<SentCardRedditProps> = ({
  reply,
  onSubmitUrl,
  sentReplyId,
}) => {
  const { post, opportunity } = reply;
  const m = post.metrics;

  // Prefer the flat `metrics` object; fall back to parsing `analytics`.
  const score = m?.upvotes ?? getMetric(post.analytics, /score/i);
  const comments = m?.comments ?? getMetric(post.analytics, /comment/i);
  // estimated reach = (upvotes + comments) * 20, or the synced impressions.
  const estImpressions = m?.estReach ?? post.impressions ?? (score + comments) * 20;

  const noUrl = !post.releaseURL;

  return (
    <div className="bg-[#1a2035] rounded-lg p-4 border-l-4 border-l-orange-500">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs bg-orange-900 text-orange-300 px-1.5 py-0.5 rounded uppercase font-medium">
          Reddit
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

      {/* Original post */}
      <p className="text-xs text-gray-500 mb-1 truncate">
        @{opportunity.authorUsername}: {opportunity.postContent.slice(0, 60)}…
      </p>

      {/* Reply content */}
      <p className="text-sm text-gray-200 line-clamp-2 mb-3">{post.content}</p>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { icon: '↑', label: 'Score', value: score, color: 'text-red-400' },
          { icon: '💬', label: 'Comments', value: comments, color: 'text-yellow-600' },
          { icon: '👁', label: '估算曝光', value: estImpressions, color: 'text-blue-400' },
        ].map((m) => (
          <div key={m.label} className="text-center bg-[#0f1219] rounded-lg p-2">
            <div className="text-lg leading-none mb-0.5">{m.icon}</div>
            <div className={`text-sm font-bold ${m.color}`}>{m.value}</div>
            <div className="text-xs text-gray-600">{m.label}</div>
          </div>
        ))}
      </div>

      {/* URL actions */}
      {noUrl && onSubmitUrl && (
        <button
          onClick={() => onSubmitUrl(sentReplyId)}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          + Submit reply URL
        </button>
      )}
      {post.releaseURL && (
        <a
          href={post.releaseURL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:underline"
        >
          View on Reddit ↗
        </a>
      )}
    </div>
  );
};
