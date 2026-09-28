import { Logger } from '@nestjs/common';

/**
 * Builds the OpenAI client handed to `@copilotkit/runtime`'s `OpenAIAdapter`.
 *
 * The adapter drives its client through `openai.beta.chat.completions.stream()`
 * (see `OpenAIAdapter.process`). That namespace only exists in the openai v4
 * line — it was removed in v6, which is what this repo depends on at the root
 * (`openai: ^6.2.0`, currently resolving to 6.16.0).
 *
 * The adapter itself is unaffected by that: `@copilotkit/runtime` declares
 * `openai: ^4.85.1`, so the package manager installs a nested copy under
 * `@copilotkit/runtime/node_modules/openai`, and the client the adapter builds
 * for itself (`new OpenAI({})` when no client is passed) comes from there.
 *
 * The crash only happens when WE hand the adapter a client, which the OpenRouter
 * path has to do: `OpenAIAdapterParams` exposes no `baseURL`/`apiKey` knob, only
 * `openai`. Passing a root-imported v6 instance leaves `client.beta.chat`
 * undefined, and every `/copilot/chat` request dies inside the adapter with
 * `TypeError: Cannot read properties of undefined (reading 'completions')` —
 * surfaced to the browser as an error frame in the stream, so it reads as
 * "the assistant stopped answering" rather than as a crash.
 *
 * Fix: resolve the very same nested v4 constructor the adapter would have used,
 * and build the OpenRouter client with that.
 */

const logger = new Logger('CopilotOpenAiClient');

/**
 * The slice of the openai v4 surface the adapter actually touches. Intentionally
 * minimal — this is a compatibility shim, not a client wrapper.
 */
export interface CopilotOpenAiClient {
  beta: {
    chat: {
      completions: {
        stream: (params: Record<string, unknown>) => unknown;
      };
    };
  };
}

type CopilotOpenAiCtor = new (opts: {
  apiKey: string;
  baseURL?: string;
}) => CopilotOpenAiClient;

let _cachedCtor: CopilotOpenAiCtor | null = null;

/**
 * Resolve `openai` from `@copilotkit/runtime`'s own resolution scope, i.e. the
 * nested v4 copy. Falls back to a plain `openai` resolution so a future layout
 * where the runtime and the root agree on a version still works.
 *
 * Throws if the resolved module lacks `beta.chat.completions.stream`, because
 * that is precisely the condition that would otherwise fail mid-stream on every
 * request: better a loud error at adapter construction than a silent one per
 * chat turn.
 */
export function resolveCopilotOpenAiCtor(): CopilotOpenAiCtor {
  if (_cachedCtor) {
    return _cachedCtor;
  }

  const candidates: Array<() => string> = [
    // Preferred: whatever `@copilotkit/runtime` itself would load.
    () =>
      require.resolve('openai', {
        paths: [require.resolve('@copilotkit/runtime')],
      }),
    // Fallback: the root install.
    () => require.resolve('openai'),
  ];

  const failures: string[] = [];

  for (const resolvePath of candidates) {
    let modulePath: string;
    try {
      modulePath = resolvePath();
    } catch (err) {
      failures.push((err as Error).message);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modulePath);
    const ctor = (mod.default || mod) as CopilotOpenAiCtor;

    // Probe the instance, not the prototype: in openai v4 the resource
    // namespaces are assigned in the constructor, so `beta` does not exist on
    // the prototype and a prototype check would reject a working client.
    let probe: CopilotOpenAiClient;
    try {
      probe = new ctor({ apiKey: 'probe' });
    } catch (err) {
      failures.push(`${modulePath}: construction failed — ${(err as Error).message}`);
      continue;
    }

    if (typeof probe?.beta?.chat?.completions?.stream !== 'function') {
      failures.push(
        `${modulePath}: no beta.chat.completions.stream (openai v6+ removed it)`
      );
      continue;
    }

    logger.log(`Using openai client from ${modulePath} for CopilotKit`);
    _cachedCtor = ctor;
    return ctor;
  }

  throw new Error(
    'Could not resolve an openai client exposing beta.chat.completions.stream, ' +
      'which @copilotkit/runtime\'s OpenAIAdapter requires. Tried: ' +
      failures.join(' | ')
  );
}

/**
 * OpenRouter-backed client for the CopilotKit adapter.
 *
 * Cast at the call site rather than here: the adapter's `openai?: OpenAI` param
 * is typed against the ROOT openai v6 types, which this v4 instance does not
 * structurally satisfy even though it is the version the adapter wants.
 */
export function createCopilotOpenRouterClient(
  apiKey: string
): CopilotOpenAiClient {
  const Ctor = resolveCopilotOpenAiCtor();
  return new Ctor({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });
}
