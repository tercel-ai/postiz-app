'use client';

import { FC } from 'react';
import clsx from 'clsx';

export interface Opportunity {
  id: string;
  platform: string;
  externalPostUrl: string;
  authorUsername: string;
  authorDisplayName?: string;
  // Subreddit avatar (Reddit only); null for other platforms or unmonitored channels.
  channelAvatar?: string | null;
  postContent: string;
  postPublishedAt: string;
  // Per-org first-seen time; this is the column "Sort by Newest" orders on.
  createdAt: string;
  score: number;
  scoreHeat: number;
  scoreKeyword: number;
  scoreAuthority: number;
  scoreRecency: number;
  scoreTracked: number;
  intentTags: string[];
  primaryIntent: string;
  matchedKeywords?: string[];
  bookmarked: boolean;
  status: string;
  metricLikes: number;
  metricReplies: number;
  metricRetweets: number;
  metricScore: number;
  metricComments: number;
}

interface OpportunityCardProps {
  opportunity: Opportunity;
  selected?: boolean;
  onSelect: (id: string) => void;
  onBookmark: (id: string) => void;
  onDismiss: (id: string) => void;
}

function scoreColor(score: number) {
  if (score >= 85) return 'bg-green-700 text-green-200';
  if (score >= 70) return 'bg-yellow-700 text-yellow-200';
  if (score >= 60) return 'bg-orange-700 text-orange-200';
  return 'bg-gray-700 text-gray-300';
}

function platformColor(platform: string) {
  if (platform === 'x') return 'border-l-white';
  if (platform === 'reddit') return 'border-l-orange-500';
  return 'border-l-blue-500';
}

function platformBadge(platform: string) {
  if (platform === 'x') return 'bg-gray-800 text-white';
  if (platform === 'reddit') return 'bg-orange-900 text-orange-300';
  return 'bg-blue-900 text-blue-300';
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const OpportunityCard: FC<OpportunityCardProps> = ({
  opportunity: opp,
  selected,
  onSelect,
  onBookmark,
  onDismiss,
}) => {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(opp.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(opp.id);
        }
      }}
      aria-pressed={selected}
      aria-label={`Select opportunity from @${opp.authorUsername}`}
      className={clsx(
        'border-l-4 bg-[#1a2035] rounded-r-lg p-4 cursor-pointer transition-all hover:bg-[#1e2740]',
        platformColor(opp.platform),
        selected && 'ring-1 ring-blue-500'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: content */}
        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-medium uppercase ${platformBadge(
                opp.platform
              )}`}
            >
              {opp.platform}
            </span>
            {opp.intentTags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="text-xs bg-[#2d3748] text-gray-300 px-1.5 py-0.5 rounded"
              >
                {tag.replace('_', ' ')}
              </span>
            ))}
            {opp.scoreTracked > 0 && (
              <span className="text-xs bg-purple-900 text-purple-300 px-1.5 py-0.5 rounded">
                ⚡ Tracked
              </span>
            )}
            <span className="text-xs text-gray-500 ml-auto">
              @{opp.authorUsername} · {relativeTime(opp.postPublishedAt)}
              {opp.createdAt && (
                <span className="text-gray-600" title="When this opportunity was first scanned (sort field)">
                  {' '}
                  · found {relativeTime(opp.createdAt)}
                </span>
              )}
            </span>
          </div>

          {/* Content */}
          <p className="text-gray-200 text-sm line-clamp-2">{opp.postContent}</p>

          {/* Matched keywords — why this post surfaced for this org */}
          {opp.matchedKeywords && opp.matchedKeywords.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-2">
              {opp.matchedKeywords.map((kw) => (
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

          {/* Metrics */}
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
            {opp.platform === 'x' ? (
              <>
                <span>♥ {opp.metricLikes}</span>
                <span>💬 {opp.metricReplies}</span>
                <span>🔁 {opp.metricRetweets}</span>
              </>
            ) : (
              <>
                <span>↑ {opp.metricScore}</span>
                <span>💬 {opp.metricComments}</span>
              </>
            )}
          </div>
        </div>

        {/* Right: score + actions */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <span
            className={`text-sm font-bold px-2 py-1 rounded ${scoreColor(opp.score)}`}
          >
            {opp.score}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onBookmark(opp.id);
              }}
              className={clsx(
                'text-lg leading-none transition-colors',
                opp.bookmarked
                  ? 'text-amber-400'
                  : 'text-gray-600 hover:text-amber-400'
              )}
              title="Bookmark"
            >
              ★
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(opp.id);
              }}
              className="text-gray-600 hover:text-red-400 text-sm transition-colors"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSelect(opp.id);
            }}
            className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded transition-colors"
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  );
};
