// X stores an animated GIF as a VIDEO. `type: 'animated_gif'` carries no gif
// file at all — the only playable form is an mp4, and `media_url_https` is a
// still poster frame. Re-hosting that mp4 verbatim makes the GIF a "video"
// everywhere downstream, and a post carries ONE video or SEVERAL images, never
// two videos. A source post with two GIFs (measured:
// x.com/vaato5455/status/2099688427440759097) therefore seeded a draft that
// could not be published at all.
//
// Turning the mp4 back into a real .gif fixes that properly rather than by
// dropping something: a gif is an IMAGE, so several compose, and postiz's X
// provider already uploads `image/gif` with `media_category: 'tweet_gif'`
// (see x.provider.ts) — so the animation survives all the way to the post.
//
// URL conventions verified live (Sep 2026) against that post's two GIFs:
//
//   mp4     https://video.twimg.com/tweet_video/HSOXegAbkAACBtP.mp4   (176114 B)
//   poster  https://pbs.twimg.com/tweet_video_thumb/HSOXegAbkAACBtP.jpg
//
// Same id in both, which is what makes the poster derivable when transcoding
// is unavailable.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** X's host+path for the mp4 backing an animated GIF (never a real video). */
const X_GIF_MP4_RE =
  /^https?:\/\/video\.twimg\.com\/tweet_video\/([A-Za-z0-9_-]+)\.mp4(?:[?#]|$)/i;

/**
 * Is this the mp4 X serves for an animated GIF?
 *
 * Deliberately narrow. A REAL video lives under `ext_tw_video/` or
 * `amplify_video/` and must not be turned into a gif — that would be a
 * silent, enormous quality and size regression on actual video content.
 */
export function isXAnimatedGifMp4(url: string): boolean {
  return X_GIF_MP4_RE.test((url ?? '').trim());
}

/**
 * The still frame X publishes alongside a GIF, derived from the mp4 url.
 *
 * The fallback for when transcoding cannot run: a jpg is an image, so several
 * still compose into one post — the animation is lost but no content is.
 */
export function xAnimatedGifPosterUrl(url: string): string | null {
  const id = X_GIF_MP4_RE.exec((url ?? '').trim())?.[1];
  return id ? `https://pbs.twimg.com/tweet_video_thumb/${id}.jpg` : null;
}

/**
 * Bytes out of the `data:<type>;base64,<...>` URI fetchMediaAsDataUri returns.
 *
 * Returns an empty buffer for anything that is not that shape, so a caller
 * feeding it something unexpected gets a transcode that declines rather than
 * a throw in the middle of an already-billed generation.
 */
export function dataUriToBuffer(dataUri: string): Buffer {
  // [\s\S] rather than the /s flag: this file is compiled under more than one
  // tsconfig here and the older target rejects dotAll (TS1501).
  const base64 = /^data:[^,]*;base64,([\s\S]*)$/.exec(dataUri ?? '')?.[1];
  if (!base64) return Buffer.alloc(0);
  try {
    return Buffer.from(base64, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/** ffmpeg is resolved at call time so a missing binary degrades, never throws. */
const FFMPEG_BIN = () => process.env.FFMPEG_PATH || 'ffmpeg';

// Output budget, chosen by MEASURING the two GIFs from the post that prompted
// this (176 KB and 226 KB of h264). A gif is a barely-compressed format and
// the blow-up is brutal, so the knobs matter more than they look:
//
//   fps=15 w=480 colors=256   9.7 MB + 2.9 MB      (the naive settings)
//   fps=15 w=480 colors=128   7.8 MB + 2.3 MB
//   fps=12 w=400 colors=128   4.8 MB + 1.4 MB
//   fps=12 w=360 colors=96    3.5 MB + 1.0 MB      ← chosen
//   fps=10 w=360 colors=64    2.5 MB + 0.7 MB
//
// 360px is about the width an inline post image actually renders at, and 12fps
// is smooth enough for a reaction GIF. X's own ceiling is 15 MB, but attaching
// even 10 MB to a post is its own problem — anything over MAX_OUTPUT_BYTES
// falls back to the poster frame, which is a better outcome than a post that
// takes ten seconds to load.
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_WIDTH = 360;
const MAX_COLORS = 96;
const FPS = 12;
// 15s, not more: a measured transcode of these clips takes ~0.7s, and this
// runs inside a user-facing generation that already allows 20s per download
// for up to 4 items. The timeout only exists for a wedged ffmpeg.
const TIMEOUT_MS = 15_000;

/**
 * mp4 → animated gif, or null when it cannot be done.
 *
 * Null is the EXPECTED outcome wherever ffmpeg is not present, which today is
 * everywhere: the binary is deliberately NOT installed in the image, so this
 * whole path is opt-in — provide an ffmpeg (apt, brew, or FFMPEG_PATH) and
 * GIFs start arriving animated; provide none and the caller falls back to X's
 * poster frame, which still keeps every GIF on the post as a still image.
 *
 * The other null cases are the clip being too big and the result overshooting
 * the size budget. None of them may fail a post generation that has already
 * been billed, so every one returns null rather than throwing.
 *
 * Two passes in one graph — `palettegen` then `paletteuse` — because the
 * single-pass default quantises to a fixed 256-colour web palette and makes
 * photographic frames look like 1996. Frames and width are capped first so
 * the palette is computed on what is actually emitted.
 */
export async function transcodeMp4ToAnimatedGif(
  mp4: Buffer
): Promise<Buffer | null> {
  if (!mp4?.length || mp4.length > MAX_INPUT_BYTES) return null;

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'aisee-gif-'));
    const input = join(dir, 'in.mp4');
    const output = join(dir, 'out.gif');
    await writeFile(input, mp4);

    const ok = await runFfmpeg([
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      input,
      '-filter_complex',
      `fps=${FPS},scale=${MAX_WIDTH}:-1:flags=lanczos:force_original_aspect_ratio=decrease,` +
        `split[s0][s1];[s0]palettegen=max_colors=${MAX_COLORS}:stats_mode=diff[p];` +
        '[s1][p]paletteuse=dither=bayer:bayer_scale=4',
      '-loop',
      '0',
      '-y',
      output,
    ]);
    if (!ok) return null;

    const gif = await readFile(output);
    if (!gif.length || gif.length > MAX_OUTPUT_BYTES) return null;
    return gif;
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Run ffmpeg to completion. False on a missing binary, non-zero exit or timeout.
 *
 * stderr is CAPTURED, not discarded. Everything here degrades quietly by
 * design, which is exactly why a broken filter graph would otherwise be
 * invisible: a future ffmpeg that rejects one of these options would send
 * every GIF down the poster-frame path forever with nothing to explain it.
 * A missing binary is the one expected failure, so that one stays silent.
 */
function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(FFMPEG_BIN(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve(false);
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      // Bounded: a failing ffmpeg can be very talkative.
      if (stderr.length < 2000) stderr += String(chunk);
    });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // A wedged ffmpeg must not hold a user-facing generation open forever.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(false);
    }, TIMEOUT_MS);
    // 'error' covers ENOENT — the binary is not installed on this host.
    child.on('error', () => finish(false));
    child.on('close', (code) => {
      if (code !== 0 && stderr.trim()) {
        console.warn(`[x-animated-gif] ffmpeg exited ${code}: ${stderr.trim()}`);
      }
      finish(code === 0);
    });
  });
}
