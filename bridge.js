/* Native Android bridge shims.
   In a normal browser there is no window.AndroidBridge, so this file does nothing.
   Inside the Android app it replaces speech recognition and speech synthesis with the phone's
   own engines, so app.js runs unchanged. */
(function () {
  'use strict';
  var NB = window.AndroidBridge;
  if (!NB) return;

  function define(obj, key, value) {
    try {
      Object.defineProperty(obj, key, { value: value, configurable: true, writable: true });
    } catch (e) {
      try { obj[key] = value; } catch (e2) { /* ignore */ }
    }
  }

  var currentSR = null;
  var speakMap = {};
  var speakSeq = 0;

  /* ---- speech recognition ---- */
  function NativeSR() {
    this.lang = 'en-AU';
    this.interimResults = true;
    this.continuous = false;
    this.maxAlternatives = 1;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  }
  NativeSR.prototype.start = function () {
    currentSR = this;
    NB.startListening(this.lang || '');
  };
  NativeSR.prototype.stop = function () {
    if (currentSR === this) NB.stopListening();
  };
  NativeSR.prototype.abort = function () {
    if (currentSR === this) {
      currentSR = null;
      NB.cancelListening();
    }
  };

  function resultEvent(text, isFinal) {
    var alt = [{ transcript: text, confidence: 1 }];
    alt.isFinal = isFinal;
    return { resultIndex: 0, results: [alt] };
  }

  /* ---- speech synthesis ---- */
  function Utterance(text) {
    this.text = text;
    this.lang = '';
    this.rate = 1;
    this.voice = null;
    this.onend = null;
    this.onerror = null;
  }
  var synth = {
    getVoices: function () { return []; },
    addEventListener: function () {},
    removeEventListener: function () {},
    speak: function (u) {
      var id = 'u' + (++speakSeq);
      speakMap[id] = u;
      NB.speak(id, String(u.text || ''), Number(u.rate) || 1, u.lang || '');
    },
    cancel: function () {
      var pending = speakMap;
      speakMap = {};
      NB.stopSpeaking();
      Object.keys(pending).forEach(function (id) {
        var u = pending[id];
        if (u && u.onerror) u.onerror({ error: 'canceled' });
      });
    }
  };

  /* ---- network calls made by the phone (no browser CORS limits), used for web search ---- */
  var httpWaiting = {};
  var httpSeq = 0;
  window.nativeFetch = function (url, init) {
    init = init || {};
    return new Promise(function (resolve, reject) {
      var id = 'h' + (++httpSeq);
      httpWaiting[id] = { resolve: resolve, reject: reject };
      NB.httpPost(id, String(url), JSON.stringify(init.headers || {}), String(init.body || ''));
    });
  };

  /* ---- events coming from the native side ---- */
  window.__nativeVoice = {
    event: function (type, data) {
      var sr = currentSR;
      try {
        if (type === 'start') {
          if (sr && sr.onstart) sr.onstart();
        } else if (type === 'partial') {
          if (sr && sr.onresult) sr.onresult(resultEvent(data, false));
        } else if (type === 'final') {
          currentSR = null;
          if (sr) {
            if (sr.onresult) sr.onresult(resultEvent(data, true));
            if (sr.onend) sr.onend();
          }
        } else if (type === 'error') {
          currentSR = null;
          if (sr) {
            if (sr.onerror) sr.onerror({ error: data });
            if (sr.onend) sr.onend();
          }
        } else if (type === 'http') {
          var r = JSON.parse(data);
          var w = httpWaiting[r.id];
          if (w) {
            delete httpWaiting[r.id];
            if (r.error) { w.reject(new Error(r.error)); }
            else {
              w.resolve({
                ok: r.status >= 200 && r.status < 300,
                status: r.status,
                text: function () { return Promise.resolve(r.body); },
                json: function () { return Promise.resolve(JSON.parse(r.body)); }
              });
            }
          }
        } else if (type === 'ttsdone') {
          var u = speakMap[data];
          if (u) { delete speakMap[data]; if (u.onend) u.onend({}); }
        } else if (type === 'ttserror') {
          var v = speakMap[data];
          if (v) { delete speakMap[data]; if (v.onerror) v.onerror({ error: 'synthesis-failed' }); }
        }
      } catch (e) { /* never let a handler error break the bridge */ }
    }
  };

  define(window, 'SpeechRecognition', NativeSR);
  define(window, 'webkitSpeechRecognition', NativeSR);
  define(window, 'SpeechSynthesisUtterance', Utterance);
  define(window, 'speechSynthesis', synth);
})();
