// logic.js - pure weather logic for the kiosk page (no DOM, no network).
// Loaded as a plain <script> in the page (global LGF) and with require() in the Node tests.
(function (root) {
  'use strict';

  var LAT = 45.5017, LON = -73.5673;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var STARTUP_GRACE_MS = 60 * 1000;   // grey background before the no-network image
  var MAX_DATA_AGE_MS = 60 * 60 * 1000; // last good data shown at most this long

  // Same table as wmo_to_clip in weather/lgf-weather.
  function wmoToClip(code) {
    if (code === null || code === undefined || !/^\d+$/.test(String(code))) return 'unknown';
    var c = parseInt(code, 10);
    if (c === 0 || c === 1) return 'sun';
    if (c === 2 || c === 3) return 'cloud';
    if (c === 45 || c === 48) return 'fog';
    if ((c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
    if (c >= 95 && c <= 99) return 'storm';
    return 'unknown';
  }

  function forecastUrl() {
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON +
      '&current=apparent_temperature,weather_code&hourly=apparent_temperature,weather_code' +
      '&daily=apparent_temperature_max&timezone=America%2FToronto&past_days=1&forecast_days=1';
  }

  function roundOrNull(v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    var r = Math.round(v);
    return r === 0 ? 0 : r; // no -0
  }

  // "2026-12-12T08:15" (Montreal local time, as sent by the API) -> "Dec 12"
  function formatDate(isoLocal) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLocal || ''));
    if (!m) return null;
    var month = parseInt(m[2], 10), day = parseInt(m[3], 10);
    if (month < 1 || month > 12) return null;
    return MONTHS[month - 1] + ' ' + day;
  }

  // "2026-12-01T23:45" -> "2026-11-30T23:00" (same local hour, one day before; pure calendar arithmetic)
  function yesterdayHour(isoLocal) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(String(isoLocal || ''));
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - 1));
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + 'T' + m[4] + ':00';
  }

  // Index of today in the daily arrays: with past_days=1 the first entry is yesterday.
  function todayIndex(daily, isoLocal) {
    if (!daily) return -1;
    if (!Array.isArray(daily.time)) return 0;
    return daily.time.indexOf(String(isoLocal).slice(0, 10));
  }

  // Rain, snow or storm coming in the rest of today (hours after the current one), when it is not the weather now.
  // Storm beats snow beats rain. Fog, cloud and sun are not announced.
  var LATER_RANK = { rain: 1, snow: 2, storm: 3 };
  function laterToday(hourly, isoLocal, nowType) {
    if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.weather_code)) return null;
    var today = String(isoLocal).slice(0, 10), hourNow = String(isoLocal).slice(0, 13);
    var best = null;
    hourly.time.forEach(function (t, k) {
      t = String(t);
      if (t.slice(0, 10) !== today || t.slice(0, 13) <= hourNow) return;
      var type = wmoToClip(hourly.weather_code[k]);
      if (LATER_RANK[type] && (!best || LATER_RANK[type] > LATER_RANK[best])) best = type;
    });
    return best === nowType ? null : best;
  }

  function parseForecast(json) {
    if (!json || !json.current) return null;
    var cur = json.current, daily = json.daily;
    var date = formatDate(cur.time);
    if (date === null) return null;
    // The character shows the weather now (owner, 2026-11-27), like the feels-like number.
    var code = cur.weather_code;
    // Every temperature shown is a feels-like one (owner rule): no actual temperature, not even as a fallback.
    var feels = roundOrNull(cur.apparent_temperature);
    if (code === null || code === undefined || feels === null) return null;
    var i = todayIndex(daily, cur.time);
    var maxes = i >= 0 ? daily.apparent_temperature_max : null;
    var type = wmoToClip(code);

    var yFeelsRaw = null, h = json.hourly;
    if (h && Array.isArray(h.time) && Array.isArray(h.apparent_temperature)) {
      var j = h.time.indexOf(yesterdayHour(cur.time));
      if (j >= 0 && typeof h.apparent_temperature[j] === 'number') yFeelsRaw = h.apparent_temperature[j];
    }
    var delta = (yFeelsRaw !== null && typeof cur.apparent_temperature === 'number')
      ? roundOrNull(cur.apparent_temperature - yFeelsRaw) : null;

    return {
      type: type,
      later: laterToday(json.hourly, cur.time, type),
      feels: feels,
      max: roundOrNull(Array.isArray(maxes) ? maxes[i] : null),
      yesterdayFeels: roundOrNull(yFeelsRaw),
      deltaFeels: delta,
      date: date
    };
  }

  function formatTemp(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    var r = Math.round(n);
    return String(r === 0 ? 0 : r);
  }

  // change since yesterday: always signed ("+3°", "-3°"), "=" when equal, "" when missing
  function formatDelta(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    var r = Math.round(n);
    if (r === 0) return '=';
    return (r > 0 ? '+' : '') + r + '°';
  }

  // clips: file names like "rain-2.mp4" or "rain.mp4". Random variant of the type, else unknown, else null.
  function pickClip(type, clips, rand) {
    function ofType(t) {
      var re = new RegExp('^' + t + '(-[0-9]+)?\\.mp4$');
      return (clips || []).filter(function (f) { return re.test(f); });
    }
    var list = ofType(type);
    if (!list.length) list = ofType('unknown');
    if (!list.length) return null;
    var i = Math.min(list.length - 1, Math.floor((rand || Math.random)() * list.length));
    return list[i];
  }

  function screenState(s) {
    if (s.lastOkAt !== null && s.lastOkAt !== undefined && s.now - s.lastOkAt <= MAX_DATA_AGE_MS) return 'weather';
    if ((s.lastOkAt === null || s.lastOkAt === undefined) && s.now - s.startedAt < STARTUP_GRACE_MS) return 'waiting';
    return 'offline';
  }

  var api = {
    wmoToClip: wmoToClip, forecastUrl: forecastUrl, parseForecast: parseForecast, formatTemp: formatTemp, formatDelta: formatDelta,
    formatDate: formatDate, yesterdayHour: yesterdayHour, pickClip: pickClip, screenState: screenState,
    STARTUP_GRACE_MS: STARTUP_GRACE_MS, MAX_DATA_AGE_MS: MAX_DATA_AGE_MS
  };
  root.LGF = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
