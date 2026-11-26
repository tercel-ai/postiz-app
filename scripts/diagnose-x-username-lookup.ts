import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { ApiPartialResponseError, ApiRequestError, ApiResponseError } from 'twitter-api-v2';

export function parseLookupArgs(args?: string[]) {
  const { values } = parseArgs({ args, options: {
    username: { type: 'string' },
    help: { type: 'boolean' },
    // Older invocations include this flag. Public lookup no longer uses a database.
    'database-verified': { type: 'boolean' },
  } });
  return { help: values.help, username: values.username?.trim() };
}

export function describeLookupFailure(error: unknown) {
  if (error instanceof ApiResponseError) {
    return { status: 'X_LOOKUP_FAILED', upstreamStatus: error.code };
  }
  if (error instanceof ApiRequestError || error instanceof ApiPartialResponseError) {
    // The installed SDK stores the request cause as `error`, while its getter reads `requestError`.
    const cause = error instanceof ApiRequestError
      ? error.requestError ?? (error as unknown as { _options?: { error?: Error } })._options?.error
      : error.responseError;
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    return {
      status: 'X_TRANSPORT_FAILED',
      ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? { code } : {}),
    };
  }
  const code = error instanceof TypeError ? (error as NodeJS.ErrnoException).code : undefined;
  if (code?.startsWith('ERR_PARSE_ARGS_')) {
    return { status: 'INVALID_ARGUMENTS', code, message: 'Use --help for supported options.' };
  }
  return { status: 'DIAGNOSTIC_FAILED' };
}

async function main() {
  const { help, username } = parseLookupArgs();
  if (help || !username) {
    console.log('Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-x-username-lookup.ts --username @OpenAI');
    console.log('Uses X_BEARER_TOKEN or X_API_KEY and X_API_SECRET from the environment.');
    process.exitCode = help ? 0 : 1;
    return;
  }

  dotenv.config({ path: resolve(__dirname, '../.env') });
  // The provider shares a Redis singleton with send workflows. This CLI uses
  // only the app lookup, so close the singleton in this process.
  const { ioRedis } = await import('../libraries/nestjs-libraries/src/redis/redis.service');
  if (process.env.REDIS_URL) ioRedis.disconnect();
  const { XProvider } = await import('../libraries/nestjs-libraries/src/integrations/social/x.provider');
  const result = await XProvider.fetchPublicUserByUsername(username);
  if ('missingCredentials' in result) {
    console.log(JSON.stringify({ status: 'X_LOOKUP_NOT_CONFIGURED' }));
    process.exitCode = 1;
    return;
  }
  if ('notFound' in result) {
    console.log(JSON.stringify({ status: 'NOT_FOUND' }));
    return;
  }
  const { raw, ...profile } = result;
  console.log(JSON.stringify({ status: 'FOUND', profile }, null, 2));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify(describeLookupFailure(error)));
    process.exitCode = 1;
  });
}
