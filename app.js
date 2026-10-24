(() => {
  'use strict';
  const L = window.VoiceLib;
  const STORE = 'voiceapp.v1';
  const DEFAULT_SYSTEM =
    'You are a voice assistant and your reply will be spoken aloud. Answer in short, natural spoken sentences. ' +
    'Do not use markdown, bullet points, headings, emoji or code blocks unless the user asks for them. ' +
    'Keep answers brief unless the user asks for detail.';
  const OA_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
  const MAX_HISTORY = 40;
  const $ = id => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* ---------- state ---------- */
  function defaults() {
    const providers = {};
    for (const [id, p] of Object.entries(L.PROVIDERS)) providers[id] = { key: '', model: p.defaultModel || '', base: '' };
    return {
      provider: 'anthropic', providers, models: {}, system: DEFAULT_SYSTEM,
      lang: navigator.language || 'en-AU',
      handsFree: true, webSearch: true, autoStart: true, wakeLock: true, showTranscript: true,
      tts: { engine: 'browser', voice: '', rate: 1, oaVoice: 'alloy', oaModel: 'gpt-4o-mini-tts' },
      history: []
    };
  }
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function merge(a, b) {
    if (!isObj(b)) return a;
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = isObj(a[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k];
    return out;
  }
  function load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { /* ignore */ }
    return merge(defaults(), saved);
  }
  const S = load();
  function save() {
    S.history = S.history.slice(-MAX_HISTORY);
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* storage full or blocked */ }
  }
  const cfg = () => S.providers[S.provider];

  /* ---------- small UI helpers ---------- */
  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3500);
  }
  function updateChip() {
    const p = L.PROVIDERS[S.provider];
    const m = cfg().model || 'choose a model';
    $('chipText').textContent = p.label + ' · ' + m;
  }
  function addBubble(role, text) {
    const tr = $('transcript');
    const empty = tr.querySelector('.empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    tr.appendChild(el);
    tr.scrollTop = tr.scrollHeight;
    return el;
  }
  function renderHistory() {
    const tr = $('transcript');
    tr.textContent = '';
    if (!S.history.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'Tap the orb and start talking.';
      tr.appendChild(e);
    }
    for (const m of S.history) addBubble(m.role, m.content);
    $('caption').textContent = '';
  }
  function applyLayout() { document.body.classList.toggle('minimal', !S.showTranscript); }

  /* ---------- screen wake lock ---------- */
  let wl = null;
  async function holdAwake(on) {
    try {
      if (on && S.wakeLock && 'wakeLock' in navigator) {
        if (!wl) {
          wl = await navigator.wakeLock.request('screen');
          wl.addEventListener('release', () => { wl = null; });
        }
      } else if (wl) {
        const w = wl; wl = null; await w.release();
      }
    } catch (e) { /* not available or denied */ }
  }

  /* ---------- session state ---------- */
  let state = 'idle';
  let active = false;
  const STATUS = {
    idle: 'Tap to talk',
    listening: 'Listening… tap to cancel',
    thinking: 'Thinking… tap to stop',
    speaking: 'Speaking… tap to interrupt'
  };
  function setState(s) {
    state = s;
    $('orb').className = s;
    $('status').textContent = STATUS[s];
  }
  function setActive(v) { active = v; holdAwake(v); }

  /* ---------- speech output ---------- */
  const audioEl = new Audio();
  audioEl.preload = 'auto';
  let voices = [];
  function loadVoices() {
    try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
    fillVoiceSelect();
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }

  function notAllowed(msg) { const e = new Error(msg || 'Sound is blocked'); e.name = 'NotAllowedError'; return e; }

  function speakBrowser(text) {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) { reject(new Error('This browser cannot speak.')); return; }
      const u = new SpeechSynthesisUtterance(text);
      const v = voices.find(x => x.voiceURI === S.tts.voice);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = S.lang; }
      u.rate = Number(S.tts.rate) || 1;
      u.onend = () => resolve();
      u.onerror = e => {
        if (e.error === 'canceled' || e.error === 'interrupted') resolve();
        else if (e.error === 'not-allowed') reject(notAllowed());
        else reject(new Error('Speech error: ' + e.error));
      };
      speechSynthesis.speak(u);
    });
  }

  async function fetchOpenAISpeech(text, signal) {
    const key = S.providers.openai.key;
    if (!key) throw new Error('Add an OpenAI key to use OpenAI voices.');
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: S.tts.oaModel || 'gpt-4o-mini-tts', voice: S.tts.oaVoice || 'alloy', input: text, response_format: 'mp3' })
    });
    if (!r.ok) throw new Error(L.friendlyError(r.status, await r.text()));
    return URL.createObjectURL(await r.blob());
  }

  function playUrl(url) {
    return new Promise((resolve, reject) => {
      audioEl.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audioEl.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not play audio.')); };
      audioEl.src = url;
      const p = audioEl.play();
      if (p && p.catch) p.catch(err => { reject(err && err.name === 'NotAllowedError' ? notAllowed() : err); });
    });
  }

  const Speaker = {
    q: [], busy: false, streamDone: true, blocked: false, gen: 0, ctl: null,
    reset() { this.stop(); this.streamDone = false; },
    stop() {
      this.gen++; this.q = []; this.busy = false; this.blocked = false;
      try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      try { audioEl.pause(); audioEl.removeAttribute('src'); } catch (e) { /* ignore */ }
      if (this.ctl) { this.ctl.abort(); this.ctl = null; }
    },
    enqueue(text) {
      if (S.tts.engine === 'off') return;
      const item = { text };
      if (S.tts.engine === 'openai') {
        if (!this.ctl) this.ctl = new AbortController();
        item.p = fetchOpenAISpeech(text, this.ctl.signal);
        item.p.catch(() => { /* surfaced when played */ });
      }
      this.q.push(item);
      this.pump();
    },
    finish() { this.streamDone = true; this.checkIdle(); },
    checkIdle() {
      if (this.streamDone && !this.busy && !this.blocked && this.q.length === 0) onSpeechIdle();
    },
    async pump() {
      if (this.busy || this.blocked) return;
      const item = this.q.shift();
      if (!item) { this.checkIdle(); return; }
      this.busy = true;
      const g = this.gen;
      setState('speaking');
      try {
        if (item.p) await playUrl(await item.p); else await speakBrowser(item.text);
      } catch (e) {
        if (g !== this.gen) return;
        if (e && e.name === 'NotAllowedError') {
          this.q.unshift(item); this.blocked = true; this.busy = false;
          showOverlay('Tap to hear the reply', () => { this.blocked = false; this.pump(); });
          return;
        }
        toast((e && e.message) || 'Speech failed');
      }
      if (g !== this.gen) return;
      this.busy = false;
      this.pump();
    }
  };

  function onSpeechIdle() {
    if (active && S.handsFree) listen();
    else { setActive(false); setState('idle'); }
  }

  /* ---------- overlay (one-tap fallback) ---------- */
  let overlayAction = null;
  function showOverlay(text, fn) {
    $('overlayBtn').textContent = text;
    overlayAction = fn;
    $('overlay').hidden = false;
  }
  function hideOverlay() { $('overlay').hidden = true; overlayAction = null; }
  $('overlayBtn').addEventListener('click', () => {
    const fn = overlayAction;
    hideOverlay();
    if (fn) fn();
  });

  /* ---------- listening ---------- */
  let rec = null, recToken = 0, emptyRetries = 0, micLive = false;
  function cancelListen() {
    recToken++;
    if (rec) { try { rec.abort(); } catch (e) { /* ignore */ } rec = null; }
  }
  function listen() {
    if (!SR) {
      toast('This browser has no speech recognition. Use Chrome on Android.', 5000);
      setActive(false); setState('idle'); return;
    }
    cancelListen();
    const token = ++recToken;
    let finalText = '', lastErr = '';
    const r = new SR();
    rec = r;
    r.lang = S.lang || 'en-AU';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onstart = () => { if (token === recToken) { micLive = true; setState('listening'); } };
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript + ' '; else interim += res[0].transcript;
      }
      $('caption').textContent = (finalText + interim).trim();
    };
    r.onerror = e => { lastErr = (e && e.error) || ''; };
    r.onend = () => {
      if (token !== recToken) return;
      rec = null;
      const text = finalText.trim();
      if (text) { emptyRetries = 0; send(text); return; }
      if (lastErr === 'not-allowed' || lastErr === 'service-not-allowed') {
        toast('Microphone is blocked. Allow it for this site in Chrome settings.', 5000);
        setActive(false); setState('idle'); return;
      }
      if (lastErr === 'network') toast('Speech recognition could not reach its service. Check your connection.', 5000);
      if (active && S.handsFree && lastErr !== 'network' && ++emptyRetries <= 2) { listen(); return; }
      emptyRetries = 0; setActive(false); setState('idle');
    };
    try { r.start(); setState('listening'); }
    catch (e) { rec = null; setActive(false); setState('idle'); toast('Could not start the microphone.'); }
  }

  /* ---------- talking to the model ---------- */
  let currentCtl = null;
  function abortRequest() { if (currentCtl) { currentCtl.abort(); currentCtl = null; } }

  async function send(text, opts) {
    opts = opts || {};
    cancelListen(); Speaker.reset(); abortRequest();
    if (opts.typed) setActive(false);
    hideOverlay();
    setState('thinking');
    S.history.push({ role: 'user', content: text });
    addBubble('user', text);
    $('caption').textContent = '';
    save();

    const ctl = new AbortController();
    currentCtl = ctl;
    const bubble = addBubble('assistant', '…');
    const chunker = L.createChunker();
    let full = '', spoke = false;
    const speak = parts => {
      for (const s of parts) {
        const c = L.cleanForSpeech(s);
        if (c) { Speaker.enqueue(c); spoke = true; }
      }
    };

    try {
      const req = L.buildRequest(S.provider, cfg(), S.history, S.system, { search: S.webSearch });
      req.init.signal = ctl.signal;
      const resp = await fetch(req.url, req.init);
      if (!resp.ok) throw new Error(L.friendlyError(resp.status, await resp.text()));
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      const sse = L.createSSEParser();
      const handle = payloads => {
        for (const p of payloads) {
          const t = L.extractDelta(req.kind, p);
          if (!t) continue;
          full += t;
          bubble.textContent = full;
          $('caption').textContent = full;
          $('transcript').scrollTop = $('transcript').scrollHeight;
          speak(chunker.push(t));
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle(sse.feed(dec.decode(value, { stream: true })));
      }
      handle(sse.feed(dec.decode()));
      handle(sse.flush());
      if (!full.trim()) throw new Error('The model sent back an empty reply.');
      speak(chunker.flush());
      if (currentCtl === ctl) currentCtl = null;
      S.history.push({ role: 'assistant', content: full });
      save();
      Speaker.finish();
    } catch (err) {
      if (currentCtl === ctl) currentCtl = null;
      if (err && err.name === 'AbortError') {
        if (full.trim()) { S.history.push({ role: 'assistant', content: full }); }
        else { S.history.pop(); bubble.remove(); }
        save();
        return;
      }
      S.history.pop();
      bubble.remove();
      let msg = (err && err.message) || 'Something went wrong.';
      if (err instanceof TypeError) msg = 'Could not reach the provider. Check your connection and the base URL.';
      const e = addBubble('error', msg);
      e.textContent = msg;
      Speaker.stop();
      setActive(false); setState('idle');
      if (/API key|base URL|Choose a model/.test(msg)) openSettings();
      save();
    }
  }

  /* ---------- orb ---------- */
  $('orb').addEventListener('click', () => {
    hideOverlay();
    switch (state) {
      case 'idle': setActive(true); emptyRetries = 0; listen(); break;
      case 'listening': cancelListen(); setActive(false); setState('idle'); break;
      case 'thinking': abortRequest(); Speaker.stop(); setActive(false); setState('idle'); break;
      case 'speaking':
        Speaker.stop(); abortRequest();
        if (S.handsFree) { setActive(true); listen(); } else { setActive(false); setState('idle'); }
        break;
    }
  });
  $('typeForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('typeInput').value.trim();
    if (!v) return;
    $('typeInput').value = '';
    send(v, { typed: true });
  });

  /* ---------- switcher sheet ---------- */
  function fillDatalist() {
    const pid = S.provider;
    const ids = Array.from(new Set([].concat(L.PROVIDERS[pid].suggestions, S.models[pid] || [])));
    const dl = $('modelList');
    dl.textContent = '';
    for (const id of ids) { const o = document.createElement('option'); o.value = id; dl.appendChild(o); }
  }
  function fillProviderSelect() {
    const sel = $('swProvider');
    sel.textContent = '';
    for (const [id, p] of Object.entries(L.PROVIDERS)) {
      const o = document.createElement('option');
      o.value = id;
      const hasKey = !!S.providers[id].key || id === 'custom';
      o.textContent = p.label + (hasKey ? '' : ' (no key yet)');
      sel.appendChild(o);
    }
    sel.value = S.provider;
  }
  function syncBase() {
    const p = L.PROVIDERS[S.provider];
    $('swBase').value = cfg().base || '';
    $('swBase').placeholder = p.base || 'https://your-host/v1';
    $('swBaseLabel').textContent = S.provider === 'custom' ? 'Base URL (required)' : 'Base URL (optional, leave blank for default)';
  }
  function commitBase() {
    cfg().base = $('swBase').value.trim().replace(/\/+$/, '');
    save();
  }
  function syncSwitcher() {
    fillProviderSelect();
    syncBase();
    $('swModel').value = cfg().model || '';
    fillDatalist();
    $('swStatus').textContent = (S.provider !== 'custom' && !cfg().key)
      ? 'No key for this provider yet. Add it under All settings.' : '';
  }
  async function refreshModels(pid, silent) {
    try {
      const req = L.modelListRequest(pid, S.providers[pid]);
      const r = await fetch(req.url, req.init);
      if (!r.ok) throw new Error(L.friendlyError(r.status, await r.text()));
      const ids = L.parseModelList(pid, await r.json());
      S.models[pid] = ids; save();
      if (pid === S.provider) fillDatalist();
      if (!silent) toast(ids.length + ' models loaded');
    } catch (e) {
      if (!silent) toast((e && e.message) || 'Could not load models.');
    }
  }
  function openSwitcher() { syncSwitcher(); $('switchSheet').hidden = false; }
  $('switchBtn').addEventListener('click', openSwitcher);
  $('btnSwClose').addEventListener('click', () => { $('switchSheet').hidden = true; });
  $('switchSheet').addEventListener('click', e => { if (e.target === $('switchSheet')) $('switchSheet').hidden = true; });
  $('swProvider').addEventListener('change', e => {
    S.provider = e.target.value; save(); updateChip(); syncSwitcher();
    if ((cfg().key || S.provider === 'custom') && !(S.models[S.provider] || []).length) refreshModels(S.provider, true);
  });
  $('swModel').addEventListener('change', e => { cfg().model = e.target.value.trim(); save(); updateChip(); });
  $('swBase').addEventListener('change', commitBase);
  $('btnRefreshModels').addEventListener('click', () => { commitBase(); refreshModels(S.provider, false); });
  $('btnMore').addEventListener('click', () => { $('switchSheet').hidden = true; openSettings(); });

  /* ---------- settings sheet ---------- */
  function buildKeys() {
    const box = $('keysList');
    box.textContent = '';
    for (const [id, p] of Object.entries(L.PROVIDERS)) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const lab = document.createElement('label');
      lab.htmlFor = 'key_' + id;
      lab.textContent = p.label + ' API key';
      const inp = document.createElement('input');
      inp.type = $('showKeys').checked ? 'text' : 'password';
      inp.id = 'key_' + id; inp.className = 'keyInput';
      inp.autocomplete = 'off'; inp.spellcheck = false; inp.autocapitalize = 'off';
      inp.placeholder = p.keyHint;
      inp.value = S.providers[id].key;
      inp.addEventListener('change', () => {
        S.providers[id].key = inp.value.trim(); save(); updateChip();
        if (id === S.provider && S.providers[id].key) refreshModels(id, true);
      });
      wrap.append(lab, inp);
      if (id === 'custom') {
        const lab2 = document.createElement('label');
        lab2.htmlFor = 'base_custom';
        lab2.textContent = 'Custom base URL (ending in /v1)';
        const b = document.createElement('input');
        b.id = 'base_custom'; b.autocomplete = 'off'; b.spellcheck = false; b.autocapitalize = 'off';
        b.placeholder = 'https://your-host/v1';
        b.value = S.providers.custom.base;
        b.addEventListener('change', () => { S.providers.custom.base = b.value.trim(); save(); });
        wrap.append(lab2, b);
      }
      box.appendChild(wrap);
    }
  }
  function fillVoiceSelect() {
    const sel = $('voiceSelect');
    if (!sel) return;
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = ''; auto.textContent = 'Automatic (match language)';
    sel.appendChild(auto);
    const prefix = (S.lang || '').slice(0, 2).toLowerCase();
    const sorted = voices.slice().sort((a, b) => {
      const am = a.lang.toLowerCase().startsWith(prefix) ? 0 : 1;
      const bm = b.lang.toLowerCase().startsWith(prefix) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
    for (const v of sorted) {
      const o = document.createElement('option');
      o.value = v.voiceURI; o.textContent = v.name + ' (' + v.lang + ')';
      sel.appendChild(o);
    }
    sel.value = S.tts.voice || '';
  }
  function syncSettings() {
    buildKeys();
    $('ttsEngine').value = S.tts.engine;
    $('settingsSheet').querySelector('.panel').dataset.engine = S.tts.engine;
    fillVoiceSelect();
    $('rate').value = S.tts.rate;
    $('rateVal').textContent = Number(S.tts.rate).toFixed(2) + '×';
    const ov = $('oaVoice');
    if (!ov.options.length) for (const v of OA_VOICES) { const o = document.createElement('option'); o.value = v; o.textContent = v; ov.appendChild(o); }
    ov.value = S.tts.oaVoice;
    $('oaModel').value = S.tts.oaModel;
    $('lang').value = S.lang;
    $('optHandsFree').checked = S.handsFree;
    $('optAutoStart').checked = S.autoStart;
    $('optWake').checked = S.wakeLock;
    $('optSearch').checked = S.webSearch !== false;
    $('optTranscript').checked = S.showTranscript;
    $('systemPrompt').value = S.system;
  }
  function openSettings() { syncSettings(); $('settingsSheet').hidden = false; }
  function closeSettings() { $('settingsSheet').hidden = true; updateChip(); }
  $('settingsBtn').addEventListener('click', openSettings);
  $('btnClose').addEventListener('click', closeSettings);
  $('settingsSheet').addEventListener('click', e => { if (e.target === $('settingsSheet')) closeSettings(); });
  $('showKeys').addEventListener('change', e => {
    document.querySelectorAll('.keyInput').forEach(i => { i.type = e.target.checked ? 'text' : 'password'; });
  });
  $('ttsEngine').addEventListener('change', e => {
    S.tts.engine = e.target.value; save();
    $('settingsSheet').querySelector('.panel').dataset.engine = S.tts.engine;
  });
  $('voiceSelect').addEventListener('change', e => { S.tts.voice = e.target.value; save(); });
  $('rate').addEventListener('input', e => {
    S.tts.rate = Number(e.target.value); $('rateVal').textContent = S.tts.rate.toFixed(2) + '×'; save();
  });
  $('oaVoice').addEventListener('change', e => { S.tts.oaVoice = e.target.value; save(); });
  $('oaModel').addEventListener('change', e => { S.tts.oaModel = e.target.value.trim() || 'gpt-4o-mini-tts'; save(); });
  $('lang').addEventListener('change', e => { S.lang = e.target.value.trim() || 'en-AU'; save(); fillVoiceSelect(); });
  $('optHandsFree').addEventListener('change', e => { S.handsFree = e.target.checked; save(); });
  $('optAutoStart').addEventListener('change', e => { S.autoStart = e.target.checked; save(); });
  $('optSearch').addEventListener('change', e => {
    S.webSearch = e.target.checked; save();
    if (S.webSearch && !L.searchSupport(S.provider, cfg().model)) toast('Web search is not available for ' + L.PROVIDERS[S.provider].label + ' with this model', 4500);
  });
  $('optWake').addEventListener('change', e => { S.wakeLock = e.target.checked; save(); });
  $('optTranscript').addEventListener('change', e => { S.showTranscript = e.target.checked; save(); applyLayout(); });
  $('systemPrompt').addEventListener('change', e => { S.system = e.target.value.trim() || DEFAULT_SYSTEM; save(); });
  $('btnTestVoice').addEventListener('click', () => {
    Speaker.reset();
    Speaker.enqueue('Hello. This is how I sound.');
    Speaker.finish();
  });
  $('btnClearChat').addEventListener('click', () => { S.history = []; save(); renderHistory(); toast('Conversation cleared'); });
  $('btnResetAll').addEventListener('click', () => {
    if (!confirm('Erase all API keys, settings and the saved conversation from this browser?')) return;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    location.reload();
  });

  /* ---------- lifecycle ---------- */
  function stopAll() {
    cancelListen(); Speaker.stop(); abortRequest(); hideOverlay();
    setActive(false); setState('idle');
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (state !== 'idle') stopAll(); }
    else if (active) holdAwake(true);
  });

  function launchListen() {
    setActive(true); emptyRetries = 0; micLive = false;
    if (SR) listen();
    // If Android would not let the mic start without a tap, offer one big tap target.
    setTimeout(() => {
      if (!micLive && state !== 'thinking' && state !== 'speaking') {
        cancelListen();
        showOverlay('Tap to start listening', () => { setActive(true); listen(); });
      }
    }, 900);
  }

  function boot() {
    if (!(S.provider in L.PROVIDERS)) S.provider = 'anthropic';
    applyLayout();
    renderHistory();
    updateChip();
    setState('idle');
    const params = new URLSearchParams(location.search);
    const NB = window.AndroidBridge;
    if (params.get('overlay') === '1') document.body.classList.add('overlay');
    $('ovClose').addEventListener('click', () => { stopAll(); if (NB && NB.closeOverlay) NB.closeOverlay(); });
    $('ovOpen').addEventListener('click', () => { if (NB && NB.openFull) NB.openFull(); });
    window.__voiceStop = () => { try { stopAll(); } catch (e) { /* ignore */ } };
    window.__voiceListen = () => { if (S.provider === 'custom' || cfg().key) launchListen(); };
    const wantListen = params.get('listen') === '1';
    if (params.has('settings') || (params.has('listen') && params.get('overlay') !== '1')) {
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    }
    if (params.get('settings') === '1') { openSettings(); return; }
    if (S.provider !== 'custom' && !cfg().key) {
      if (NB && document.body.classList.contains('overlay') && NB.openFull) { NB.openFull(); return; }
      openSettings();
      toast('Add an API key to get started', 5000);
      return;
    }
    if (!(S.models[S.provider] || []).length && (cfg().key || S.provider === 'custom')) refreshModels(S.provider, true);
    if (wantListen && S.autoStart) launchListen();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.AndroidBridge) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }
  boot();
})();
