/**
 * Realtime Engage scan diagnostic.
 *
 * Read-only. Directly calls the same platform scan adapters used by the
 * orchestrator, then locally replays this org's fan-out scoring. Useful for
 * answering: did the platform return posts, did our keyword matcher hit, did
 * score pass ENGAGE_MIN_SCORE, and is the opportunity already in DB?
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org <orgId>
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org <orgId> --platform reddit
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org <orgId> --platform x
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org <orgId> --platform reddit --scope channel
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org <orgId> --keyword "your keyword"
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org <orgId> --use-cursor
 *
 * Flags:
 *   --org, --orgId <id>         Organization id. Required.
 *   --platform <reddit|x|all>   Platform to scan. Default: reddit.
 *   --scope <all|keyword|channel|tracked>
 *                               Scan units to run. Default: all.
 *   --keyword <text>            Restrict the scan and scoring to one keyword.
 *   --max-calls <n>             Upstream calls per scan unit. Default: ENGAGE_SCAN_MAX_CALLS or 5.
 *   --use-cursor                Mirror production incremental cursor. Default scans from "now" with empty cursor.
 *   --token <token>             Override X token. Reddit still uses REDDIT_CLIENT_ID/SECRET first.
 *   --json                      Print full raw/scored post objects at the end.
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { setupHttpDispatcher } from '@gitroom/helpers/proxy/setup-dispatcher';
import { PrismaClient, EngageKeyword } from '@prisma/client';
import {
  RawPost,
  ScoredPost,
  postMatchesKeyword,
  scorePost,
} from '@gitroom/nestjs-libraries/engage/engage-scorer';
import { getRedditToken } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { RedditScanAdapter } from '@gitroom/nestjs-libraries/engage/scan/reddit-scan-adapter';
import { XScanAdapter } from '@gitroom/nestjs-libraries/engage/scan/x-scan-adapter';
import {
  KEYWORD_GLOBAL_SCAN_KEY,
  ScanCursor,
  ScanScope,
  ScanType,
} from '@gitroom/nestjs-libraries/engage/scan/platform-scan-adapter';

// Match apps/orchestrator/src/main.ts: route Reddit traffic through REDDIT_PROXY
// with direct fallback for replayable reads, and use HTTPS_PROXY/HTTP_PROXY for
// non-Reddit traffic when configured.
setupHttpDispatcher();

type PlatformArg = 'reddit' | 'x' | 'all';
type ScopeArg = 'all' | ScanType;

interface CliArgs {
  orgId: string;
  platform: PlatformArg;
  scope: ScopeArg;
  keyword: string | null;
  maxCalls: number;
  useCursor: boolean;
  token: string | null;
  json: boolean;
}

interface RedditTokenInfo {
  token: string | null;
  clientIdSet: boolean;
  clientSecretSet: boolean;
  proxyUrl: string | null;
}

interface ScanUnit {
  platform: 'reddit' | 'x';
  scanType: ScanType;
  scanKey: string;
  scope: ScanScope;
}

interface AnalyzedPost {
  post: RawPost;
  matchedKeywords: string[];
  scored: ScoredPost | null;
  state:
    | {
        opportunityId: string;
        status: string;
        score: number;
        matchedKeywords: string[];
        createdAt: Date;
        updatedAt: Date;
      }
    | null;
}

const MIN_SCORE = Number(process.env.ENGAGE_MIN_SCORE ?? 60);

function usage(exitCode = 0): never {
  console.log(`Usage: engage-realtime-scan.ts --org <orgId> [--platform reddit|x|all] [--scope all|keyword|channel|tracked]

Examples:
  npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org org_123
  npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org org_123 --platform reddit --scope channel
  npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts --org org_123 --platform x --keyword "seo"`);
  process.exit(exitCode);
}

function takeValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${args[index]} requires a value`);
    usage(1);
  }
  return value;
}

function parseArgs(): CliArgs {
  const raw = process.argv.slice(2);
  let orgId = '';
  let platform: PlatformArg = 'reddit';
  let scope: ScopeArg = 'all';
  let keyword: string | null = null;
  let maxCalls = Number(process.env.ENGAGE_SCAN_MAX_CALLS ?? 5);
  let useCursor = false;
  let token: string | null = null;
  let json = false;

  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--org':
      case '--orgId':
        orgId = takeValue(raw, i);
        i++;
        break;
      case '--platform': {
        const value = takeValue(raw, i) as PlatformArg;
        if (!['reddit', 'x', 'all'].includes(value)) {
          console.error('--platform must be reddit, x, or all');
          usage(1);
        }
        platform = value;
        i++;
        break;
      }
      case '--scope': {
        const value = takeValue(raw, i) as ScopeArg;
        if (!['all', 'keyword', 'channel', 'tracked'].includes(value)) {
          console.error('--scope must be all, keyword, channel, or tracked');
          usage(1);
        }
        scope = value;
        i++;
        break;
      }
      case '--keyword':
        keyword = takeValue(raw, i);
        i++;
        break;
      case '--max-calls':
        maxCalls = Number(takeValue(raw, i));
        if (!Number.isFinite(maxCalls) || maxCalls < 1) {
          console.error('--max-calls must be a positive number');
          usage(1);
        }
        i++;
        break;
      case '--use-cursor':
        useCursor = true;
        break;
      case '--token':
        token = takeValue(raw, i);
        i++;
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        console.error(`Unknown argument: ${raw[i]}`);
        usage(1);
    }
  }

  if (!orgId) {
    console.error('--org is required');
    usage(1);
  }
  return { orgId, platform, scope, keyword, maxCalls, useCursor, token, json };
}

function maskDbUrl(url: string | undefined): string {
  return (url ?? '').replace(/:\/\/[^@]+@/, '://***@');
}

function redditProxyUrl(): string | null {
  return process.env.REDDIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
}

function maskProxyUrl(url: string | null): string {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return url;
  }
}

function extractOauthToken(token: string | Record<string, string>): string | null {
  if (typeof token === 'string') {
    const trimmed = token.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, string>;
        return parsed.access_token ?? parsed.token ?? null;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  return token.access_token ?? token.token ?? null;
}

async function collectXToken(
  prisma: PrismaClient,
  orgId: string,
  override: string | null
): Promise<{ token: string | null; source: string }> {
  if (override) return { token: override, source: '--token' };

  const integrations = await prisma.integration.findMany({
    where: {
      organizationId: orgId,
      providerIdentifier: 'x',
      type: 'social',
      disabled: false,
      deletedAt: null,
      inBetweenSteps: false,
      refreshNeeded: false,
    },
    select: { token: true, id: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const integration of integrations) {
    const token = extractOauthToken(integration.token as string | Record<string, string>);
    if (token) return { token, source: `integration:${integration.id}` };
  }
  if (process.env.X_BEARER_TOKEN) {
    return { token: process.env.X_BEARER_TOKEN, source: 'X_BEARER_TOKEN' };
  }
  return { token: null, source: 'none' };
}

async function collectRedditToken(): Promise<RedditTokenInfo> {
  return {
    token: await getRedditToken(),
    clientIdSet: Boolean(process.env.REDDIT_CLIENT_ID),
    clientSecretSet: Boolean(process.env.REDDIT_CLIENT_SECRET),
    proxyUrl: redditProxyUrl(),
  };
}

async function cursorFor(
  prisma: PrismaClient,
  unit: ScanUnit,
  useCursor: boolean
): Promise<ScanCursor> {
  if (!useCursor) return {};
  const row = await prisma.engageScanCursor.findUnique({
    where: {
      platform_scanType_scanKey: {
        platform: unit.platform,
        scanType: unit.scanType,
        scanKey: unit.scanKey,
      },
    },
    select: { lastSeenExternalId: true, lastSeenAt: true },
  });
  return {
    lastSeenExternalId: row?.lastSeenExternalId ?? null,
    lastSeenAt: row?.lastSeenAt ?? null,
  };
}

function shouldRunScope(scope: ScopeArg, scanType: ScanType): boolean {
  return scope === 'all' || scope === scanType;
}

function buildUnits(args: CliArgs, channels: Array<{ channelId: string }>, tracked: Array<{ username: string }>): ScanUnit[] {
  const units: ScanUnit[] = [];

  if ((args.platform === 'reddit' || args.platform === 'all') && shouldRunScope(args.scope, 'keyword')) {
    units.push({
      platform: 'reddit',
      scanType: 'keyword',
      scanKey: KEYWORD_GLOBAL_SCAN_KEY,
      scope: { type: 'keyword' },
    });
  }
  if ((args.platform === 'reddit' || args.platform === 'all') && shouldRunScope(args.scope, 'channel')) {
    for (const channel of channels) {
      units.push({
        platform: 'reddit',
        scanType: 'channel',
        scanKey: channel.channelId,
        scope: { type: 'channel', key: channel.channelId },
      });
    }
  }
  if ((args.platform === 'x' || args.platform === 'all') && shouldRunScope(args.scope, 'keyword')) {
    units.push({
      platform: 'x',
      scanType: 'keyword',
      scanKey: KEYWORD_GLOBAL_SCAN_KEY,
      scope: { type: 'keyword' },
    });
  }
  if ((args.platform === 'x' || args.platform === 'all') && shouldRunScope(args.scope, 'tracked')) {
    for (const account of tracked) {
      const username = account.username.toLowerCase();
      units.push({
        platform: 'x',
        scanType: 'tracked',
        scanKey: username,
        scope: { type: 'tracked', key: username },
      });
    }
  }

  return units;
}

function dedupePosts(posts: RawPost[]): RawPost[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    const key = `${post.platform}:${post.externalPostId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scanUnit(
  prisma: PrismaClient,
  unit: ScanUnit,
  keywords: string[],
  args: CliArgs,
  tokens: { reddit: string | null; x: string | null }
): Promise<RawPost[]> {
  const adapter = unit.platform === 'reddit' ? new RedditScanAdapter() : new XScanAdapter();
  const token = unit.platform === 'reddit' ? tokens.reddit : tokens.x;
  const cursor = await cursorFor(prisma, unit, args.useCursor);

  if (unit.platform === 'x' && !token) {
    console.log(`  SKIP x/${unit.scanType}/${unit.scanKey}: no X token available`);
    return [];
  }

  console.log(`\n-- scan ${unit.platform}/${unit.scanType}/${unit.scanKey} --`);
  if (args.useCursor) {
    console.log(
      `  cursor: id=${cursor.lastSeenExternalId ?? '(null)'} at=${cursor.lastSeenAt?.toISOString() ?? '(null)'}`
    );
  } else {
    console.log('  cursor: empty (realtime diagnostic, not production incremental)');
  }

  const result = await adapter.searchScoped({
    scope: unit.scope,
    keywords,
    cursor,
    budget: { maxCalls: args.maxCalls },
    token,
    log: {
      log: (msg) => console.log(`  ${msg}`),
      warn: (msg) => console.warn(`  WARN ${msg}`),
    },
    heartbeat: (progress) => {
      const p = progress as { stage?: string; query?: string; scope?: string };
      if (p?.stage) {
        console.log(`  heartbeat: ${p.stage}${p.scope ? ` scope=${p.scope}` : ''}${p.query ? ` query="${p.query}"` : ''}`);
      }
    },
  });

  console.log(
    `  result: posts=${result.posts.length} limited=${result.rate.limited}` +
      ` remaining=${result.rate.remaining ?? '?'} reset=${result.rate.resetAt?.toISOString() ?? '?'}`
  );
  console.log(
    `  next cursor: id=${result.nextCursor.lastSeenExternalId ?? '(null)'} at=${result.nextCursor.lastSeenAt?.toISOString() ?? '(null)'}`
  );
  return result.posts;
}

async function loadExistingStates(
  prisma: PrismaClient,
  orgId: string,
  posts: RawPost[]
): Promise<Map<string, AnalyzedPost['state']>> {
  if (!posts.length) return new Map();

  const byPlatform = new Map<string, string[]>();
  for (const post of posts) {
    byPlatform.set(post.platform, [...(byPlatform.get(post.platform) ?? []), post.externalPostId]);
  }

  const opportunities = await prisma.engageOpportunity.findMany({
    where: {
      OR: Array.from(byPlatform, ([platform, ids]) => ({
        platform,
        externalPostId: { in: Array.from(new Set(ids)) },
      })),
    },
    select: {
      id: true,
      platform: true,
      externalPostId: true,
      states: {
        where: { organizationId: orgId },
        select: {
          opportunityId: true,
          status: true,
          score: true,
          matchedKeywords: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  const map = new Map<string, AnalyzedPost['state']>();
  for (const opp of opportunities) {
    const state = opp.states[0];
    map.set(
      `${opp.platform}:${opp.externalPostId}`,
      state
        ? {
            opportunityId: state.opportunityId,
            status: state.status,
            score: state.score,
            matchedKeywords: state.matchedKeywords,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
          }
        : null
    );
  }
  return map;
}

function analyzePosts(
  posts: RawPost[],
  keywords: EngageKeyword[],
  states: Map<string, AnalyzedPost['state']>,
  tracked: Array<{ username: string }>,
  monitored: Array<{ platform: string; channelId: string }>
): AnalyzedPost[] {
  const trackedNames = new Set(tracked.map((a) => a.username.toLowerCase()));
  const monitoredSubreddits = new Set(
    monitored.filter((c) => c.platform === 'reddit').map((c) => c.channelId.toLowerCase())
  );

  return posts.map((post) => {
    // +5 tracked source: X post from a tracked account, OR Reddit post in one of the
    // org's monitored subreddits. Pure in-memory — no per-author network lookup.
    const isTracked =
      (post.platform === 'x' && trackedNames.has(post.authorUsername.toLowerCase())) ||
      (post.platform === 'reddit' &&
        !!post.channelId &&
        monitoredSubreddits.has(post.channelId.toLowerCase()));
    const marked = isTracked ? { ...post, isFromTrackedAccount: true } : post;
    return {
      post: marked,
      matchedKeywords: keywords
        .filter((kw) => kw.enabled && postMatchesKeyword(marked.postContent, kw.keyword))
        .map((kw) => kw.keyword),
      scored: scorePost(marked, keywords),
      state: states.get(`${post.platform}:${post.externalPostId}`) ?? null,
    };
  });
}

function truncate(value: string, len: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= len ? oneLine : `${oneLine.slice(0, len - 3)}...`;
}

function printAnalyzed(analyzed: AnalyzedPost[]): void {
  console.log('\n== Candidate posts ==');
  if (!analyzed.length) {
    console.log('  No posts returned by the realtime scan.');
    return;
  }

  for (const item of analyzed) {
    const score = item.scored?.score ?? 0;
    const reason =
      !item.scored
        ? 'NO_KEYWORD_MATCH'
        : score < MIN_SCORE
          ? `BELOW_MIN_SCORE(${score}<${MIN_SCORE})`
          : item.state
            ? `ALREADY_IN_DB(${item.state.status}, score=${item.state.score})`
            : `WOULD_SURFACE(score=${score})`;

    console.log(
      `\n[${item.post.platform}] ${reason} ${item.post.externalPostUrl}`
    );
    console.log(
      `  author=${item.post.authorUsername} channel=${item.post.channelName ?? item.post.channelId ?? '-'} published=${item.post.postPublishedAt.toISOString()}`
    );
    console.log(
      `  matches=${item.matchedKeywords.length ? item.matchedKeywords.join(', ') : '(none)'} ` +
        `score=${score} heat=${item.scored?.scoreHeat ?? '-'} authority=${item.scored?.scoreAuthority ?? '-'} recency=${item.scored?.scoreRecency ?? '-'} keyword=${item.scored?.scoreKeyword ?? '-'}`
    );
    console.log(`  text="${truncate(item.post.postContent, 220)}"`);
    if (item.state) {
      console.log(
        `  dbState opportunity=${item.state.opportunityId} matched=[${item.state.matchedKeywords.join(', ')}] updated=${item.state.updatedAt.toISOString()}`
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const prisma = new PrismaClient();

  try {
    console.log('=== Engage realtime scan diagnostic ===');
    console.log(`orgId     : ${args.orgId}`);
    console.log(`platform  : ${args.platform}`);
    console.log(`scope     : ${args.scope}`);
    console.log(`maxCalls  : ${args.maxCalls}`);
    console.log(`minScore  : ${MIN_SCORE}`);
    console.log(`database  : ${maskDbUrl(process.env.DATABASE_URL)}`);

    const config = await prisma.engageConfig.findUnique({
      where: { organizationId: args.orgId },
      include: {
        keywords: {
          where: {
            enabled: true,
            ...(args.keyword ? { keyword: args.keyword } : {}),
          },
          orderBy: { createdAt: 'asc' },
        },
        monitoredChannels: {
          where: { enabled: true, platform: 'reddit' },
          orderBy: { channelId: 'asc' },
          select: { platform: true, channelId: true, channelName: true, audienceSize: true },
        },
        trackedAccounts: {
          where: { enabled: true, platform: 'x' },
          orderBy: { username: 'asc' },
          select: { username: true, displayName: true },
        },
      },
    });

    if (!config) {
      throw new Error(`No EngageConfig found for org ${args.orgId}`);
    }
    if (!config.enabled) {
      console.warn('WARN Engage config is disabled for this org. Production ticker skips disabled org contexts.');
    }
    if (!config.keywords.length) {
      throw new Error(args.keyword ? `Keyword "${args.keyword}" is not enabled for this org` : 'No enabled keywords for this org');
    }

    console.log(`keywords  : ${config.keywords.map((kw) => `"${kw.keyword}"`).join(', ')}`);
    console.log(
      `reddit ch : ${config.monitoredChannels.length ? config.monitoredChannels.map((ch) => `r/${ch.channelId}`).join(', ') : '(none)'}`
    );
    console.log(
      `x tracked : ${config.trackedAccounts.length ? config.trackedAccounts.map((a) => `@${a.username}`).join(', ') : '(none)'}`
    );

    const units = buildUnits(args, config.monitoredChannels, config.trackedAccounts);
    if (!units.length) {
      console.log('\nNo scan units for the selected platform/scope.');
      return;
    }

    const [redditToken, xToken] = await Promise.all([
      args.platform === 'reddit' || args.platform === 'all'
        ? collectRedditToken()
        : Promise.resolve({
            token: null,
            clientIdSet: false,
            clientSecretSet: false,
            proxyUrl: redditProxyUrl(),
          }),
      args.platform === 'x' || args.platform === 'all' ? collectXToken(prisma, args.orgId, args.token) : Promise.resolve({ token: null, source: 'none' }),
    ]);

    console.log(
      `reddit token: ${
        redditToken.token
          ? 'yes'
          : `no (${redditToken.clientIdSet ? 'REDDIT_CLIENT_ID set' : 'REDDIT_CLIENT_ID missing'}, ${
              redditToken.clientSecretSet ? 'REDDIT_CLIENT_SECRET set' : 'REDDIT_CLIENT_SECRET missing'
            }; adapter will try public fallback)`
      }`
    );
    console.log(`reddit proxy: ${maskProxyUrl(redditToken.proxyUrl)}`);
    console.log(`x token     : ${xToken.token ? xToken.source : 'none'}`);

    const posts: RawPost[] = [];
    for (const unit of units) {
      posts.push(
        ...(await scanUnit(prisma, unit, config.keywords.map((kw) => kw.keyword), args, {
          reddit: redditToken.token,
          x: xToken.token,
        }))
      );
    }

    const deduped = dedupePosts(posts);
    const states = await loadExistingStates(prisma, args.orgId, deduped);
    const analyzed = analyzePosts(
      deduped,
      config.keywords,
      states,
      config.trackedAccounts,
      config.monitoredChannels
    );

    const keywordMatched = analyzed.filter((p) => p.scored).length;
    const passScore = analyzed.filter((p) => (p.scored?.score ?? 0) >= MIN_SCORE).length;
    const alreadyInDb = analyzed.filter((p) => p.state).length;
    const wouldSurface = analyzed.filter((p) => (p.scored?.score ?? 0) >= MIN_SCORE && !p.state).length;

    console.log('\n== Summary ==');
    console.log(`raw posts       : ${posts.length}`);
    console.log(`deduped posts   : ${deduped.length}`);
    console.log(`keyword matched : ${keywordMatched}`);
    console.log(`score >= min    : ${passScore}`);
    console.log(`already in DB   : ${alreadyInDb}`);
    console.log(`would surface   : ${wouldSurface}`);

    printAnalyzed(analyzed);

    if (args.json) {
      console.log('\n== JSON ==');
      console.log(JSON.stringify(analyzed, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
