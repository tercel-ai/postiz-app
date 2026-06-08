// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  buildXReplyUrl,
  createExtensionTaskFromMessage,
  fillContentEditable,
  findXReplyComposer,
  isPostizExtensionTaskMessage,
} from '../browser-assisted-reply';

describe('browser-assisted X replies', () => {
  it('accepts a valid Postiz extension task message', () => {
    const message = {
      source: 'postiz',
      action: 'postiz:extension-task',
      task: {
        platform: 'x',
        type: 'reply',
        opportunityId: 'opp-1',
        externalPostUrl: 'https://x.com/user/status/123?s=20',
        draftContent: 'Helpful reply',
      },
    };

    expect(isPostizExtensionTaskMessage(message)).toBe(true);
    expect(createExtensionTaskFromMessage(message)).toEqual({
      platform: 'x',
      type: 'reply',
      opportunityId: 'opp-1',
      externalPostUrl: 'https://x.com/user/status/123?s=20',
      draftContent: 'Helpful reply',
      createdAt: expect.any(Number),
    });
  });

  it('rejects malformed task messages', () => {
    expect(isPostizExtensionTaskMessage({ source: 'postiz' })).toBe(false);
    expect(
      isPostizExtensionTaskMessage({
        source: 'postiz',
        action: 'postiz:extension-task',
        task: { platform: 'x', type: 'reply', externalPostUrl: '', draftContent: '' },
      })
    ).toBe(false);
    expect(createExtensionTaskFromMessage({ source: 'postiz' })).toBeNull();
  });

  it('normalizes X reply URLs to x.com status URLs without tracking params', () => {
    expect(buildXReplyUrl('https://twitter.com/alice/status/123?s=20#hash')).toBe(
      'https://x.com/alice/status/123'
    );
    expect(buildXReplyUrl('x.com/alice/status/123')).toBe(
      'https://x.com/alice/status/123'
    );
    expect(buildXReplyUrl('https://x.com/alice')).toBeNull();
  });

  it('finds and fills the X reply composer', () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true"></div>
    `;
    const composer = findXReplyComposer(document);
    expect(composer).not.toBeNull();

    const inputEvents: Event[] = [];
    composer?.addEventListener('input', (event) => inputEvents.push(event));

    expect(fillContentEditable(composer!, 'Draft reply')).toBe(true);
    expect(composer?.textContent).toBe('Draft reply');
    expect(inputEvents).toHaveLength(1);
  });

  it('uses execCommand insertText when available', () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true"></div>
    `;
    const composer = findXReplyComposer(document)!;
    Object.defineProperty(document, 'execCommand', {
      value: () => false,
      configurable: true,
    });
    const execCommand = vi
      .spyOn(document, 'execCommand')
      .mockImplementation((command, _showUi, value) => {
        if (command !== 'insertText') return false;
        composer.textContent = value ?? '';
        return true;
      });

    expect(fillContentEditable(composer, 'Inserted reply')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'Inserted reply');
    expect(composer.textContent).toBe('Inserted reply');
  });
});
