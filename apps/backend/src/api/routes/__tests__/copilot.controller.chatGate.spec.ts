import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopilotController } from '../copilot.controller';

/**
 * POST /copilot/chat is the site-wide CopilotKit runtime. It backs
 * postiz-frontend's editor assistant and autosuggestion boxes; aisee-app — the
 * frontend actually deployed against this backend — only calls /copilot/agent.
 * So the route ships OFF, and must stay off unless COPILOT_CHAT_ENABLED says
 * otherwise: left on, it is a billable LLM path with no consumer.
 */

const ORG = { id: 'org-1' } as any;

function build() {
  const controller = new CopilotController(
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );

  const res: any = {
    statusCode: undefined,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json: vi.fn(function (this: any, payload: any) {
      this.body = payload;
      return this;
    }),
    on: vi.fn(),
  };

  return { controller, res, req: { body: {} } as any };
}

describe('CopilotController POST /chat — enablement gate', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    delete process.env.COPILOT_CHAT_ENABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.IMAGE_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('is off when the variable is unset', () => {
    const { controller, res, req } = build();

    controller.chatAgent(req, res, ORG);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('stays off for every value that is not exactly "true"', () => {
    for (const value of ['false', 'FALSE', '', '0', 'yes', 'on', '1']) {
      process.env.COPILOT_CHAT_ENABLED = value;
      const { controller, res, req } = build();

      controller.chatAgent(req, res, ORG);

      expect(res.statusCode, `value=${JSON.stringify(value)}`).toBe(404);
    }
  });

  it('accepts "true" case-insensitively and with surrounding space', () => {
    for (const value of ['true', 'TRUE', ' true ']) {
      process.env.COPILOT_CHAT_ENABLED = value;
      const { controller, res, req } = build();

      controller.chatAgent(req, res, ORG);

      // Past the gate, the next guard (no API key) answers 503 — which is the
      // point: it is no longer a 404.
      expect(res.statusCode, `value=${JSON.stringify(value)}`).toBe(503);
    }
  });

  it('answers 404 before ever constructing the adapter', () => {
    // createServiceAdapter() throws when IMAGE_PROVIDER=openrouter without a key.
    // A disabled route must never reach it.
    process.env.IMAGE_PROVIDER = 'openrouter';
    const { controller, res, req } = build();

    expect(() => controller.chatAgent(req, res, ORG)).not.toThrow();
    expect(res.statusCode).toBe(404);
  });

  it('answers 503 rather than hanging when AI is unconfigured', () => {
    // A bare `return` under @Res() sends nothing and holds the connection open
    // until it times out. Both copilot routes must answer.
    process.env.COPILOT_CHAT_ENABLED = 'true';
    const { controller, res, req } = build();

    controller.chatAgent(req, res, ORG);

    expect(res.statusCode).toBe(503);
    expect(res.json).toHaveBeenCalled();
  });
});
