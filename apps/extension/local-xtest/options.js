function log() {
  var args = ['[xtest:options]'].concat([].slice.call(arguments));
  console.log.apply(console, args);
}

function send(message) {
  log('→ sendMessage', message);
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(message, function (resp) {
      var err = chrome.runtime.lastError;
      if (err) {
        console.error('[xtest:options] ✗ runtime error', err.message);
        return reject(new Error(err.message));
      }
      log('← response', resp);
      resolve(resp);
    });
  });
}

function tweetEl(t) {
  var div = document.createElement('div');
  div.className = 'item';
  var meta = document.createElement('div');
  meta.className = 'meta';
  var a = document.createElement('a');
  a.href =
    'https://x.com/' + encodeURIComponent(t.authorUsername) + '/status/' + encodeURIComponent(t.id);
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = '@' + t.authorUsername;
  var date = document.createElement('span');
  date.textContent = t.createdAt;
  meta.appendChild(a);
  meta.appendChild(date);
  var text = document.createElement('div');
  text.className = 'text';
  text.textContent = t.text;
  var stats = document.createElement('div');
  stats.className = 'stats';
  stats.textContent =
    '❤ ' + t.likes + ' · 🔁 ' + t.retweets +
    ' · 💬 ' + t.replies + ' · 🔖 ' + t.bookmarks +
    ' · 👁 ' + t.views;
  div.appendChild(meta);
  div.appendChild(text);
  div.appendChild(stats);
  return div;
}

function setStatus(el, msg, isErr) {
  el.textContent = msg || '';
  el.className = 'status' + (isErr ? ' err' : '');
}

function render(listEl, tweets) {
  listEl.innerHTML = '';
  tweets.forEach(function (t) { listEl.appendChild(tweetEl(t)); });
}

var kw = document.getElementById('kw');
var limit = document.getElementById('limit');
var searchBtn = document.getElementById('searchBtn');
var searchStatus = document.getElementById('searchStatus');
var searchList = document.getElementById('searchList');

async function runSearch() {
  var q = (kw.value || '').trim();
  if (!q) return;
  var n = Number(limit.value) || 20;
  log('runSearch start', { keyword: q, limit: n });
  var t0 = Date.now();
  searchBtn.disabled = true;
  render(searchList, []);
  setStatus(searchStatus, '搜索中…（开后台标签页，约数秒）');
  try {
    var resp = await send({ action: 'xdebug:search', keyword: q, limit: n });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'failed');
    var tweets = resp.tweets || [];
    log('runSearch done', { count: tweets.length, ms: Date.now() - t0, tweets: tweets });
    render(searchList, tweets);
    setStatus(searchStatus, '共 ' + tweets.length + ' 条' + (tweets.length ? '' : '（空：可能拦截超时或未登录 x.com）'));
  } catch (e) {
    console.error('[xtest:options] runSearch error', e);
    setStatus(searchStatus, '错误：' + (e && e.message ? e.message : e), true);
  } finally {
    searchBtn.disabled = false;
  }
}

var tid = document.getElementById('tid');
var tweetBtn = document.getElementById('tweetBtn');
var tweetStatus = document.getElementById('tweetStatus');
var tweetList = document.getElementById('tweetList');

async function runTweet() {
  var v = (tid.value || '').trim();
  if (!v) return;
  log('runTweet start', { input: v });
  var t0 = Date.now();
  tweetBtn.disabled = true;
  render(tweetList, []);
  setStatus(tweetStatus, '获取中…（开后台标签页，约数秒）');
  try {
    var resp = await send({ action: 'xdebug:tweet', id: v });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'failed');
    log('runTweet done', { ms: Date.now() - t0, tweet: resp.tweet });
    if (resp.tweet) {
      render(tweetList, [resp.tweet]);
      setStatus(tweetStatus, '已获取');
    } else {
      setStatus(tweetStatus, '未取到数据（ID 无效 / 拦截超时 / 未登录 x.com）');
    }
  } catch (e) {
    console.error('[xtest:options] runTweet error', e);
    setStatus(tweetStatus, '错误：' + (e && e.message ? e.message : e), true);
  } finally {
    tweetBtn.disabled = false;
  }
}

searchBtn.addEventListener('click', runSearch);
kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') runSearch(); });
tweetBtn.addEventListener('click', runTweet);
tid.addEventListener('keydown', function (e) { if (e.key === 'Enter') runTweet(); });
