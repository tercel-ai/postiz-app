# Backend API Index

An index of all HTTP endpoints exposed by `apps/backend`, grouped by controller.
Each controller links to its source file; the `@Controller('...')` prefix is the base
path for every route below it (NestJS has **no** global prefix in this app).

Generated from the `@Controller` / `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete`
decorators. Paths shown are full paths (prefix + route).

## Table of Contents

- [User / App API (`src/api/routes`)](#user--app-api-srcapiroutes)
- [Admin API (`src/admin-api/routes`)](#admin-api-srcadmin-apiroutes)
- [Public API v1 (`src/public-api/routes`)](#public-api-v1-srcpublic-apiroutes)

---

## User / App API (`src/api/routes`)

### [root.controller.ts](apps/backend/src/api/routes/root.controller.ts) — `/`
| Method | Path |
| --- | --- |
| GET | `/` |

### [auth.controller.ts](apps/backend/src/api/routes/auth.controller.ts) — `/auth`
| Method | Path |
| --- | --- |
| GET | `/auth/can-register` |
| POST | `/auth/register` |
| POST | `/auth/login` |
| POST | `/auth/token-refresh` |
| POST | `/auth/forgot` |
| POST | `/auth/forgot-return` |
| GET | `/auth/oauth/:provider` |
| POST | `/auth/activate` |
| POST | `/auth/resend-activation` |
| POST | `/auth/oauth/:provider/exists` |

### [users.controller.ts](apps/backend/src/api/routes/users.controller.ts) — `/user`
| Method | Path |
| --- | --- |
| GET | `/user/self` |
| GET | `/user/personal` |
| GET | `/user/impersonate` |
| POST | `/user/impersonate` |
| POST | `/user/personal` |
| GET | `/user/email-notifications` |
| POST | `/user/email-notifications` |
| GET | `/user/subscription` |
| GET | `/user/subscription/tiers` |
| POST | `/user/join-org` |
| GET | `/user/organizations` |
| POST | `/user/change-org` |
| POST | `/user/logout` |
| POST | `/user/t` |

### [integrations.controller.ts](apps/backend/src/api/routes/integrations.controller.ts) — `/integrations`
| Method | Path |
| --- | --- |
| GET | `/integrations/` |
| GET | `/integrations/:identifier/internal-plugs` |
| GET | `/integrations/customers` |
| PUT | `/integrations/:id/group` |
| PUT | `/integrations/:id/customer-name` |
| GET | `/integrations/list` |
| POST | `/integrations/:id/settings` |
| POST | `/integrations/:id/nickname` |
| GET | `/integrations/profile/:id` |
| GET | `/integrations/:id` |
| GET | `/integrations/social/:integration` |
| POST | `/integrations/:id/time` |
| POST | `/integrations/mentions` |
| POST | `/integrations/user-by-username` |
| POST | `/integrations/function` |
| POST | `/integrations/social/:integration/connect` |
| POST | `/integrations/disable` |
| POST | `/integrations/provider/:id/connect` |
| POST | `/integrations/enable` |
| DELETE | `/integrations/` |
| GET | `/integrations/plug/list` |
| GET | `/integrations/:id/plugs` |
| POST | `/integrations/:id/plugs` |
| PUT | `/integrations/plugs/:id/activate` |
| GET | `/integrations/telegram/updates` |

### [posts.controller.ts](apps/backend/src/api/routes/posts.controller.ts) — `/posts`
| Method | Path |
| --- | --- |
| POST | `/posts/metrics/due` |
| POST | `/posts/metrics/ingest` |
| POST | `/posts/metrics/backfill` |
| GET | `/posts/:id/statistics` |
| POST | `/posts/should-shortlink` |
| POST | `/posts/:id/comments` |
| GET | `/posts/tags` |
| POST | `/posts/tags` |
| PUT | `/posts/tags/:id` |
| GET | `/posts/` |
| GET | `/posts/find-slot` |
| GET | `/posts/find-slot/:id` |
| GET | `/posts/release-list` |
| GET | `/posts/list` |
| GET | `/posts/list/locate` |
| GET | `/posts/old` |
| GET | `/posts/group/:group` |
| GET | `/posts/:id` |
| POST | `/posts/` |
| POST | `/posts/generator/draft` |
| POST | `/posts/generator` |
| DELETE | `/posts/:group` |
| POST | `/posts/:id/retry` |
| PUT | `/posts/:id/date` |
| POST | `/posts/separate-posts` |
| PATCH | `/posts/:id/extension-published` |
| POST | `/posts/sync-metrics` |

### [autopost.controller.ts](apps/backend/src/api/routes/autopost.controller.ts) — `/autopost`
| Method | Path |
| --- | --- |
| GET | `/autopost/` |
| POST | `/autopost/` |
| PUT | `/autopost/:id` |
| DELETE | `/autopost/:id` |
| POST | `/autopost/:id/active` |
| POST | `/autopost/send` |

### [media.controller.ts](apps/backend/src/api/routes/media.controller.ts) — `/media`
| Method | Path |
| --- | --- |
| DELETE | `/media/:id` |
| POST | `/media/generate-video` |
| POST | `/media/generate-image` |
| POST | `/media/generate-image-with-prompt` |
| POST | `/media/upload-server` |
| POST | `/media/save-media` |
| POST | `/media/information` |
| POST | `/media/upload-simple` |
| POST | `/media/:endpoint` |
| GET | `/media/` |
| GET | `/media/video-options` |
| POST | `/media/video/function` |
| GET | `/media/generate-video/:type/allowed` |

### [analytics.controller.ts](apps/backend/src/api/routes/analytics.controller.ts) — `/analytics`
| Method | Path |
| --- | --- |
| GET | `/analytics/:integration` |
| GET | `/analytics/post/:postId` |

### [dashboard.controller.ts](apps/backend/src/api/routes/dashboard.controller.ts) — `/dashboard`
| Method | Path |
| --- | --- |
| GET | `/dashboard/summary` |
| GET | `/dashboard/posts-trend` |
| GET | `/dashboard/traffics` |
| GET | `/dashboard/impressions` |
| GET | `/dashboard/post-engagement` |

### [engage.controller.ts](apps/backend/src/api/routes/engage.controller.ts) — `/engage`
| Method | Path |
| --- | --- |
| POST | `/engage/scan-tasks/ingest` |
| POST | `/engage/scan-tasks/release` |
| POST | `/engage/scan-posts/ingest` |
| GET | `/engage/config` |
| POST | `/engage/config` |
| POST | `/engage/config/reset` |
| POST | `/engage/setup` |
| POST | `/engage/keywords` |
| POST | `/engage/keywords/bulk` |
| PATCH | `/engage/keywords/:id` |
| DELETE | `/engage/keywords/:id` |
| GET | `/engage/keywords/:id/posts` |
| GET | `/engage/monitored-channels` |
| POST | `/engage/monitored-channels` |
| PATCH | `/engage/monitored-channels/:id` |
| DELETE | `/engage/monitored-channels/:id` |
| POST | `/engage/monitored-channels/search` |
| GET | `/engage/tracked-accounts` |
| POST | `/engage/tracked-accounts` |
| PATCH | `/engage/tracked-accounts/:id` |
| DELETE | `/engage/tracked-accounts/:id` |
| GET | `/engage/reply-accounts` |
| PATCH | `/engage/reply-accounts/:integrationId` |
| POST | `/engage/scan` |
| POST | `/engage/refresh-on-visit` |
| POST | `/engage/sent/metrics/refresh` |
| GET | `/engage/opportunities/score-stats` |
| GET | `/engage/opportunities/counts` |
| GET | `/engage/opportunities/locate` |
| GET | `/engage/opportunities` |
| GET | `/engage/opportunities/:id` |
| PATCH | `/engage/opportunities/:id/dismiss` |
| PATCH | `/engage/opportunities/:id/bookmark` |
| POST | `/engage/opportunities/:id/draft` |
| POST | `/engage/opportunities/:id/save-draft` |
| POST | `/engage/opportunities/:id/send-now` |
| POST | `/engage/opportunities/:id/schedule` |
| POST | `/engage/opportunities/:id/batch-schedule` |
| POST | `/engage/opportunities/:id/batch-send` |
| POST | `/engage/opportunities/:id/manual-reply` |
| GET | `/engage/sent/locate` |
| GET | `/engage/sent` |
| GET | `/engage/sent/stats` |
| GET | `/engage/sent/counts` |
| GET | `/engage/sent/:id/status` |
| GET | `/engage/sent/:id` |
| PATCH | `/engage/sent/:id` |
| PATCH | `/engage/sent/:id/reply-url` |
| PATCH | `/engage/sent/:id/publish-reply` |
| PATCH | `/engage/sent/:id/metrics` |
| GET | `/engage/dashboard/summary` |
| GET | `/engage/dashboard/replies-trend` |
| GET | `/engage/dashboard/traffics` |
| GET | `/engage/dashboard/impressions` |
| GET | `/engage/dashboard/top-sources` |
| POST | `/engage/admin/resync-metrics` |
| POST | `/engage/admin/sync-metrics` |

### [operation-plan.controller.ts](apps/backend/src/api/routes/operation-plan.controller.ts) — (no prefix)
| Method | Path |
| --- | --- |
| GET | `/operation-plans/:id` |
| POST | `/projects/:projectId/operation-plans` |

### [billing.controller.ts](apps/backend/src/api/routes/billing.controller.ts) — `/billing`
| Method | Path |
| --- | --- |
| GET | `/billing/check/:id` |
| GET | `/billing/check-discount` |
| POST | `/billing/apply-discount` |
| POST | `/billing/finish-trial` |
| GET | `/billing/is-trial-finished` |
| POST | `/billing/embedded` |
| POST | `/billing/subscribe` |
| GET | `/billing/portal` |
| GET | `/billing/` |
| POST | `/billing/cancel` |
| POST | `/billing/prorate` |
| POST | `/billing/lifetime` |
| POST | `/billing/add-subscription` |
| GET | `/billing/crypto` |

### [stripe.controller.ts](apps/backend/src/api/routes/stripe.controller.ts) — `/stripe`
| Method | Path |
| --- | --- |
| POST | `/stripe/` |

### [copilot.controller.ts](apps/backend/src/api/routes/copilot.controller.ts) — `/copilot`
| Method | Path |
| --- | --- |
| POST | `/copilot/chat` |
| POST | `/copilot/agent` |
| GET | `/copilot/credits` |
| GET | `/copilot/:thread/list` |
| GET | `/copilot/list` |

### [settings.controller.ts](apps/backend/src/api/routes/settings.controller.ts) — `/settings`
| Method | Path |
| --- | --- |
| GET | `/settings/team` |
| POST | `/settings/team` |
| DELETE | `/settings/team/:id` |
| GET | `/settings/shortlink` |
| POST | `/settings/shortlink` |
| GET | `/settings/metrics-window` |
| POST | `/settings/metrics-window` |

### [signature.controller.ts](apps/backend/src/api/routes/signature.controller.ts) — `/signatures`
| Method | Path |
| --- | --- |
| GET | `/signatures/` |
| GET | `/signatures/default` |
| POST | `/signatures/` |
| DELETE | `/signatures/:id` |
| PUT | `/signatures/:id` |

### [sets.controller.ts](apps/backend/src/api/routes/sets.controller.ts) — `/sets`
| Method | Path |
| --- | --- |
| GET | `/sets/` |
| POST | `/sets/` |
| PUT | `/sets/` |
| DELETE | `/sets/:id` |

### [webhooks.controller.ts](apps/backend/src/api/routes/webhooks.controller.ts) — `/webhooks`
| Method | Path |
| --- | --- |
| GET | `/webhooks/` |
| POST | `/webhooks/` |
| PUT | `/webhooks/` |
| DELETE | `/webhooks/:id` |
| POST | `/webhooks/send` |

### [notifications.controller.ts](apps/backend/src/api/routes/notifications.controller.ts) — `/notifications`
| Method | Path |
| --- | --- |
| GET | `/notifications/` |
| GET | `/notifications/list` |

### [third-party.controller.ts](apps/backend/src/api/routes/third-party.controller.ts) — `/third-party`
| Method | Path |
| --- | --- |
| GET | `/third-party/list` |
| GET | `/third-party/` |
| DELETE | `/third-party/:id` |
| POST | `/third-party/:id/submit` |
| POST | `/third-party/function/:id/:functionName` |
| POST | `/third-party/:identifier` |

### [public.controller.ts](apps/backend/src/api/routes/public.controller.ts) — `/public`
| Method | Path |
| --- | --- |
| GET | `/public/extension/latest` |
| POST | `/public/agent` |
| GET | `/public/agencies-list` |
| GET | `/public/agencies-list-slug` |
| GET | `/public/agencies-information/:agency` |
| GET | `/public/agencies-list-count` |
| GET | `/public/posts/:id` |
| GET | `/public/posts/:id/comments` |
| POST | `/public/t` |
| POST | `/public/crypto/:path` |
| GET | `/public/stream` |

### [internal.controller.ts](apps/backend/src/api/routes/internal.controller.ts) — `internal`
| Method | Path |
| --- | --- |
| POST | `internal/users` |

### [monitor.controller.ts](apps/backend/src/api/routes/monitor.controller.ts) — `/monitor`
| Method | Path |
| --- | --- |
| GET | `/monitor/queue/:name` |

---

## Admin API (`src/admin-api/routes`)

### [admin-api-cost.controller.ts](apps/backend/src/admin-api/routes/admin-api-cost.controller.ts) — `/admin/api-cost`
| Method | Path |
| --- | --- |
| GET | `/admin/api-cost/` |
| GET | `/admin/api-cost/business` |
| GET | `/admin/api-cost/engage-scores` |

### [admin-billing.controller.ts](apps/backend/src/admin-api/routes/admin-billing.controller.ts) — `/admin/billing`
| Method | Path |
| --- | --- |
| GET | `/admin/billing/records` |
| GET | `/admin/billing/records/:id` |
| GET | `/admin/billing/summary` |
| PATCH | `/admin/billing/associate/:taskId` |
| POST | `/admin/billing/retry/:id` |
| POST | `/admin/billing/retry-all-failed` |

### [admin-dashboard.controller.ts](apps/backend/src/admin-api/routes/admin-dashboard.controller.ts) — `/admin/dashboard`
| Method | Path |
| --- | --- |
| GET | `/admin/dashboard/` |
| POST | `/admin/dashboard/data-ticks/backfill` |
| GET | `/admin/dashboard/user/summary` |
| POST | `/admin/dashboard/account-metrics/:integrationId` |

### [admin-diagnostics.controller.ts](apps/backend/src/admin-api/routes/admin-diagnostics.controller.ts) — `/admin/diagnostics`
| Method | Path |
| --- | --- |
| GET | `/admin/diagnostics/recurring-posts` |
| GET | `/admin/diagnostics/stuck-posts` |
| GET | `/admin/diagnostics/integrations` |
| GET | `/admin/diagnostics/error-posts` |
| GET | `/admin/diagnostics/engage-scan-cursors` |
| POST | `/admin/diagnostics/engage-scan-cursors/release` |
| GET | `/admin/diagnostics/engage-failed-scans` |
| GET | `/admin/diagnostics/engage-keyword-subscribers` |
| GET | `/admin/diagnostics/engage-dead-reply-accounts` |
| GET | `/admin/diagnostics/engage-reply-errors` |
| GET | `/admin/diagnostics/overview` |

### [admin-errors.controller.ts](apps/backend/src/admin-api/routes/admin-errors.controller.ts) — `/admin/errors`
| Method | Path |
| --- | --- |
| GET | `/admin/errors/` |
| GET | `/admin/errors/:id` |

### [admin-extension.controller.ts](apps/backend/src/admin-api/routes/admin-extension.controller.ts) — `/admin/extension`
| Method | Path |
| --- | --- |
| GET | `/admin/extension/` |
| POST | `/admin/extension/upload/chrome` |
| POST | `/admin/extension/upload/firefox` |

### [admin-integrations.controller.ts](apps/backend/src/admin-api/routes/admin-integrations.controller.ts) — `/admin/integrations`
| Method | Path |
| --- | --- |
| GET | `/admin/integrations/` |
| GET | `/admin/integrations/:id` |

### [admin-media.controller.ts](apps/backend/src/admin-api/routes/admin-media.controller.ts) — `/admin/media`
| Method | Path |
| --- | --- |
| GET | `/admin/media/` |

### [admin-organizations.controller.ts](apps/backend/src/admin-api/routes/admin-organizations.controller.ts) — `/admin/organizations`
| Method | Path |
| --- | --- |
| GET | `/admin/organizations/` |
| GET | `/admin/organizations/:id` |

### [admin-posts.controller.ts](apps/backend/src/admin-api/routes/admin-posts.controller.ts) — `/admin/posts`
| Method | Path |
| --- | --- |
| GET | `/admin/posts/` |
| GET | `/admin/posts/:id` |

### [admin-settings.controller.ts](apps/backend/src/admin-api/routes/admin-settings.controller.ts) — `/admin`
| Method | Path |
| --- | --- |
| GET | `/admin/social-providers` |
| GET | `/admin/settings` |
| GET | `/admin/settings/engage-initial-scan-budget` |
| GET | `/admin/settings/:key` |
| POST | `/admin/settings` |
| PUT | `/admin/settings/:key` |
| DELETE | `/admin/settings/:key` |
| GET | `/admin/ai-pricing` |
| POST | `/admin/ai-pricing` |
| PUT | `/admin/ai-pricing` |

---

## Public API v1 (`src/public-api/routes`)

### [public.integrations.controller.ts](apps/backend/src/public-api/routes/v1/public.integrations.controller.ts) — `/public/v1`
| Method | Path |
| --- | --- |
| POST | `/public/v1/upload` |
| POST | `/public/v1/upload-from-url` |
| GET | `/public/v1/find-slot/:id` |
| GET | `/public/v1/posts` |
| POST | `/public/v1/posts` |
| DELETE | `/public/v1/posts/:id` |
| GET | `/public/v1/is-connected` |
| GET | `/public/v1/integrations` |
| POST | `/public/v1/generate-video` |
| POST | `/public/v1/video/function` |
