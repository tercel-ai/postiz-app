// Reddit media upload for image posts: the classic web flow the (pre-shreddit)
// Reddit frontend used, driven with the user's own session cookies + modhash.
//
//   1. POST /api/media/asset.json { filepath, mimetype, uh } → an S3 upload
//      lease: { args: { action, fields[] }, asset: { asset_id } }.
//   2. Multipart POST the image bytes to `https:${action}` with the lease
//      fields verbatim plus the file — Reddit's own bucket, so the extension
//      needs that host in host_permissions (vite.config.base.ts).
//   3. Reference the asset in the submission selftext as `![img](assetId)` —
//      Reddit renders it as a native inline image (subreddits that disable
//      inline media reject it at submit time with a readable API error).
//
// The image itself is fetched from OUR server (the page passes absolute URLs;
// backend hosts are already in host_permissions).

const REDDIT_BASE = 'https://www.reddit.com';

export interface RedditMediaLease {
  uploadUrl: string;
  fields: Array<{ name: string; value: string }>;
  assetId: string;
}

/** Parse /api/media/asset.json into the bits we need; null when malformed. */
export function parseRedditMediaLease(json: any): RedditMediaLease | null {
  const action = json?.args?.action;
  const fields = json?.args?.fields;
  const assetId = json?.asset?.asset_id;
  if (
    typeof action !== 'string' ||
    !action ||
    !Array.isArray(fields) ||
    typeof assetId !== 'string' ||
    !assetId
  ) {
    return null;
  }
  return {
    uploadUrl: action.startsWith('http') ? action : `https:${action}`,
    fields: fields.filter(
      (f: any) => typeof f?.name === 'string' && f?.value != null
    ),
    assetId,
  };
}

/** Filename for the lease request, derived from the source URL. */
export function mediaFilename(imageUrl: string, mimetype: string): string {
  const last = imageUrl.split('/').pop()?.split(/[?#]/)[0] || '';
  if (last.includes('.')) return last;
  const ext = mimetype.split('/')[1] || 'jpg';
  return `${last || 'image'}.${ext}`;
}

/**
 * Download one image from our server and upload it to Reddit's media store.
 * Returns the asset id to embed as `![img](assetId)`. Throws with a readable
 * message on any step failing — the caller surfaces it as the task error.
 */
export async function uploadRedditImage(
  imageUrl: string,
  modhash: string
): Promise<string> {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`image download failed (${imgRes.status}): ${imageUrl}`);
  }
  const blob = await imgRes.blob();
  const mimetype = blob.type || 'image/jpeg';
  const filepath = mediaFilename(imageUrl, mimetype);

  const leaseRes = await fetch(`${REDDIT_BASE}/api/media/asset.json`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(modhash ? { 'X-Modhash': modhash } : {}),
    },
    body: new URLSearchParams({
      filepath,
      mimetype,
      api_type: 'json',
      uh: modhash,
    }).toString(),
  });
  const leaseJson = await leaseRes.json().catch(() => null);
  const lease = parseRedditMediaLease(leaseJson);
  if (!lease) {
    throw new Error(
      `reddit media lease failed (${leaseRes.status}) for ${filepath}`
    );
  }

  const form = new FormData();
  for (const f of lease.fields) form.append(f.name, String(f.value));
  form.append('file', blob, filepath);
  const up = await fetch(lease.uploadUrl, { method: 'POST', body: form });
  // S3 answers 201 (with XML) on success; some POST policies answer 200/204.
  if (!up.ok && up.status !== 201) {
    throw new Error(`reddit media upload failed (${up.status})`);
  }
  return lease.assetId;
}
