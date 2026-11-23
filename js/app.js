/* UIL Spelling Coach — all logic runs in the browser; progress is stored in localStorage. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- data ----
  // The word list is shipped lightly encoded so it can't be read by glancing at
  // the page source or found with Ctrl+F. It is decoded only in memory.
  function decodePack(pack) {
    const key = pack.k;
    const bin = atob(pack.d);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const DATA = decodePack(window.UIL_PACK);
  delete window.UIL_PACK;
  const BY_ID = new Map(DATA.map((d) => [d.id, d]));
  const GRADE_NAME = { '34': 'Grades 3–4', '56': 'Grades 5–6', '78': 'Grades 7–8', all: 'All grades' };
  const CONTEST = { '34': [50, 15], '56': [80, 20], '78': [110, 30], all: [80, 20] };
  const POOL = {};
  for (const g of ['34', '56', '78', 'all']) POOL[g] = DATA.filter((d) => g === 'all' || d.g === g).map((d) => d.id);

  // ------------------------------------------------------------- storage ----
  const NS = 'uilsc:';
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(NS + k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(NS + k); } catch (e) { /* ignore */ } },
  };

  // ------------------------------------------------------------- helpers ----
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // Unbiased random integer in [0, n) using the browser's crypto RNG.
  function randInt(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % n;
  }
  // Fisher–Yates shuffle.
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---------------------------------------------------------- word decks ----
  // Each grade has a shuffled "deck". Tests deal words off the top, so every word
  // in the division is used once before any word repeats. When the deck runs
  // out it is reshuffled and a new cycle begins.
  function validDeck(deck, pool) {
    if (!deck || !Array.isArray(deck.order) || deck.order.length !== pool.length || typeof deck.pos !== 'number') return false;
    const s = new Set(deck.order);
    return s.size === pool.length && pool.every((id) => s.has(id));
  }
  function getDeck(name, g) {
    const pool = POOL[g];
    let deck = store.get('deck:' + name + ':' + g);
    if (!validDeck(deck, pool)) deck = { order: shuffle(pool.slice()), pos: 0, cycle: 1 };
    return deck;
  }
  function deal(name, g, n) {
    const pool = POOL[g];
    let deck = getDeck(name, g);
    n = Math.min(n, pool.length);
    const out = []; const taken = new Set();
    while (out.length < n) {
      if (deck.pos >= deck.order.length) {
        const fresh = shuffle(pool.slice());
        // never repeat a word inside the same set
        deck = { order: fresh.filter((id) => !taken.has(id)).concat(fresh.filter((id) => taken.has(id))), pos: 0, cycle: deck.cycle + 1 };
      }
      const id = deck.order[deck.pos++];
      if (!taken.has(id)) { taken.add(id); out.push(id); }
    }
    store.set('deck:' + name + ':' + g, deck);
    return out;
  }

  // --------------------------------------------------------- missed bank ----
  const missed = {
    all() { return store.get('missed', {}); },
    save(m) { store.set('missed', m); updateBadges(); },
    record(id, ok) {
      const m = this.all();
      if (ok) delete m[id];
      else m[id] = { n: ((m[id] && m[id].n) || 0) + 1, t: Date.now() };
      this.save(m);
    },
    ids(g) { return Object.keys(this.all()).filter((id) => BY_ID.has(id) && (g === 'all' || BY_ID.get(id).g === g)); },
  };

  // -------------------------------------------------------------- grading ---
  // Matches UIL rules: capitalization, hyphens and apostrophes must be right.
  // Either listed variant is accepted. Curly vs straight apostrophes and accent
  // marks (é, è) are treated as equal because they're hard to type.
  function norm(s) {
    return String(s).normalize('NFC')
      .replace(/[‘’ʼ`´]/g, "'")
      .replace(/[‐-―−]/g, '-')
      .replace(/\s+/g, ' ').trim();
  }
  const noAccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  function gradeAnswer(input, d) {
    const a = norm(input || '');
    if (!a) return { ok: false, why: 'Left blank — counts as a miss' };
    for (const v of d.w) if (noAccent(a) === noAccent(v)) return { ok: true };
    for (const v of d.w) {
      if (noAccent(a).toLowerCase() === noAccent(v).toLowerCase()) return { ok: false, why: 'Capitalization counts' };
      const bare = (x) => noAccent(x).toLowerCase().replace(/[-' ]/g, '');
      if (bare(a) === bare(v)) return { ok: false, why: 'Check the hyphen, apostrophe or spacing' };
    }
    return { ok: false, why: '' };
  }

  // --------------------------------------------------------------- speech ---
  const synth = window.speechSynthesis || null;
  let voices = [];
  let speakToken = 0;
  let speakingNow = false;
  let audioEl = null;
  const settings = Object.assign({ voice: '', rate: 0.9, grade: '34', count: '25', custom: 40, timer: 30, mode: 'practice', tb: false }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  function voiceScore(v) {
    let s = 0;
    if (/^en[-_]US/i.test(v.lang)) s += 30; else if (/^en/i.test(v.lang)) s += 15; else return -1;
    if (/natural|neural|online/i.test(v.name)) s += 25;
    if (/google us english/i.test(v.name)) s += 20;
    if (/samantha|aria|jenny|ava|allison|guy|zira/i.test(v.name)) s += 12;
    if (v.localService === false) s += 2;
    return s;
  }
  function loadVoices() {
    if (!synth) { $('#voiceSel').innerHTML = '<option>Not supported</option>'; $('#voiceWarn').hidden = false; return; }
    voices = synth.getVoices().filter((v) => /^en/i.test(v.lang)).sort((a, b) => voiceScore(b) - voiceScore(a));
    const sel = $('#voiceSel');
    if (!voices.length) { sel.innerHTML = '<option value="">Default voice</option>'; return; }
    sel.innerHTML = voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    if (settings.voice && voices.some((v) => v.name === settings.voice)) sel.value = settings.voice;
    else { sel.value = voices[0].name; }
    $('#voiceWarn').hidden = true;
  }
  function currentVoice() {
    const name = $('#voiceSel').value;
    return voices.find((v) => v.name === name) || voices[0] || null;
  }
  function setSpeaking(on) {
    speakingNow = on;
    $('#speaking').classList.toggle('on', on);
  }
  function stopSpeech() {
    speakToken++;
    if (synth) synth.cancel();
    if (audioEl) { audioEl.pause(); audioEl = null; }
    setSpeaking(false);
  }
  // Speak a list of phrases with short pauses between them. Resolves when done
  // (or after a safety timeout, in case the browser never fires "end").
  async function speak(parts, rateMul = 1) {
    stopSpeech();
    const token = speakToken;
    if (!synth) return;
    setSpeaking(true);
    for (const p of [].concat(parts)) {
      if (token !== speakToken) return;
      if (p && typeof p === 'object' && p.pause) { await sleep(p.pause); continue; }
      if (!p) continue;
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(p);
        const v = currentVoice();
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
        u.rate = Math.max(0.4, settings.rate * rateMul);
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(safety); resolve(); } };
        const safety = setTimeout(finish, 2500 + p.length * 110 / u.rate);
        u.onend = finish; u.onerror = finish;
        synth.speak(u);
      });
      if (token !== speakToken) return;
      await sleep(250);
    }
    if (token === speakToken) setSpeaking(false);
  }
  function playRecording(url) {
    stopSpeech();
    const token = speakToken;
    return new Promise((resolve) => {
      audioEl = new Audio(url);
      setSpeaking(true);
      const end = () => { if (token === speakToken) setSpeaking(false); resolve(); };
      audioEl.onended = end; audioEl.onerror = () => { end(); toast('Recording not available — using the voice instead.'); };
      audioEl.play().catch(() => end());
    });
  }

  // What the pronouncer says. Clarifiers from the list (e.g. "hare (rabbit)")
  // are always read so homonyms can't be confused, exactly as the rules require.
  const clar = (d) => (d.c ? d.c : '');
  const script = {
    intro(d, k, mode) {
      const parts = [`Number ${k}.`, { pause: 250 }, d.s + '.'];
      if (d.c) parts.push(d.c + '.');
      if (mode === 'contest') {
        parts.push({ pause: 300 }, d.x ? d.x : (d.def ? `It means: ${d.def}` : ''));
      }
      parts.push({ pause: 300 }, d.s + '.');
      return parts;
    },
    repeat: (d) => [d.s + '.', clar(d) ? clar(d) + '.' : '', { pause: 400 }, d.s + '.'],
    sentence: (d) => [d.s + '.', { pause: 300 }, d.x || (d.def ? `It means: ${d.def}` : `Please spell ${d.s}.`), { pause: 300 }, d.s + '.'],
    def: (d) => [d.s + '.', { pause: 250 }, d.p ? d.p + '.' : '', d.def ? d.def : 'Sorry, no meaning is available for this word.', { pause: 300 }, d.s + '.'],
  };

  // ---------------------------------------------------------------- views ---
  let current = 'home';
  function show(view) {
    if (current === 'test' && view !== 'test' && test && !test.done) {
      if (!confirm('Leave the test? Your progress is saved and you can resume it later.')) return;
      leaveTest();
    }
    current = view;
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
    $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
    if (view === 'home') renderHome();
    if (view === 'missed') renderMissed();
    if (view === 'history') renderHistory();
    if (view === 'pdf') renderPdf();
    window.scrollTo(0, 0);
  }
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => show(b.dataset.nav)));

  function updateBadges() {
    const n = Object.keys(missed.all()).length;
    $('#navMissed').textContent = n;
    $('#missedCount').textContent = n;
    $('#practiceMissedBtn').disabled = n === 0;
  }

  // ----------------------------------------------------------------- home ---
  function selectedCount() {
    if (settings.count === 'contest') return CONTEST[settings.grade][0];
    if (settings.count === 'custom') return Math.max(1, Math.min(POOL[settings.grade].length, parseInt($('#customCount').value, 10) || 1));
    return parseInt(settings.count, 10);
  }
  function renderSetup() {
    $('#gradeSel').value = settings.grade;
    $('#timerSel').value = String(settings.timer);
    $$('input[name=mode]').forEach((r) => { r.checked = r.value === settings.mode; });
    $('#tbChk').checked = !!settings.tb;
    $('#customCount').value = settings.custom;
    $('#customCount').max = POOL[settings.grade].length;
    $('#rateRange').value = settings.rate; $('#rateOut').textContent = settings.rate + '×';
    $('#contestChip').textContent = `Contest (${CONTEST[settings.grade][0]})`;
    $('#tbCount').textContent = CONTEST[settings.grade][1];
    $$('#countChips .chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.count === settings.count)));
    $$('#countChips .chip').forEach((c) => c.setAttribute('role', 'radio'));
    $('#customCount').hidden = settings.count !== 'custom';
    const deck = getDeck('main', settings.grade);
    $('#cycleNote').textContent = `${GRADE_NAME[settings.grade]}: ${deck.pos} of ${deck.order.length} words used in this round of the deck.`;
  }
  function renderCoverage() {
    $('#coverage').innerHTML = ['34', '56', '78'].map((g) => {
      const d = getDeck('main', g); const pct = Math.round((d.pos / d.order.length) * 100);
      return `<div class="cov"><div class="cov-top"><span>${GRADE_NAME[g]}${d.cycle > 1 ? ` · pass ${d.cycle}` : ''}</span><span>${d.pos} / ${d.order.length}</span></div>
        <div class="meter" role="progressbar" aria-label="${GRADE_NAME[g]} coverage" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div></div>`;
    }).join('');
  }
  function renderHome() {
    renderSetup(); renderCoverage(); updateBadges();
    const saved = store.get('current');
    $('#resumeBanner').hidden = !(saved && !saved.done && saved.items && saved.idx < saved.items.length);
  }
  $('#gradeSel').addEventListener('change', (e) => { settings.grade = e.target.value; saveSettings(); renderSetup(); });
  $('#timerSel').addEventListener('change', (e) => { settings.timer = parseInt(e.target.value, 10); saveSettings(); });
  $$('input[name=mode]').forEach((r) => r.addEventListener('change', () => { settings.mode = r.value; saveSettings(); }));
  $('#tbChk').addEventListener('change', (e) => { settings.tb = e.target.checked; saveSettings(); });
  $('#customCount').addEventListener('input', (e) => { settings.custom = parseInt(e.target.value, 10) || 1; saveSettings(); });
  $('#countChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    settings.count = c.dataset.count; saveSettings(); renderSetup();
    if (settings.count === 'custom') $('#customCount').focus();
  });
  $('#voiceSel').addEventListener('change', (e) => { settings.voice = e.target.value; saveSettings(); });
  $('#rateRange').addEventListener('input', (e) => { settings.rate = parseFloat(e.target.value); $('#rateOut').textContent = settings.rate + '×'; saveSettings(); });
  $('#testVoiceBtn').addEventListener('click', () => speak(['Hello! I will be your pronouncer today. Number one. Practice. Practice.']));

  $('#setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const g = settings.grade; const n = selectedCount();
    const ids = deal('main', g, n + (settings.tb ? CONTEST[g][1] : 0));
    const main = ids.slice(0, n); const tb = settings.tb ? ids.slice(n) : [];
    startTest({ grade: g, main, tb, source: 'deck' });
  });
  $('#practiceMissedBtn').addEventListener('click', () => startMissed('all'));
  $('#resumeBtn').addEventListener('click', () => { const s = store.get('current'); if (s) { test = s; enterTest(); } });
  $('#discardBtn').addEventListener('click', () => { store.del('current'); renderHome(); });

  function startMissed(g) {
    const ids = shuffle(missed.ids(g));
    if (!ids.length) { toast('No missed words here — nice work!'); return; }
    startTest({ grade: g, main: ids, tb: [], source: 'missed' });
  }

  // ----------------------------------------------------------------- test ---
  let test = null;
  let timerLeft = 0; let timerLast = 0; let timerHandle = null; let paused = false; let busy = false;

  function startTest({ grade, main, tb, source }) {
    test = {
      started: Date.now(), grade, source, mode: settings.mode, timer: settings.timer,
      items: main.map((id) => ({ id, r: 'test' })).concat(tb.map((id) => ({ id, r: 'tb' }))),
      idx: 0, done: false,
    };
    store.set('current', test);
    enterTest();
  }
  function enterTest() {
    current = 'test';
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-test'; });
    $$('.nav button').forEach((b) => b.classList.remove('active'));
    const contest = test.mode === 'contest';
    $('#helpers').hidden = contest;
    $('#contestNote').hidden = !contest;
    $('#timer').classList.toggle('off', !test.timer);
    paused = false; $('#pauseOverlay').hidden = true;
    startTimerLoop();
    presentWord(true);
  }
  function leaveTest() {
    stopSpeech(); stopTimerLoop();
    if (test && !test.done) store.set('current', test);
  }
  function item() { return test.items[test.idx]; }
  function word() { return BY_ID.get(item().id); }
  function numberInRound() {
    const it = item(); let k = 0;
    for (let i = 0; i <= test.idx; i++) if (test.items[i].r === it.r) k++;
    return k;
  }
  function roundTotal(r) { return test.items.filter((i) => i.r === r).length; }

  async function presentWord(first) {
    const it = item(); const d = word();
    const k = numberInRound();
    const total = roundTotal(it.r);
    $('#qNum').textContent = k; $('#qTotal').textContent = total;
    $('#testRound').textContent = it.r === 'tb' ? 'Tie breaker' : (test.source === 'missed' ? 'Missed-word practice' : GRADE_NAME[test.grade] + (test.mode === 'contest' ? ' · contest rules' : ''));
    $('#progressBar').style.width = (test.idx / test.items.length) * 100 + '%';
    $('#answer').value = '';
    $('#humanBtn').hidden = !d.a;
    timerLeft = test.timer; renderTimer();
    $('#testStatus').textContent = 'Listen…';
    $('#answer').focus({ preventScroll: true });
    const parts = [];
    if (it.r === 'tb' && k === 1) parts.push('This is the tie breaker.', { pause: 500 });
    if (first && test.idx === 0) parts.unshift({ pause: 400 });
    await speak(parts.concat(script.intro(d, k, test.mode)));
    if (test && !test.done && item() === it) $('#testStatus').textContent = 'Your turn — type the word.';
  }

  async function submitAnswer(timeUp) {
    if (busy || !test || test.done) return;
    busy = true;
    const it = item();
    it.a = $('#answer').value;
    if (timeUp) it.tu = true;
    test.idx++;
    store.set('current', test);
    stopSpeech();
    if (test.idx >= test.items.length) { busy = false; finishTest(); return; }
    $('#testStatus').textContent = timeUp ? "Time's up — next word." : 'Saved. Next word…';
    $('#answer').value = '';
    await sleep(timeUp ? 900 : 450);
    busy = false;
    if (test && !test.done && current === 'test' && !paused) presentWord(false);
  }
  $('#answerForm').addEventListener('submit', (e) => { e.preventDefault(); submitAnswer(false); });
  // Block drag/drop and pasting of text from elsewhere into the answer box.
  $('#answer').addEventListener('paste', (e) => e.preventDefault());
  $('#answer').addEventListener('drop', (e) => e.preventDefault());

  $('#repeatBtn').addEventListener('click', () => speak(script.repeat(word())));
  $('#sentenceBtn').addEventListener('click', () => speak(script.sentence(word())));
  $('#defBtn').addEventListener('click', () => speak(script.def(word())));
  $('#slowBtn').addEventListener('click', () => { const d = word(); speak([d.s + '.', { pause: 600 }, d.s + '.'], 0.6); });
  $('#humanBtn').addEventListener('click', () => { const d = word(); if (d.a) playRecording(d.a); });
  $$('#helpers button').forEach((b) => b.addEventListener('click', () => setTimeout(() => $('#answer').focus({ preventScroll: true }), 50)));

  function pauseTest() { paused = true; stopSpeech(); $('#pauseOverlay').hidden = false; $('#resumeTestBtn').focus(); }
  $('#pauseBtn').addEventListener('click', pauseTest);
  $('#resumeTestBtn').addEventListener('click', () => { paused = false; $('#pauseOverlay').hidden = true; $('#answer').focus(); timerLast = performance.now(); });
  $('#quitBtn').addEventListener('click', () => {
    if (!confirm('End the test now? Words you haven\'t reached won\'t be graded.')) return;
    test.items = test.items.slice(0, test.idx);
    if (!test.items.length) { test = null; store.del('current'); stopSpeech(); stopTimerLoop(); current = 'home'; show('home'); return; }
    finishTest();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && current === 'test' && test && !test.done && !paused) pauseTest(); });

  // timer: counts down only while the pronouncer is silent and not paused
  function startTimerLoop() {
    stopTimerLoop(); timerLast = performance.now();
    timerHandle = setInterval(() => {
      const now = performance.now(); const dt = (now - timerLast) / 1000; timerLast = now;
      if (!test || test.done || !test.timer || paused || speakingNow || busy) return;
      timerLeft -= dt;
      if (timerLeft <= 0) { timerLeft = 0; renderTimer(); submitAnswer(true); return; }
      renderTimer();
    }, 200);
  }
  function stopTimerLoop() { clearInterval(timerHandle); timerHandle = null; }
  function renderTimer() {
    if (!test || !test.timer) return;
    const secs = Math.ceil(timerLeft);
    $('#timerText').textContent = secs;
    $('#timerBar').style.strokeDashoffset = String(119.4 * (1 - timerLeft / test.timer));
    $('#timer').classList.toggle('low', secs <= 5);
    $('#timer').setAttribute('aria-label', secs + ' seconds left');
  }

  // -------------------------------------------------------------- results ---
  let lastResult = null;
  function finishTest() {
    stopSpeech(); stopTimerLoop();
    test.done = true;
    for (const it of test.items) {
      const g = gradeAnswer(it.a, BY_ID.get(it.id));
      it.ok = g.ok; it.why = g.why;
      missed.record(it.id, g.ok);
    }
    const main = test.items.filter((i) => i.r === 'test'); const tb = test.items.filter((i) => i.r === 'tb');
    const score = main.filter((i) => i.ok).length;
    const tbScore = tb.filter((i) => i.ok).length;
    const hist = store.get('history', []);
    hist.unshift({ t: Date.now(), g: test.grade, m: test.mode, src: test.source, s: score, n: main.length, ts: tbScore, tn: tb.length });
    store.set('history', hist.slice(0, 200));
    store.set('last', { g: test.grade, main: main.map((i) => i.id), tb: tb.map((i) => i.id) });
    store.del('current');
    lastResult = test; test = null;
    renderResults(lastResult, score, main.length, tbScore, tb.length);
  }
  function renderResults(t, score, total, tbScore, tbTotal) {
    current = 'results';
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-results'; });
    $('#resScore').textContent = score; $('#resTotal').textContent = total;
    const misses = total - score;
    const pct = total ? score / total : 0;
    $('#resMsg').textContent = misses === 0 ? 'Perfect paper! That would earn a Certificate of Achievement at district. 🏆'
      : pct >= 0.9 ? `Excellent! Only ${misses} ${misses === 1 ? 'miss' : 'misses'}.`
      : pct >= 0.7 ? `Good work — ${misses} words to review.` : `Keep going — ${misses} words added to your review list.`;
    $('#resTb').textContent = tbTotal ? `Tie breaker: ${tbScore} / ${tbTotal}` : '';
    const wrongCount = t.items.filter((i) => !i.ok).length;
    $('#resPracticeMissed').hidden = wrongCount === 0 || t.source === 'missed' && Object.keys(missed.all()).length === 0;
    $('#resPracticeMissed').textContent = t.source === 'missed' ? 'Practice remaining missed words' : `Practice the ${wrongCount} I missed`;
    $('#resList').innerHTML = t.items.map((it, i) => {
      const d = BY_ID.get(it.id);
      const answer = norm(it.a || '');
      const prev = i > 0 ? t.items[i - 1].r : null;
      const head = it.r === 'tb' && prev !== 'tb' ? '<li class="tag" style="border:0;display:block;padding:.25rem 0">Tie breaker</li>' : '';
      return head + `<li class="${it.ok ? 'ok' : 'no'}">
        <span class="mark" aria-label="${it.ok ? 'Correct' : 'Incorrect'}">${it.ok ? '✓' : '✗'}</span>
        <div>
          <div class="word">${esc(d.w.join(', '))}${d.n0 ? ` <span class="tag">(${esc(d.n0)})</span>` : ''}</div>
          ${it.ok ? '' : `<div class="yours">You wrote: ${answer ? `<s>${esc(answer)}</s>` : '<em>(blank)</em>'}${it.tu ? ' · <span class="tag">time ran out</span>' : ''}</div>${it.why ? `<div class="why">${esc(it.why)}</div>` : ''}`}
        </div>
        <button class="icon-btn" data-say="${esc(it.id)}" aria-label="Hear this word">🔊</button>
      </li>`;
    }).join('');
    $('#onlyWrong').checked = false; $('#resList').parentElement.classList.remove('only-wrong');
    updateBadges();
    window.scrollTo(0, 0);
    speak(misses === 0 ? ['Perfect score! Great job!'] : [`You spelled ${score} out of ${total} correctly.`]);
  }
  $('#resList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-say]'); if (!b) return;
    const d = BY_ID.get(b.dataset.say); speak([d.s + '.', d.x || '']);
  });
  $('#onlyWrong').addEventListener('change', (e) => $('#resList').parentElement.classList.toggle('only-wrong', e.target.checked));
  $('#resPracticeMissed').addEventListener('click', () => {
    if (!lastResult) return;
    const ids = lastResult.source === 'missed' ? missed.ids(lastResult.grade) : lastResult.items.filter((i) => !i.ok).map((i) => i.id);
    if (!ids.length) { toast('Nothing left to practice!'); return; }
    startTest({ grade: lastResult.grade, main: shuffle(ids), tb: [], source: 'missed' });
  });
  $('#resAgain').addEventListener('click', () => show('home'));
  $('#resPdf').addEventListener('click', () => { show('pdf'); $('#pdfSource').value = 'last'; renderPdf(); });

  // --------------------------------------------------------------- missed ---
  function renderMissed() {
    const g = $('#missGrade').value;
    const ids = missed.ids(g); const all = missed.all();
    $('#missSummary').textContent = ids.length ? `${ids.length} word${ids.length === 1 ? '' : 's'} to review.` : 'Nothing to review here. 🎉';
    $('#missStart').disabled = !ids.length; $('#missPdf').disabled = !ids.length;
    const sorted = ids.slice().sort((a, b) => BY_ID.get(a).w[0].localeCompare(BY_ID.get(b).w[0]));
    $('#missList').innerHTML = sorted.map((id) => {
      const d = BY_ID.get(id);
      return `<li>${esc(d.w.join(', '))} <small>· ${GRADE_NAME[d.g].replace('Grades ', 'gr ')}${all[id].n > 1 ? ` · missed ${all[id].n}×` : ''}</small></li>`;
    }).join('');
  }
  $('#missGrade').addEventListener('change', renderMissed);
  $('#missStart').addEventListener('click', () => startMissed($('#missGrade').value));
  $('#missPdf').addEventListener('click', () => { show('pdf'); $('#pdfSource').value = 'missed'; $('#pdfGrade').value = $('#missGrade').value; renderPdf(); });
  $('#missClear').addEventListener('click', () => { if (confirm('Remove every word from the missed list?')) { missed.save({}); renderMissed(); } });

  // -------------------------------------------------------------- history ---
  function renderHistory() {
    const h = store.get('history', []);
    $('#histEmpty').hidden = h.length > 0;
    $('#histTable').hidden = h.length === 0;
    $('#histTable tbody').innerHTML = h.map((r) => `<tr>
      <td>${esc(new Date(r.t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</td>
      <td>${esc(GRADE_NAME[r.g] || r.g)}${r.src === 'missed' ? ' · missed words' : ''}</td>
      <td>${r.m === 'contest' ? 'Contest' : 'Practice'}</td>
      <td><strong>${r.s}/${r.n}</strong>${r.tn ? ` <span class="muted small">TB ${r.ts}/${r.tn}</span>` : ''}</td></tr>`).join('');
  }
  $('#resetAll').addEventListener('click', () => {
    if (!confirm('Erase all saved progress, missed words, history and decks on this device?')) return;
    try { Object.keys(localStorage).filter((k) => k.startsWith(NS)).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    location.reload();
  });

  // ------------------------------------------------------------------ PDF ---
  function renderPdf() {
    const src = $('#pdfSource').value;
    const last = store.get('last');
    $('#pdfCount').disabled = src !== 'new';
    $('#pdfTb').disabled = src !== 'new';
    $('#pdfGrade').disabled = src === 'last';
    if (src === 'new') {
      const g = $('#pdfGrade').value;
      $('#pdfNote').textContent = `Paper sets use their own shuffled deck, so printed tests also work through every ${GRADE_NAME[g]} word before repeating. Contest size: ${CONTEST[g][0]} words + ${CONTEST[g][1]} tie breaker.`;
    } else if (src === 'missed') {
      $('#pdfNote').textContent = `${missed.ids($('#pdfGrade').value).length} missed words will be printed.`;
    } else {
      $('#pdfNote').textContent = last ? `Last test: ${GRADE_NAME[last.g]}, ${last.main.length} words${last.tb.length ? ` + ${last.tb.length} tie breaker` : ''}.` : 'You haven\'t finished a test yet.';
    }
  }
  $('#pdfSource').addEventListener('change', renderPdf);
  $('#pdfGrade').addEventListener('change', () => {
    const g = $('#pdfGrade').value;
    if ($('#pdfSource').value === 'new') { $('#pdfCount').value = CONTEST[g][0]; $('#pdfTb').value = CONTEST[g][1]; }
    renderPdf();
  });
  $('#pdfForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!window.jspdf) { toast('PDF tool is still loading — try again in a second.'); return; }
    const src = $('#pdfSource').value; let g = $('#pdfGrade').value; let main = []; let tb = [];
    if (src === 'new') {
      const n = Math.max(1, Math.min(POOL[g].length, parseInt($('#pdfCount').value, 10) || 1));
      const t = Math.max(0, Math.min(100, parseInt($('#pdfTb').value, 10) || 0));
      const ids = deal('pdf', g, Math.min(POOL[g].length, n + t));
      main = ids.slice(0, n); tb = ids.slice(n);
    } else if (src === 'missed') {
      main = shuffle(missed.ids(g));
    } else {
      const last = store.get('last');
      if (!last) { toast('No finished test yet.'); return; }
      g = last.g; main = last.main; tb = last.tb;
    }
    if (!main.length) { toast('No words to print.'); return; }
    makePdf({ g, main, tb, defs: $('#pdfDefs').checked, sheet: $('#pdfSheet').checked, label: src === 'missed' ? 'Missed words' : GRADE_NAME[g] });
    renderPdf();
  });

  // jsPDF's built-in fonts only cover Latin-1, so tidy any other characters.
  const pdfText = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\xFF]/g, '');

  function makePdf({ g, main, tb, defs, sheet, label }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(); const H = doc.internal.pageSize.getHeight();
    const M = 54; let y = M;
    const date = new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    const footer = () => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
      doc.text(`UIL A+ Spelling practice · ${pdfText(label)} · ${date}`, M, H - 28);
      doc.text(`Page ${doc.internal.getNumberOfPages()}`, W - M, H - 28, { align: 'right' });
      doc.setTextColor(0);
    };
    const newPage = () => { footer(); doc.addPage(); y = M; };
    const need = (h) => { if (y + h > H - 50) newPage(); };

    // ---- pronouncer's list
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text("Pronouncer's List", M, y); y += 20;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90);
    doc.text(pdfText(`${label} · ${main.length} words${tb.length ? ` + ${tb.length} tie breaker` : ''} · ${date}`), M, y); y += 16;
    const howTo = 'Read each word, then a sentence (or meaning), then the word again, at about five words per minute. Always read the words in parentheses so look-alike words are clear. Students may not ask for repeats; after the last word you may re-pronounce any words that were unclear. A miss is any misspelling, wrong capitalization, misused hyphen or apostrophe, or a blank.';
    const lines = doc.splitTextToSize(howTo, W - 2 * M); doc.text(lines, M, y); y += lines.length * 12 + 18;
    doc.setTextColor(0);

    const list = (ids, title) => {
      if (title) { need(40); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(title, M, y); y += 20; }
      ids.forEach((id, i) => {
        const d = BY_ID.get(id);
        const head = `${i + 1}.`;
        const wordTxt = pdfText(d.w.join(', '));
        const extra = d.n0 ? `  (${pdfText(d.n0)})` : '';
        const sub = [];
        if (defs) {
          if (d.def) sub.push(pdfText(`${d.p ? d.p + ' - ' : ''}${d.def}`));
          if (d.x) sub.push(pdfText(`Sentence: ${d.x}`));
        }
        const subLines = sub.length ? doc.splitTextToSize(sub.join('\n'), W - 2 * M - 30) : [];
        need(18 + subLines.length * 11 + 6);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.text(head, M, y);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(wordTxt, M + 30, y);
        if (extra) { const wW = doc.getTextWidth(wordTxt); doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(90); doc.text(extra, M + 30 + wW, y); doc.setTextColor(0); }
        y += 13;
        if (subLines.length) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(80); doc.text(subLines, M + 30, y); y += subLines.length * 11; doc.setTextColor(0); }
        y += 2;
        doc.setDrawColor(230); doc.line(M, y, W - M, y);
        y += 15;
      });
    };
    list(main, null);
    if (tb.length) { y += 8; list(tb, 'Tie Breaker'); }

    // ---- answer sheet
    if (sheet) {
      const sheetPages = (count, title) => {
        newPage();
        const header = (cont) => {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
          doc.text('Contestant # ________', W - M, y, { align: 'right' });
          doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text(title + (cont ? ' (cont.)' : ''), M, y); y += 22;
          doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
          doc.text('Name ______________________________     Date ______________', M, y); y += 14;
          doc.setFontSize(9); doc.setTextColor(90);
          doc.text(pdfText(`${label} · ${count} words · Write each word as it is pronounced. Capital letters, hyphens and apostrophes count.`), M, y); y += 22;
          doc.setTextColor(0);
        };
        header(false);
        const rowH = 26; const colW = (W - 2 * M) / 2;
        let n = 1;
        while (n <= count) {
          const rows = Math.floor((H - 70 - y) / rowH);
          const startY = y;
          for (let c = 0; c < 2 && n <= count; c++) {
            for (let r = 0; r < rows && n <= count; r++, n++) {
              const yy = startY + r * rowH + 16; const x = M + c * colW;
              doc.setFontSize(11); doc.text(`${n}.`, x + 20, yy, { align: 'right' });
              doc.setDrawColor(170); doc.line(x + 26, yy + 2, x + colW - 16, yy + 2);
            }
          }
          if (n <= count) { newPage(); header(true); }
        }
        y = H - 80;
        doc.setFontSize(10); doc.text(`Misses: ______     Score: ______ / ${count}`, M, y);
      };
      sheetPages(main.length, 'Spelling Answer Sheet');
      if (tb.length) sheetPages(tb.length, 'Tie Breaker Answer Sheet');
    }
    footer();
    const fname = `UIL-spelling-${label.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '')}-${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(fname);
    toast('PDF downloaded.');
  }

  // ----------------------------------------------------------------- init ---
  if (synth) {
    loadVoices();
    synth.addEventListener ? synth.addEventListener('voiceschanged', loadVoices) : (synth.onvoiceschanged = loadVoices);
  } else loadVoices();
  // expose a tiny hook for automated tests (contains no answers)
  window.__uilsc = { pools: { '34': POOL['34'].length, '56': POOL['56'].length, '78': POOL['78'].length } };
  show('home');
})();
