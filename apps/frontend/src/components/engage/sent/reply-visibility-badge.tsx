'use client';

import { FC } from 'react';

/**
 * Whether the public can actually see a sent reply, as reported by the API's
 * normalized `metrics.visibility` (see engage-metrics-stats.ts).
 *
 * `unknown` is a real value and is NOT rendered: it means no build has ever
 * reported the flags for this row, and drawing a green "visible" badge there
 * would assert something nobody checked — the exact failure this badge exists
 * to end. Silence for unknown, a badge only when we actually know.
 */
export type ReplyVisibility = 'visible' | 'hidden' | 'removed' | 'unknown';

/**
 * A reply the platform has killed is otherwise indistinguishable from a healthy
 * one in this list: PUBLISHED, with a link, just low numbers. That is how forty
 * days of flagged Hacker News comments passed unnoticed. Only the two states
 * that need a human get a badge.
 */
export const ReplyVisibilityBadge: FC<{ visibility?: ReplyVisibility }> = ({
  visibility,
}) => {
  if (visibility === 'hidden') {
    return (
      <span
        className="text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded"
        title="平台已将这条回复隐藏（被 flag / 被 kill），其他用户看不到它。检查内容是否被判为垃圾信息。"
      >
        ⚠ 已被平台隐藏
      </span>
    );
  }
  if (visibility === 'removed') {
    return (
      <span
        className="text-xs bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded"
        title="这条回复已被作者删除，平台上不再存在。"
      >
        已删除
      </span>
    );
  }
  return null;
};
