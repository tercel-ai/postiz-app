// Standalone service worker (vanilla). Opens a BACKGROUND x.com tab, navigates so
// X's OWN page fires the GraphQL request, reads what x-capture.js intercepted,
// parses it, and returns it to the Options page. No backend, no server API.

// ── parse (ported from x.parse.ts) ───────────────────────────────────────────
function unwrapTweet(result) {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults') return result.tweet || null;
  if (result.tweet && !result.legacy) return result.tweet;
  return result;
}
function parseTweetResult(result) {
  var t = unwrapTweet(result);
  var legacy = t && t.legacy;
  var id = (t && t.rest_id) || (legacy && legacy.id_str);
  if (!t || !legacy || !id) return null;
  var user = t.core && t.core.user_results && t.core.user_results.result;
  var uLegacy = user && user.legacy;
  var screenName =
    (uLegacy && uLegacy.screen_name) || (user && user.core && user.core.screen_name) || '';
  var noteText =
    t.note_tweet &&
    t.note_tweet.note_tweet_results &&
    t.note_tweet.note_tweet_results.result &&
    t.note_tweet.note_tweet_results.result.text;
  var text = noteText || legacy.full_text || legacy.text || '';
  var views = Number(t.views && t.views.count ? t.views.count : 0) || 0;
  return {
    id: String(id),
    text: String(text),
    createdAt: legacy.created_at ? new Date(legacy.created_at).toISOString() : new Date().toISOString(),
    authorUsername: String(screenName || ''),
    likes: Number(legacy.favorite_count) || 0,
    replies: Number(legacy.reply_count) || 0,
    retweets: Number(legacy.retweet_count) || 0,
    quotes: Number(legacy.quote_count) || 0,
    bookmarks: Number(legacy.bookmark_count) || 0,
    views: views,
  };
}
function tweetsFromInstructions(instructions) {
  var out = [];
  function push(result) {
    if (!unwrapTweet(result)) return;
    var p = parseTweetResult(result);
    if (p) out.push(p);
  }
  (instructions || []).forEach(function (instr) {
    ((instr && instr.entries) || []).forEach(function (entry) {
      var id = (entry && entry.entryId) || '';
      var content = entry && entry.content;
      if (id.indexOf('tweet-') === 0) {
        push(content && content.itemContent && content.itemContent.tweet_results && content.itemContent.tweet_results.result);
      } else if (content && Array.isArray(content.items)) {
        content.items.forEach(function (it) {
          push(it && it.item && it.item.itemContent && it.item.itemContent.tweet_results && it.item.itemContent.tweet_results.result);
        });
      }
    });
  });
  return out;
}
function parseSearchList(data) {
  var ins =
    data && data.search_by_raw_query && data.search_by_raw_query.search_timeline &&
    data.search_by_raw_query.search_timeline.timeline &&
    data.search_by_raw_query.search_timeline.timeline.instructions;
  return tweetsFromInstructions(ins || []);
}
function parseTweetDetailFocal(data, id) {
  var ins =
    data && data.threaded_conversation_with_injections_v2 &&
    data.threaded_conversation_with_injections_v2.instructions;
  var all = tweetsFromInstructions(ins || []);
  return all.filter(function (t) { return t.id === id; })[0] || all[0] || null;
}
function extractTweetId(input) {
  var s = String(input || '').trim();
  var m = s.match(/status(?:es)?\/(\d+)/) || s.match(/(\d{6,})/);
  return m ? m[1] : s.replace(/\D/g, '');
}

// ── background tab session ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
async function readCaptured(tabId, op, sinceMs) {
  try {
    var res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function (operation, since) {
        var cap = window.__aiseeXCaptured;
        var e = cap && cap[operation];
        return e && e.at >= since ? e.data : null;
      },
      args: [op, sinceMs],
    });
    return (res && res[0] && res[0].result) || null;
  } catch (e) {
    console.warn('[xtest] readCaptured failed', e);
    return null;
  }
}
async function navigateAndCapture(tabId, url, op) {
  var since = Date.now();
  await chrome.tabs.update(tabId, { url: url });
  await waitForTabComplete(tabId, 15000);
  var deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    var data = await readCaptured(tabId, op, since);
    if (data != null) return data;
    await sleep(250);
  }
  return null;
}
async function withTab(fn) {
  var tabId;
  var tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  tabId = tab && tab.id;
  if (tabId == null) throw new Error('could not open background tab');
  try {
    return await fn(tabId);
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }
}

async function debugSearch(keyword, limit) {
  var kw = String(keyword || '').trim();
  if (!kw) return [];
  return withTab(async function (tabId) {
    var url = 'https://x.com/search?q=' + encodeURIComponent(kw) + '&f=live&src=typed_query';
    var resp = await navigateAndCapture(tabId, url, 'SearchTimeline');
    if (resp == null) return [];
    var data = (resp && resp.data) || resp;
    return parseSearchList(data).slice(0, Math.max(0, limit || 20));
  });
}
async function debugTweet(idOrUrl) {
  var id = extractTweetId(idOrUrl);
  if (!id) return null;
  return withTab(async function (tabId) {
    var resp = await navigateAndCapture(tabId, 'https://x.com/i/web/status/' + id, 'TweetDetail');
    if (resp == null) return null;
    var data = (resp && resp.data) || resp;
    return parseTweetDetailFocal(data, id);
  });
}

// ── message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request && request.action === 'xdebug:search') {
    debugSearch(request.keyword, request.limit)
      .then(function (tweets) { sendResponse({ ok: true, tweets: tweets }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }
  if (request && request.action === 'xdebug:tweet') {
    debugTweet(request.id)
      .then(function (tweet) { sendResponse({ ok: true, tweet: tweet }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }
});
