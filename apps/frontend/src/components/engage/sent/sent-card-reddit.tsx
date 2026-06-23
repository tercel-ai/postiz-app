'use client';

import { FC } from 'react';
import {
  GenerationHistory,
  GenerationHistoryEntry,
} from './generation-history';

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
    // Unified author of the reply (the redditor who posted it), resolved by the API
    // from the comment's author. Null until the reply URL is known/synced.
    replyAuthor?: {
      handle: string;
      id?: string;
      name?: string;
      avatarUrl?: string;
    } | null;
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
    generationHistory?: GenerationHistoryEntry[];
  };
}

interface SentCardRedditProps {
  reply: SentReply;
  onSubmitUrl?: (id: string, existingUrl?: string) => void;
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
  // Only a posted reply (PUBLISHED) awaiting its permalink should offer the link
  // backfill — DRAFT/QUEUE/ERROR must not (the backend rejects them with a 400).
  // Gates both the warning badge and the "+ Submit reply URL" button so they stay
  // in sync with the server guard. The "Retry reply author" button below is for
  // replies that already HAVE a URL, so it keeps its own `!noUrl` condition.
  const linkPending = post.state === 'PUBLISHED' && noUrl;

  return (
    <div className="bg-[#1a2035] rounded-lg p-4 border-l-4 border-l-orange-500">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs bg-orange-900 text-orange-300 px-1.5 py-0.5 rounded uppercase font-medium">
          Reddit
        </span>
        {linkPending && (
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

      {/* Original author + post */}
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
          {opportunity.authorDisplayName || `u/${opportunity.authorUsername}`}
        </span>
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
      <p className="text-sm text-gray-200 line-clamp-2 mb-2">{post.content}</p>

      {/* Who posted the reply — the redditor resolved from the comment's author. */}
      {post.replyAuthor && (
        <div className="flex items-center gap-1.5 mb-3" title="Replied as">
          <span className="text-gray-600">↩</span>
          {post.replyAuthor.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.replyAuthor.avatarUrl}
              alt={post.replyAuthor.handle}
              className="w-4 h-4 rounded-full shrink-0"
            />
          )}
          <span className="text-xs text-gray-400 truncate">
            Replied as{' '}
            {post.replyAuthor.name && (
              <span className="text-gray-300">{post.replyAuthor.name} </span>
            )}
            <span className="text-gray-600">u/{post.replyAuthor.handle}</span>
          </span>
        </div>
      )}

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

      {/* Past AI generations for this opportunity (collapsed by default) */}
      <GenerationHistory history={opportunity.generationHistory} />

      {/* URL actions */}
      {linkPending && onSubmitUrl && (
        <button
          onClick={() => onSubmitUrl(sentReplyId)}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          + Submit reply URL
        </button>
      )}
      {!noUrl && !post.replyAuthor && onSubmitUrl && (
        <button
          onClick={() => onSubmitUrl(sentReplyId, post.releaseURL ?? undefined)}
          className="text-xs text-yellow-400 hover:text-yellow-300 transition-colors mr-3"
        >
          Retry reply author
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
