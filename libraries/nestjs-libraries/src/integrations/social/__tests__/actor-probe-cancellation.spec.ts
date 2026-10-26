import { afterEach, describe, expect, it, vi } from 'vitest';
import { XProvider } from '../x.provider';
import { RedditProvider } from '../reddit.provider';
import { LinkedinPageProvider } from '../linkedin.page.provider';

afterEach(() => vi.restoreAllMocks());

describe('identity probe transport cancellation', () => {
  it('passes the deadline signal into the X SDK HTTPS request options', async () => {
    const controller = new AbortController();
    const provider = new XProvider();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(provider as any, '_getUserInfo').mockImplementation(
      async (client: any) => {
        const requestOptions: { signal?: AbortSignal } = {};
        for (const plugin of client.getPlugins())
          await plugin.onBeforeRequest?.({ requestOptions });
        requestSignal = requestOptions.signal;
        return { id: '123' };
      }
    );

    await provider.getSendActor({ token: 'secret' } as any, controller.signal);

    expect(requestSignal).toBe(controller.signal);
    controller.abort();
    expect(requestSignal!.aborted).toBe(true);
  });

  it('passes the deadline signal to the Reddit identity request', async () => {
    const controller = new AbortController();
    const provider = new RedditProvider();
    const fetch = vi
      .spyOn(provider, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'abc' })));

    await provider.getSendActor({ token: 'secret' } as any, controller.signal);

    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('passes the deadline signal to the LinkedIn company membership request', async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          elements: [
            {
              organizationalTarget: 'urn:li:organization:123',
              'organizationalTarget~': {
                vanityName: 'acme',
                localizedName: 'Acme',
              },
            },
          ],
        })
      )
    );

    await new LinkedinPageProvider().getSendActor(
      {
        providerIdentifier: 'linkedin-page',
        internalId: '123',
        token: 'secret',
      } as any,
      controller.signal
    );

    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});
