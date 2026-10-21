/** Served by the API so installed snippets receive fixes without republishing host sites. */
export const trafficTracker = String.raw`(function () {
  'use strict';
  try {
    var script = document.currentScript;
    if (!script || !script.getAttribute('data-project-id')) {
      var scripts = document.querySelectorAll('script[data-project-id][src]');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (/\/traffic\/tracker\.js(?:[?#]|$)/.test(scripts[i].src)) { script = scripts[i]; break; }
      }
    }
    if (!script) return;
    var projectId = script.getAttribute('data-project-id');
    if (!projectId) return;
    var endpoint = new URL('collect', script.src).href;
    var key = endpoint + ':' + projectId;
    var installed = window.__citeviaTrafficTrackers || (window.__citeviaTrafficTrackers = Object.create(null));
    if (installed[key]) return;
    installed[key] = true;
    var initialReferrer = document.referrer || '';
    var initialParams = new URLSearchParams(location.search);
    var initialSource = initialParams.get('utm_source') || '';
    var initialTestId = initialParams.get('citevia_test') || null;
    var domains = ['chatgpt.com','openai.com','claude.ai','claude.com','perplexity.ai','gemini.google.com','bard.google.com','copilot.microsoft.com','copilot.com','deepseek.com'];
    var aliases = ['chatgpt','chat-gpt','openai','claude','anthropic','perplexity','gemini','copilot','deepseek'];
    var host = '';
    try { var referrerUrl = new URL(initialReferrer); host = referrerUrl.hostname.toLowerCase(); initialReferrer = referrerUrl.origin; } catch (_) { initialReferrer = ''; }
    var aiReferral = domains.some(function (domain) { return host === domain || host.endsWith('.' + domain); }) || aliases.indexOf(initialSource.toLowerCase().trim()) >= 0 || domains.indexOf(initialSource.toLowerCase().trim()) >= 0;
    function uuid() {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      var bytes = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.from(bytes, function (n) { return n.toString(16).padStart(2,'0'); }).join('');
      return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
    }
    function deliver(payload, attempt) {
      try {
        // Send only the site origin; never leak page paths or URL parameters through Referrer.
        var operation = fetch(endpoint, { method:'POST',body:payload,headers:{'Content-Type':'text/plain'},
          keepalive:true,mode:'no-cors',credentials:'omit',referrerPolicy:'origin' });
        if (operation && operation.catch) operation.catch(function () {
          if (attempt < 2) setTimeout(function () { deliver(payload, attempt + 1); }, 1000 * (attempt + 1));
        });
      } catch (_) {
        if (attempt < 2) setTimeout(function () { deliver(payload, attempt + 1); }, 1000 * (attempt + 1));
      }
    }
    var lastUrl = '';
    function send() {
      try {
        var url = new URL(location.href);
        var pageUrl = url.origin + url.pathname;
        if (pageUrl === lastUrl) return;
        lastUrl = pageUrl;
        deliver(JSON.stringify({type:aiReferral && !initialTestId ? 'pageview':'installation',trackerVersion:'citevia-v2',
          id:uuid(),projectId:projectId,url:pageUrl,referrer:initialReferrer,utmSource:initialSource,testId:initialTestId}), 0);
      } catch (_) { /* Tracking must never interrupt the host site's navigation. */ }
    }
    send();
    ['pushState','replaceState'].forEach(function (name) {
      var original = history[name];
      history[name] = function () { var result = original.apply(this, arguments); send(); return result; };
    });
    window.addEventListener('popstate', send);
    window.addEventListener('online', function () { lastUrl = ''; send(); });
  } catch (_) { /* Analytics must never interrupt the host website. */ }
})();`;
