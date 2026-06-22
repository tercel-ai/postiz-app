// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { invalidateEngageRefresh } from './use-engage-visit-refresh';

const keyFor = (orgId: string) => `engage:nextRefreshAt:${orgId}`;

describe('invalidateEngageRefresh', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('clears only the given org when an id is passed', () => {
    window.localStorage.setItem(keyFor('org-1'), '123');
    window.localStorage.setItem(keyFor('org-2'), '456');
    window.localStorage.setItem('unrelated', 'keep');

    invalidateEngageRefresh('org-1');

    expect(window.localStorage.getItem(keyFor('org-1'))).toBeNull();
    expect(window.localStorage.getItem(keyFor('org-2'))).toBe('456');
    expect(window.localStorage.getItem('unrelated')).toBe('keep');
  });

  it('clears all engage gate keys (but nothing else) when no id is passed', () => {
    window.localStorage.setItem(keyFor('org-1'), '123');
    window.localStorage.setItem(keyFor('org-2'), '456');
    window.localStorage.setItem('unrelated', 'keep');

    invalidateEngageRefresh();

    expect(window.localStorage.getItem(keyFor('org-1'))).toBeNull();
    expect(window.localStorage.getItem(keyFor('org-2'))).toBeNull();
    expect(window.localStorage.getItem('unrelated')).toBe('keep');
  });
});
