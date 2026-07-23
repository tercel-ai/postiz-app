export const ENGAGE_EXTENSION_ACTION = {
  runScan: 'engage:scan',
  runMetrics: 'engage:metrics',
  scanXKeyword: 'engage:scan-x-keyword',
  fetchXPost: 'engage:fetch-x-post',
  scanXAccount: 'engage:scan-x-account',
  scanRedditKeyword: 'engage:scan-reddit-keyword',
  fetchRedditPost: 'engage:fetch-reddit-post',
  scanRedditUser: 'engage:scan-reddit-user',
  fetchReplyMetrics: 'engage:fetch-reply-metrics',
  fetchPostMetrics: 'posts:fetch-metrics',
  ingestCollectedPosts: 'engage:ingest-collected-posts',
  syncCollectedMetrics: 'engage:sync-collected-metrics',
  loadConfig: 'engage:load-config',
  socialSessions: 'social:sessions',
  publishEnqueue: 'publish:enqueue',
  publishCancel: 'publish:cancel',
  publishStatus: 'publish:status',
  /** popup/panel → SW: make a queued task due immediately ("Publish now"). */
  publishNow: 'publish:now',
  /** popup/panel → SW: retry the DB backfill for a 'sent' task ("Sync"). */
  publishSync: 'publish:sync',
  /** popup/panel → SW: re-queue a failed task ("Retry"). */
  publishRetry: 'publish:retry',
  /** popup/panel → SW: drop a settled row from the queue ("Remove"). */
  publishRemove: 'publish:remove',
  /** popup/panel → SW: bulk-drop settled rows older than a cutoff ("Clear history"). */
  publishClearSettled: 'publish:clear-settled',
  /** popup/panel → SW: bulk-drop all still-queued (not-yet-sent) tasks. */
  publishClearQueued: 'publish:clear-queued',
  /** SW → content-script push forwarded to the page as postPublishProgress. */
  publishProgressPush: 'publish:progress-push',
  loadSubscription: 'user:load-subscription',
  claimTasks: 'engage:claim-tasks',
  executeTask: 'engage:execute-task',
  releaseTask: 'engage:release-task',
  ingestTask: 'engage:ingest-task',
} as const;
