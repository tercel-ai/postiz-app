// Self-contained debug helpers for the extension Options page. They exercise the
// "open background tab → let x.com fire its OWN GraphQL → intercept the response"
// path end-to-end, WITHOUT any backend/server call, so the tab+interceptor
// mechanism can be validated in a real browser.
//
//   debugSearchKeyword(kw)  → navigate x.com/search?q=kw&f=live → capture SearchTimeline
//   debugFetchTweet(id)     → navigate x.com/i/web/status/<id>  → capture TweetDetail
//
// Requires the user to be logged into x.com and the document-start interceptor
// (x-capture.ts) to be active (registered via the manifest content_script).

import { ParsedTweet, parseTweetResult, unwrapTweet } from './x.parse';
import { openXReadTab, readXOnce } from './x.tab-reader';

/** Pull every parseable tweet out of a list of timeline instructions. */
function tweetsFromInstructions(instructions: any[]): ParsedTweet[] {
  const out: ParsedTweet[] = [];
  const push = (result: any) => {
    if (!unwrapTweet(result)) return;
    const parsed = parseTweetResult(result);
    if (parsed) out.push(parsed);
  };
  for (const instr of instructions ?? []) {
    for (const entry of instr?.entries ?? []) {
      const id: string = entry?.entryId ?? '';
      const content = entry?.content;
      if (id.startsWith('tweet-')) {
        push(content?.itemContent?.tweet_results?.result);
      } else if (Array.isArray(content?.items)) {
        for (const it of content.items) {
          push(it?.item?.itemContent?.tweet_results?.result);
        }
      }
    }
  }
  return out;
}

/** SearchTimeline `data` → list of tweets. */
export function parseSearchList(data: any): ParsedTweet[] {
  const instructions =
    data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
  return tweetsFromInstructions(instructions);
}

/** TweetDetail `data` → the focal tweet (matching id, else the first). */
export function parseTweetDetailFocal(
  data: any,
  id: string
): ParsedTweet | null {
  const instructions =
    data?.threaded_conversation_with_injections_v2?.instructions ?? [];
  const all = tweetsFromInstructions(instructions);
  return all.find((t) => t.id === id) ?? all[0] ?? null;
}

/** Extract a numeric tweet id from a raw id or any X status URL. */
export function extractTweetId(input: string): string {
  const s = String(input || '').trim();
  const m = s.match(/status(?:es)?\/(\d+)/) || s.match(/(\d{6,})/);
  return m ? m[1] : s.replace(/\D/g, '');
}

/** Keyword search via X's own SearchTimeline (Latest tab). */
export async function debugSearchKeyword(
  keyword: string
): Promise<ParsedTweet[]> {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const session = await openXReadTab();
  if (!session) throw new Error('Could not open a background x.com tab');
  try {
    const url =
      'https://x.com/search?q=' +
      encodeURIComponent(kw) +
      '&f=live&src=typed_query';
    const resp = await session.navigateAndCapture(url, 'SearchTimeline');
    if (resp == null) return [];
    const data = (resp as { data?: unknown }).data ?? resp;
    return parseSearchList(data);
  } finally {
    await session.close();
  }
}

/** Fetch a single tweet's data via X's own TweetDetail (status page). */
export async function debugFetchTweet(
  idOrUrl: string
): Promise<ParsedTweet | null> {
  const id = extractTweetId(idOrUrl);
  if (!id) return null;
  const resp = await readXOnce(
    'https://x.com/i/web/status/' + id,
    'TweetDetail'
  );
  if (resp == null) return null;
  const data = (resp as { data?: unknown }).data ?? resp;
  return parseTweetDetailFocal(data, id);
}
