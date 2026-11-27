// app.js - wires the weather logic (logic.js) to the page.
// Test hooks in the URL (for the Mac only; the unit opens the page without them):
//   ?fake=ok|offline|slow   fixed data / always fail / succeed after 20 s
//   ?type=rain              force the weather type
//   ?feels=-35&max=-20&yday=-30   override the feels-like values (with fake=ok; empty = missing)
//   ?fast=1                 all timers divided by 60
//   ?debug=1                status line at the bottom left
(function () {
  'use strict';
  var L = window.LGF;
  var q = new URLSearchParams(location.search);
  var SPEED = q.get('fast') ? 60 : 1;
  var REFRESH_MS = 15 * 60 * 1000 / SPEED;
  var RETRY_START_MS = 10 * 1000 / SPEED;
  var RETRY_MS = 60 * 1000 / SPEED;
  var FETCH_TIMEOUT_MS = 15 * 1000;
  var STALE_ON_RETURN_MS = 5 * 60 * 1000 / SPEED;
  var GRACE_MS = L.STARTUP_GRACE_MS / SPEED;
  var MAX_AGE_MS = L.MAX_DATA_AGE_MS / SPEED;

  var clips = window.LGF_CLIPS || [];
  var videos = [document.getElementById('v0'), document.getElementById('v1')];
  var active = 0;               // index of the video on screen
  var shownType = null;         // weather type of the clip on screen (or loading for the first time)
  var pendingType = null;       // type waiting for the end of the current loop
  var data = null, lastOkAt = null, startedAt = Date.now(), lastError = '';
  var fetchTimer = null;

  if (q.get('debug')) {
    document.body.classList.add('debug');
    // console helper for tests: lgfForceType('rain') as if the forecast changed
    window.lgfForceType = function (t) { if (data) { data.type = t; render(); } };
  }

  // ------------------------------------------------------------------ data
  function fakeJson() {
    function num(name, dflt) { var v = q.get(name); return v === null ? dflt : (v === '' ? null : Number(v)); }
    var time = [], feels = [], days = ['2026-12-11', '2026-12-12'];
    days.forEach(function (d) { for (var h = 0; h < 24; h++) { time.push(d + 'T' + (h < 10 ? '0' : '') + h + ':00'); feels.push(-20); } });
    feels[time.indexOf('2026-12-11T08:00')] = num('yday', -6.1);
    return {
      current: { time: '2026-12-12T08:15', apparent_temperature: num('feels', -9.2) },
      hourly: { time: time, apparent_temperature: feels },
      daily: { time: days, weather_code: [61, 3], apparent_temperature_max: [0.4, num('max', -1.6)] }
    };
  }

  function getJson() {
    var fake = q.get('fake');
    if (fake === 'ok') return Promise.resolve(fakeJson());
    if (fake === 'offline') return Promise.reject(new Error('fake offline'));
    if (fake === 'slow') {
      return Date.now() - startedAt >= 20000 / SPEED ? Promise.resolve(fakeJson()) : Promise.reject(new Error('fake slow'));
    }
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(L.forecastUrl(), { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }

  function schedule(ms) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(refresh, ms);
  }

  function refresh() {
    getJson().then(function (j) {
      var d = L.parseForecast(j);
      if (!d) throw new Error('bad answer');
      if (q.get('type')) d.type = q.get('type');
      data = d; lastOkAt = Date.now(); lastError = '';
      schedule(REFRESH_MS);
    }).catch(function (e) {
      lastError = String(e && e.message || e);
      schedule(lastOkAt === null && Date.now() - startedAt < GRACE_MS ? RETRY_START_MS : RETRY_MS);
    }).then(render);
  }

  // ------------------------------------------------------------------ clips
  function load(video, type) {
    var file = L.pickClip(type, clips, Math.random);
    if (!file) { video.removeAttribute('src'); video.dataset.file = ''; return false; }
    if (video.dataset.file !== file) {
      // still of the clip, shown while it loads and when the phone blocks autoplay (iPhone Low Power Mode)
      video.poster = 'clips/' + file.replace(/\.mp4$/, '.jpg');
      video.src = 'clips/' + file;
      video.dataset.file = file;
    }
    return true;
  }

  function play(video) {
    var p = video.play();
    if (p && p.catch) p.catch(function () { setTimeout(function () { if (!video.paused) return; play(video); }, 1000); });
  }

  // First clip, or coming back from offline: start at once.
  function startType(type) {
    var v = videos[active];
    pendingType = null;
    shownType = type;
    v.loop = true;
    if (!load(v, type)) { v.classList.remove('shown'); return; }
    v.currentTime = 0;
    play(v);
    v.classList.add('shown');
  }

  // Another weather type while a clip plays: let the current loop finish, then swap.
  function queueType(type) {
    if (type === pendingType) return;
    var next = videos[1 - active];
    if (!load(next, type)) { pendingType = null; return; } // nothing to show for it: keep the current clip
    pendingType = type;
    next.loop = true;
    next.currentTime = 0;
    videos[active].loop = false; // the 'ended' event below does the swap
  }

  videos.forEach(function (v, i) {
    v.addEventListener('ended', function () {
      if (i !== active) return;
      if (pendingType === null) { v.currentTime = 0; play(v); return; }
      var next = videos[1 - active];
      // new clip fades in on top; the old one stays opaque underneath, then goes
      play(next);
      next.style.zIndex = 2; v.style.zIndex = 1;
      next.classList.add('shown');
      active = 1 - active;
      shownType = pendingType;
      pendingType = null;
      setTimeout(function () { if (videos[active] !== v) { v.classList.remove('shown'); v.pause(); } }, 700);
    });
  });

  function stopClips() {
    videos.forEach(function (v) { v.pause(); v.classList.remove('shown'); });
    shownType = null; pendingType = null;
  }

  // ------------------------------------------------------------------ screen
  function setText(id, t) { document.getElementById(id).textContent = t; }

  function showData(d) {
    setText('main-num', L.formatTemp(d.feels));        // all temperatures are feels-like
    document.getElementById('max').hidden = d.max === null;
    setText('max-num', L.formatTemp(d.max) + '°');
    document.getElementById('yday').hidden = d.deltaFeels === null;
    setText('yday-num', L.formatDelta(d.deltaFeels));   // signed: +3°, -3°, =
  }

  function render() {
    var now = Date.now();
    var state = L.screenState({ now: now, startedAt: startedAt, lastOkAt: lastOkAt });
    // screenState uses the real 60 s / 60 min; with ?fast=1 apply the scaled limits here
    if (SPEED !== 1) {
      if (lastOkAt !== null && now - lastOkAt <= MAX_AGE_MS) state = 'weather';
      else if (lastOkAt === null && now - startedAt < GRACE_MS) state = 'waiting';
      else state = 'offline';
    }
    document.body.className = document.body.className.replace(/\bstate-\w+/g, '').trim() + ' state-' + state;

    if (state === 'weather') {
      showData(data);
      if (shownType === null) startType(data.type);
      else if (data.type !== shownType) queueType(data.type);
      else if (pendingType !== null) { pendingType = null; videos[active].loop = true; } // back to the type on screen
    } else {
      stopClips();
    }

    document.getElementById('debug').textContent =
      'state=' + state + ' type=' + (data ? data.type : '-') + ' clip=' + (videos[active].dataset.file || '-') +
      (pendingType ? ' next=' + pendingType : '') + ' age=' + (lastOkAt ? Math.round((now - lastOkAt) / 1000) + 's' : '-') +
      (lastError ? ' err=' + lastError : '');
  }

  // Phones block autoplay in some modes: a tap starts the clip on screen.
  document.addEventListener('pointerdown', function () {
    var v = videos[active];
    if (v.classList.contains('shown') && v.paused) play(v);
  });

  // Back on the page after the phone was locked or the tab hidden: timers were paused, so refresh old data now.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (lastOkAt === null || Date.now() - lastOkAt > STALE_ON_RETURN_MS) refresh();
    var v = videos[active];
    if (v.classList.contains('shown') && v.paused) play(v);
  });

  setInterval(render, 1000);
  render();
  document.fonts.ready.then(refresh);
})();
