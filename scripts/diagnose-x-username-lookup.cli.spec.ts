import { ApiRequestError, ApiResponseError } from 'twitter-api-v2';
import { expect, it } from 'vitest';
import { describeLookupFailure, parseLookupArgs } from './diagnose-x-username-lookup';

it('accepts the old database flag without making it part of the lookup options', () => {
  expect(parseLookupArgs(['--database-verified', '--username', '@OpenAI']))
    .toEqual(parseLookupArgs(['--username', '@OpenAI']));
});

it('reports argument parsing failures without echoing the argument', () => {
  try {
    parseLookupArgs(['--unexpected=private-value']);
    throw new Error('Expected parseLookupArgs to reject the option');
  } catch (error) {
    const report = describeLookupFailure(error);
    expect(report).toMatchObject({ status: 'INVALID_ARGUMENTS', code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    expect(JSON.stringify(report)).not.toContain('private-value');
  }
});

it('reports safe transport codes separately from X HTTP statuses', () => {
  const network = new ApiRequestError('private connection details', {
    request: {} as never,
    error: Object.assign(new Error('private address'), { code: 'ENOTFOUND' }),
  });
  const response = new ApiResponseError('private response details', {
    code: 403, request: {} as never, response: {} as never, headers: {}, data: {},
  });

  expect(describeLookupFailure(network)).toEqual({ status: 'X_TRANSPORT_FAILED', code: 'ENOTFOUND' });
  expect(describeLookupFailure(response)).toEqual({ status: 'X_LOOKUP_FAILED', upstreamStatus: 403 });
});
