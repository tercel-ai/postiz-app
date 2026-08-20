import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { EngageService } from '../engage.service';

// The opt-in switch for unattended replying. It is the ONLY thing standing
// between a plan's reply targets and a real account posting on its own, so the
// contract that matters is: it reaches the row it claims to, and it is refused
// where it would be inert.

const org = { id: 'org-1' } as any;

function makeService() {
  const saveConfig = vi.fn().mockResolvedValue({ id: 'cfg-1' });
  const repo = { saveConfig } as any;
  // Only saveConfig's collaborators are touched here; the rest of the service's
  // dependencies stay unwired (the pacing checks no-op without them).
  const svc = new EngageService(
    repo,
    { getEntitlementSummary: vi.fn() } as any,
    ...(Array(10).fill({}) as any[])
  );
  return { svc: svc as EngageService, saveConfig };
}

describe('EngageService.saveConfig — autoReplyMode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists the mode for a project-scoped config', async () => {
    const { svc, saveConfig } = makeService();

    await svc.saveConfig(org, { autoReplyMode: 'auto', projectId: 'proj-1' } as any);

    // Stored inside `metadata` now, not as a column of its own — the HTTP
    // contract is unchanged, only the storage moved.
    expect(saveConfig).toHaveBeenCalledWith(
      'org-1',
      { metadata: { autoReplyMode: 'auto' } },
      'proj-1'
    );
  });

  it('refuses a non-off mode without a projectId', async () => {
    const { svc, saveConfig } = makeService();

    // The driver only reads project-scoped configs, so this would be stored and
    // echoed back by GET /config while never doing anything.
    await expect(
      svc.saveConfig(org, { autoReplyMode: 'auto' } as any)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.saveConfig(org, { autoReplyMode: 'review' } as any)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("allows turning it 'off' without a projectId", async () => {
    const { svc, saveConfig } = makeService();

    // Switching OFF must never be blocked — that would strand a config an
    // operator is trying to make safe.
    await svc.saveConfig(org, { autoReplyMode: 'off' } as any);

    expect(saveConfig).toHaveBeenCalledWith(
      'org-1',
      { metadata: { autoReplyMode: 'off' } },
      undefined
    );
  });

  it('leaves the mode untouched when the request only toggles enabled', async () => {
    const { svc, saveConfig } = makeService();

    await svc.saveConfig(org, { enabled: false, projectId: 'proj-1' } as any);

    // Absent means "unchanged" — a plain enable/disable must not silently reset
    // a project's reply mode. No `metadata` key at all, so the repository skips
    // the read-merge-write entirely rather than rewriting the settings blob.
    expect(saveConfig).toHaveBeenCalledWith('org-1', { enabled: false }, 'proj-1');
  });
});
