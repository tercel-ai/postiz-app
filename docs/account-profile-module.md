# Account Profile Module

## 1. Overview
The Account Profile module provides a comprehensive view of a connected social media account's performance and details. It allows users to monitor account-specific statistics, post history, and integration status in one place.

## 2. Features
- **Profile Summary**: Displays the account's avatar, name, and internal platform ID.
- **Data of Posts (Analytics)**:
  - **Posts Count**: Total number of posts published through Postiz for this specific account.
  - **Performance Metrics**: Real-time (or cached) data for Impressions, Likes, Replies, Retweets, Quotes, and Bookmarks.
  - **Platform Indicators**: Visual representation of the social media platform (e.g., X, Reddit, YouTube).
- **Personal Information**:
  - **Connection Date**: The date when the account was first integrated into Postiz.
  - **Platform-Specific Data**: Placeholder for platform-specific metrics like Karma (Reddit) or Subscriber count (YouTube).
  - **User Context**: Displays the system user email associated with the integration.

## 3. Data Sources & Architecture

### 3.1 Backend API
- **Endpoint**: `GET /integrations/profile/:id`
- **Controller**: `IntegrationsController`
- **Logic**:
  1. Fetch `Integration` details from the database.
  2. Count associated `Post` records for the specific integration ID.
  3. Invoke `IntegrationService.getPostsLevelAnalytics()` to fetch analytics for Postiz-published posts only (using `batchPostAnalytics` or per-post `postAnalytics` APIs). Results are cached in Redis for 1 hour.
  4. Return a consolidated JSON response including profile info, post counts, and analytics.

### 3.2 Frontend Component
- **Path**: `apps/frontend/src/components/integration/account.profile.tsx`
- **Page**: `apps/frontend/src/app/(app)/(site)/integrations/[id]/page.tsx` (Dynamic Route)
- **State Management**: Uses `useSWR` for data fetching and caching.
- **UI Design**: A card-based layout inspired by modern social media dashboards, supporting both Light and Dark modes.

## 4. Platform Support Matrix

| Metric | X (Twitter) | Facebook/Instagram | Reddit/YouTube/Others |
| :--- | :---: | :---: | :---: |
| **Profile Info** | YES | YES | YES |
| **Posts Count** | YES | YES | YES |
| **Impressions** | YES | YES | NO (--) |
| **Likes/Engagement**| YES | YES | NO (--) |
| **Replies/Comments**| YES | NO (--) | NO (--) |
| **Retweets/Shares** | YES | NO (--) | NO (--) |

*Note: For platforms marked as "NO", the UI displays "--" as these metrics are either not provided by the platform API to third-party apps or require additional implementation in the specific `SocialProvider`.*

## 5. How to Access
1. Go to the **Launches** (Calendar) page.
2. Locate the connected channel in the left sidebar.
3. Click the **three dots (⋮)** menu next to the channel name.
4. Select **Account Profile** from the dropdown menu.
