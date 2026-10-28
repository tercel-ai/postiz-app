import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

export const TARGET = Object.freeze({
  baseUrl: 'https://api-post-dev.aisee.live',
  organizationId: '2c9e0b8b-14b0-4b18-85f4-af92fb8a96c7',
  projectId: '27438304-85e6-445b-9468-c1f5ea4d8e9e',
  integrationId: 'cmtsdcu1s0005qm83o7mkc4cc',
  postId: 'cmu1wtvql0048qmece78j97tb',
});

export function parseDraftOptions(args: string[]): { apply: boolean; help: boolean } {
  const seen = new Set<string>();
  for (const arg of args) {
    if (!['--apply', '--help'].includes(arg) || seen.has(arg)) {
      throw new Error('Use only --apply or --help, without repeated options.');
    }
    seen.add(arg);
  }
  return { apply: seen.has('--apply'), help: seen.has('--help') };
}

function normalizeToken(value: string): string {
  const token = value.trim().replace(/^Bearer\s+/i, '');
  if (!token || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) {
    throw new Error('A valid AISEE_AUTH_TOKEN is required.');
  }
  return token;
}

export async function readAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  input: Readable = process.stdin,
  output: Writable = process.stderr
): Promise<string> {
  if (env.AISEE_AUTH_TOKEN?.trim()) return normalizeToken(env.AISEE_AUTH_TOKEN);
  if (!(input as NodeJS.ReadStream).isTTY) {
    throw new Error('Set AISEE_AUTH_TOKEN when standard input is not a terminal.');
  }

  output.write('Paste your current login token (hidden), then press Enter: ');
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input, output: silent, terminal: true });
  try {
    const value = await new Promise<string>((resolve, reject) => {
      reader.once('SIGINT', () => reject(new Error('Token input cancelled.')));
      reader.once('close', () => reject(new Error('Token input closed.')));
      reader.question('', resolve);
    });
    return normalizeToken(value);
  } finally {
    reader.close();
    silent.destroy();
    output.write('\n');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertReviewedDraft(payload: unknown): void {
  const posts = isRecord(payload) && payload.posts;
  const post = Array.isArray(posts) && posts.length === 1 && posts[0];
  if (!isRecord(post) || post.id !== TARGET.postId ||
    post.organizationId !== TARGET.organizationId ||
    post.projectId !== TARGET.projectId || post.integrationId !== TARGET.integrationId ||
    !isRecord(post.integration) || post.integration.providerIdentifier !== 'quora' ||
    post.state !== 'DRAFT' || post.deletedAt !== null || post.sendIntentId !== null ||
    post.releaseId !== null || post.parentPostId !== null || post.intervalInDays !== null ||
    !Array.isArray(post.childrenPost) || post.childrenPost.length !== 0) {
    throw new Error('Draft does not match the reviewed standalone, unclaimed Quora draft. No deletion requested.');
  }
}

export async function deleteBlockingQuoraDraft(
  token: string, apply: boolean, fetcher: typeof fetch = fetch
) {
  const auth = normalizeToken(token);
  async function request(path: string, method = 'GET'): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${TARGET.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${auth}`, showorg: TARGET.organizationId,
          accept: 'application/json', 'cache-control': 'no-cache' },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Request failed: ${method} ${path}. Check connectivity and retry; no automatic retry was attempted.`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${method} ${path}. Check login, permissions and application guards.`);
    }
    try {
      // The existing delete endpoint returns { error: true } even on success.
      // Its body is not evidence of deletion; the subsequent lookup is required.
      if (method === 'DELETE') { await response.text(); return undefined; }
      return await response.json();
    } catch {
      throw new Error(`Invalid API response: ${method} ${path}.`);
    }
  }

  const locatePath = `/posts/list/locate?postId=${TARGET.postId}`;
  async function isVisible(): Promise<boolean> {
    const result = await request(locatePath);
    if (!isRecord(result) || typeof result.found !== 'boolean') {
      throw new Error('Invalid post lookup response.');
    }
    return result.found;
  }

  if (!await isVisible()) return { target: TARGET, status: 'not-found' as const };
  const payload = await request(`/posts/${TARGET.postId}?projectId=${TARGET.projectId}`);
  assertReviewedDraft(payload);
  if (!apply) return { target: TARGET, status: 'preview' as const };

  await request(`/posts/id/${TARGET.postId}`, 'DELETE');
  if (await isVisible()) {
    throw new Error('Deletion could not be verified: the post is still visible. Rerun preview and review before retrying.');
  }
  return { target: TARGET, status: 'deleted' as const };
}

async function main() {
  const options = parseDraftOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/delete-blocking-quora-draft.ts [--apply]

Deletes only the reviewed Quora draft ${TARGET.postId} through ${TARGET.baseUrl}.
Default: preview only. --apply requests deletion and verifies list absence.
Reads AISEE_AUTH_TOKEN from the environment or .env, otherwise prompts without echo.
Pause editing and publishing during maintenance. No direct database access.`);
    return;
  }
  const dotenv = await import('dotenv');
  dotenv.config();
  const token = await readAuthToken();
  const result = await deleteBlockingQuoraDraft(token, options.apply);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'preview') {
    console.log('Preview only. No deletion requested. Rerun with --apply to delete this draft.');
  } else if (result.status === 'deleted') {
    console.log('Draft deletion verified through the application list. Rerun the duplicate-account cleanup preview.');
  } else {
    console.log('Post is not visible in this organization. No deletion requested; this alone does not prove prior deletion.');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Draft cleanup failed.');
    process.exitCode = 1;
  });
}
