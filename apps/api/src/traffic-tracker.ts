/** Served by the API so snippet and collector always use the same deployed version. */
export const trafficTracker = String.raw`(function () {
  'use strict';
  try {
    var script = document.currentScript;
    if (!script || window.__citeviaTrafficInstalled) return;
    var projectId = script.getAttribute('data-project-id');
    if (!projectId) return;
    window.__citeviaTrafficInstalled = true;
    var endpoint = new URL('collect', script.src).href;
    var initialReferrer = document.referrer || '';
    var initialParams = new URLSearchParams(location.search);
    var initialSource = initialParams.get('utm_source') || '';
    var initialTestId = initialParams.get('citevia_test') || null;
    var domains = ['chatgpt.com','openai.com','claude.ai','claude.com','perplexity.ai','gemini.google.com','bard.google.com','copilot.microsoft.com','copilot.com','deepseek.com'];
    var aliases = ['chatgpt','chat-gpt','openai','claude','anthropic','perplexity','gemini','copilot','deepseek'];
    var host = '';
    try { host = new URL(initialReferrer).hostname.toLowerCase(); } catch (_) {}
    if (!domains.some(function (domain) { return host === domain || host.endsWith('.' + domain); }) && aliases.indexOf(initialSource.toLowerCase().trim()) < 0 && domains.indexOf(initialSource.toLowerCase().trim()) < 0) return;
    var lastUrl = '';
    function send() {
      var url = new URL(location.href);
      if (url.href === lastUrl) return;
      lastUrl = url.href;
      var payload = JSON.stringify({
        id: crypto.randomUUID(), projectId: projectId, url: url.href,
        referrer: initialReferrer, utmSource: initialSource,
        testId: initialTestId
      });
      // A simple cross-origin request avoids a preflight and sends no cookies.
      fetch(endpoint, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' },
        keepalive: true, mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer'
      }).catch(function () {});
    }
    send();
    ['pushState','replaceState'].forEach(function (name) {
      var original = history[name];
      history[name] = function () { var result = original.apply(this, arguments); send(); return result; };
    });
    window.addEventListener('popstate', send);
  } catch (_) { /* Analytics must never interrupt the host website. */ }
})();`;
