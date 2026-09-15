import { describe, it, expect, vi } from 'vitest';
import {
  isVideoMediaPath,
  limitToOnePostableVideo,
} from '../postable-media';

const img = (n: string) => ({ id: n, path: `https://files.aisee.live/${n}.jpg` });
const vid = (n: string) => ({ id: n, path: `https://files.aisee.live/${n}.mp4` });

describe('isVideoMediaPath', () => {
  it('recognises the extensions the frontend validator treats as video', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'm3u8', 'ts']) {
      expect(isVideoMediaPath(`https://x.test/a.${ext}`), ext).toBe(true);
    }
  });

  it('sees through a query string and a fragment', () => {
    expect(isVideoMediaPath('https://x.test/a.mp4?x=1')).toBe(true);
    expect(isVideoMediaPath('https://x.test/a.mp4#t=3')).toBe(true);
  });

  it('does not call an image a video', () => {
    for (const p of [
      'https://x.test/a.jpg',
      'https://x.test/a.png',
      'https://x.test/a.gif',
      'https://x.test/a.webp',
    ]) {
      expect(isVideoMediaPath(p), p).toBe(false);
    }
  });

  it('is not fooled by a video word that is not the extension', () => {
    expect(isVideoMediaPath('https://x.test/mp4/a.jpg')).toBe(false);
    expect(isVideoMediaPath('https://x.test/a.mp4.jpg')).toBe(false);
  });

  it('handles empty and nullish input', () => {
    expect(isVideoMediaPath('')).toBe(false);
    expect(isVideoMediaPath(null)).toBe(false);
    expect(isVideoMediaPath(undefined)).toBe(false);
  });
});

describe('limitToOnePostableVideo', () => {
  it('leaves an already-valid set alone', () => {
    const images = [img('a'), img('b'), img('c')];
    expect(limitToOnePostableVideo(images)).toBe(images);
    const one = [vid('a')];
    expect(limitToOnePostableVideo(one)).toBe(one);
    expect(limitToOnePostableVideo([])).toEqual([]);
  });

  // The measured case: an X post with two animated GIFs. X stores a GIF as a
  // video, so both re-host as .mp4 and the seeded draft can never publish.
  it('keeps only the first of several videos', () => {
    const dropped: string[] = [];
    const out = limitToOnePostableVideo(
      [vid('RtNhFVwvFR'), vid('8nUclyou1z')],
      (p) => dropped.push(p)
    );
    expect(out).toEqual([vid('RtNhFVwvFR')]);
    expect(dropped).toEqual(['https://files.aisee.live/8nUclyou1z.mp4']);
  });

  it('keeps the images and drops the video when the set mixes both', () => {
    // Images win: a video can only ever be kept one at a time, so keeping the
    // images retains at least as many items and is postable everywhere.
    const out = limitToOnePostableVideo([vid('v'), img('a'), img('b')]);
    expect(out).toEqual([img('a'), img('b')]);
  });

  it('reports every dropped path exactly once', () => {
    const onDrop = vi.fn();
    limitToOnePostableVideo([vid('v1'), vid('v2'), vid('v3')], onDrop);
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onDrop.mock.calls.flat()).toEqual([
      'https://files.aisee.live/v2.mp4',
      'https://files.aisee.live/v3.mp4',
    ]);
  });

  it('never returns an empty set when it was given one to work with', () => {
    // Dropping every item would turn "an unpostable attachment" into "the
    // post silently lost all its media", which is worse.
    expect(limitToOnePostableVideo([vid('a'), vid('b')]).length).toBe(1);
  });

  it('is safe against a non-array', () => {
    expect(limitToOnePostableVideo(undefined as any)).toEqual([]);
  });
});
