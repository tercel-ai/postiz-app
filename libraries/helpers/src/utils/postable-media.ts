// "One video, or several images — never a mix, never two videos."
//
// Every target platform enforces some version of that rule, and the frontend
// refuses to submit a draft that breaks it ("Main post: only one video or all
// images allowed", see aisee-app's collectMediaTypeError). A draft the app
// SEEDS for the user therefore has to satisfy it up front — otherwise the user
// is handed a post they cannot publish and no way to tell which attachment is
// at fault.
//
// The case this was written for: an X post carrying two animated GIFs. X
// stores a GIF as a video, so both arrive as `.mp4` and the seeded draft holds
// two videos — measured on x.com/vaato5455/status/2099688427440759097, which
// produced files.aisee.live/RtNhFVwvFR.mp4 + 8nUclyou1z.mp4 and a draft that
// could never be published.

/**
 * Extensions that make a path a VIDEO rather than an image.
 *
 * Kept deliberately identical to `isVideoPath` in aisee-app
 * (`lib/calendar-event.ts`), which is what actually blocks the submit. A
 * narrower list here would let through exactly the drafts that validator
 * rejects, which is the failure this module exists to prevent.
 */
const VIDEO_EXTENSIONS = [
  'mp4',
  'webm',
  'ogg',
  'ogv',
  'mov',
  'avi',
  'mkv',
  'm4v',
  'wmv',
  'flv',
  '3gp',
  'mpeg',
  'mpg',
  'm3u8',
  'ts',
];

const VIDEO_PATH_RE = new RegExp(
  `\\.(${VIDEO_EXTENSIONS.join('|')})(?:[?#]|$)`,
  'i'
);

/** Whether `path` names a video, by the same rule the frontend applies. */
export function isVideoMediaPath(path: string | null | undefined): boolean {
  const value = (path ?? '').trim();
  if (!value) return false;
  return /^data:video\//i.test(value) || VIDEO_PATH_RE.test(value);
}

/**
 * Reduce a media set to something a post can actually carry.
 *
 * Unchanged when it is already valid — a single item of any kind, or any
 * number of images.
 *
 * When it is not, IMAGES WIN: a set holding both keeps its images and drops
 * its videos, because that retains at least as many items as the alternative
 * (a video can only ever be kept one at a time) and images are postable
 * everywhere. Only when there is nothing but videos is the first one kept.
 *
 * `onDrop` is called once per discarded item so the caller can log what went
 * and why — dropping media silently is how "my picture disappeared" becomes
 * unanswerable.
 */
export function limitToOnePostableVideo<T extends { path: string }>(
  items: T[],
  onDrop?: (path: string) => void
): T[] {
  if (!Array.isArray(items) || items.length <= 1) return items ?? [];

  const videos = items.filter((item) => isVideoMediaPath(item.path));
  if (videos.length === 0) return items;

  const images = items.filter((item) => !isVideoMediaPath(item.path));
  const kept = images.length > 0 ? images : [videos[0]];
  if (onDrop) {
    for (const item of items) {
      if (!kept.includes(item)) onDrop(item.path);
    }
  }
  return kept;
}
