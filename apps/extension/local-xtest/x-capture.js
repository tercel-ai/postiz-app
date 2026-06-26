// Document-start MAIN-world interceptor (vanilla, no build). Installs BEFORE
// x.com's own scripts run, patches fetch + XHR, and stashes the JSON response of
// these GraphQL operations on window.__aiseeXCaptured. Passive + read-only.
(function () {
  var OPS = [
    'SearchTimeline',
    'TweetDetail',
    'TweetResultByRestId',
    'UserByScreenName',
    'UserTweets',
  ];
  var w = window;
  if (w.__aiseeXCaptureInstalled) return;
  w.__aiseeXCaptureInstalled = true;
  w.__aiseeXCaptured = w.__aiseeXCaptured || {};
  console.log('[xtest:capture] installed on', location.href);

  // Substring match; assumes no op name is a substring of another (true today).
  function opFromUrl(url) {
    for (var i = 0; i < OPS.length; i++) {
      if (url.indexOf(OPS[i]) !== -1) return OPS[i];
    }
    return null;
  }
  function stash(op, data) {
    try {
      w.__aiseeXCaptured[op] = { op: op, at: Date.now(), data: data };
      console.log('[xtest:capture] stashed', op);
    } catch (e) {}
  }

  var origFetch = w.fetch;
  if (typeof origFetch === 'function') {
    w.fetch = function () {
      var args = arguments;
      return origFetch.apply(this, args).then(function (res) {
        try {
          var first = args[0];
          var url = typeof first === 'string' ? first : first && first.url;
          var op = typeof url === 'string' ? opFromUrl(url) : null;
          if (op) {
            res
              .clone()
              .json()
              .then(function (j) {
                stash(op, j);
              })
              .catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  var OrigOpen = XMLHttpRequest.prototype.open;
  var OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function () {
    this.__aiseeUrl = arguments[1];
    return OrigOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener('load', function () {
      try {
        var op =
          typeof self.__aiseeUrl === 'string' ? opFromUrl(self.__aiseeUrl) : null;
        if (op) stash(op, JSON.parse(self.responseText));
      } catch (e) {}
    });
    return OrigSend.apply(this, arguments);
  };
})();
