/* Prayer times and the Hijri date, worked out on the TV from its place: nothing is fetched.
 * tv.properties: prayer=true, prayer_method (MWL, ISNA, Egypt, Makkah, Karachi, Moonsighting), asr (standard or hanafi) and
 * hijri_adjust (days, for a local moon sighting a day off Umm al-Qura's). */
var Islam = (function () {
  'use strict';

  // Fajr and Isha angles below the horizon; Makkah's Isha is 90 minutes after Maghrib.
  // Moonsighting (the Moonsighting Committee's, many UK mosques'): 18 degrees, kept within its seasonal limits.
  var METHODS = {MWL: [18, 17], ISNA: [15, 15], Egypt: [19.5, 17.5], Makkah: [18.5, 90], Karachi: [18, 18], Moonsighting: [18, 18]};
  var RAD = Math.PI / 180;
  var MONTHS = ['Muharram', 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani", 'Jumada al-Ula', 'Jumada al-Akhirah',
    'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qa'dah", 'Dhu al-Hijjah'];

  function sin(d) { return Math.sin(d * RAD); }
  function cos(d) { return Math.cos(d * RAD); }
  function fix(a, b) { a = a - b * Math.floor(a / b); return a < 0 ? a + b : a; }

  /** The sun's declination (degrees) and the equation of time (hours) at a Julian date. */
  function sun(jd) {
    var d = jd - 2451545.0, g = fix(357.529 + 0.98560028 * d, 360), q = fix(280.459 + 0.98564736 * d, 360);
    var l = fix(q + 1.915 * sin(g) + 0.020 * sin(2 * g), 360), e = 23.439 - 0.00000036 * d;
    var ra = fix(Math.atan2(cos(e) * sin(l), cos(l)) / RAD / 15, 24);
    return {decl: Math.asin(sin(e) * sin(l)) / RAD, eqt: q / 15 - ra};
  }

  /** Hours from noon until the sun is `angle` degrees below the horizon (NaN where it never gets there). */
  function hoursFromNoon(angle, lat, decl) {
    return Math.acos((-sin(angle) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl))) / RAD / 15;
  }

  /** Minutes from sunrise back to Fajr (abcd for the morning) or from sunset on to Isha, by the days since the
   * winter solstice: the Moonsighting Committee's seasonal curve (Khalid Shaukat). */
  function seasonal(lat, days, abcd) {
    var k = Math.abs(lat) / 55, a = 75 + abcd[0] * k, b = 75 + abcd[1] * k, c = 75 + abcd[2] * k, d = 75 + abcd[3] * k;
    return days < 91 ? a + (b - a) / 91 * days : days < 137 ? b + (c - b) / 46 * (days - 91)
      : days < 183 ? c + (d - c) / 46 * (days - 137) : days < 229 ? d + (c - d) / 46 * (days - 183)
      : days < 275 ? c + (b - c) / 46 * (days - 229) : b + (a - b) / 91 * (days - 275);
  }

  /** The day's times (ms) for the local date of `day`: fajr, sunrise, dhuhr, asr, maghrib, isha. */
  function times(day, lat, lon) {
    var c = CONFIG.islam || {}, m = METHODS[c.method] || METHODS.MWL;
    var y = day.getFullYear(), mo = day.getMonth(), dd = day.getDate();
    var base = Date.UTC(y, mo, dd), jd = base / 86400000 + 2440587.5;
    var s = sun(jd + 0.5 - lon / 360), noon = 12 - lon / 15 - s.eqt;
    var rise = hoursFromNoon(0.833, lat, s.decl), shadow = c.asr === 'hanafi' ? 2 : 1;
    var asrAngle = -Math.atan(1 / (shadow + Math.tan(Math.abs(lat - s.decl) * RAD))) / RAD;
    var t = {sunrise: noon - rise, dhuhr: noon, asr: noon + hoursFromNoon(asrAngle, lat, s.decl), maghrib: noon + rise};
    t.fajr = noon - hoursFromNoon(m[0], lat, s.decl);
    t.isha = m[1] > 30 ? t.maghrib + m[1] / 60 : noon + hoursFromNoon(m[1], lat, s.decl);
    // High latitudes (Wirral's summer): where the sun never gets that low, or the time comes too late, the angle
    // takes its share of the night (angle / 60), from sunset to sunrise.
    var night = 24 - (t.maghrib - t.sunrise);
    if (c.method === 'Moonsighting') {
      var leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0), length = leap ? 366 : 365;
      var doy = Math.round((base - Date.UTC(y, 0, 1)) / 86400000) + 1;
      var days = lat >= 0 ? (doy + 10) % length : (doy - (leap ? 173 : 172) + length) % length;
      var dawn = t.sunrise - seasonal(lat, days, [28.65, 19.44, 32.74, 48.10]) / 60;
      var dusk = t.maghrib + seasonal(lat, days, [25.60, 2.050, -9.21, 6.14]) / 60;
      if (isNaN(t.fajr) || t.fajr < dawn) t.fajr = dawn;
      if (isNaN(t.isha) || t.isha > dusk) t.isha = dusk;
      t.dhuhr += 5 / 60;     // its margins: Zuhr 5 minutes after noon, Maghrib 3 after sunset
      t.maghrib += 3 / 60;
    } else {
      var early = t.sunrise - m[0] / 60 * night;
      if (isNaN(t.fajr) || t.fajr < early) t.fajr = early;
      if (m[1] <= 30) {
        var late = t.maghrib + m[1] / 60 * night;
        if (isNaN(t.isha) || t.isha > late) t.isha = late;
      }
    }
    var out = {};
    for (var k in t) if (t.hasOwnProperty(k)) out[k] = base + Math.round(t[k] * 60) * 60000;
    return out;
  }

  var hijriNumeric = null, hijriFormat = null, hijriLocale = '';
  try {
    var f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC'});
    if (/islamic/.test(f.resolvedOptions().calendar)) hijriNumeric = f;
  } catch (e) { /* No Intl (Tizen 2.4) or no Islamic calendar: the arithmetic one below. */ }

  /** The month's name in the language in use (made again when it changes). */
  function hijriText(at) {
    if (hijriLocale !== I18N.locale()) {
      hijriLocale = I18N.locale();
      hijriFormat = new Intl.DateTimeFormat(hijriLocale + '-u-ca-islamic-umalqura', {day: 'numeric', month: 'long', timeZone: 'UTC'});
    }
    return hijriFormat.format(at).replace(/\s*(AH|هـ)$/, '');
  }

  function ymd(day) {
    var m = day.getMonth() + 1, d = day.getDate();
    return day.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }

  /** The mosque's published day (Data.salah) when it is `day`'s, else null. */
  function mosque(day) {
    var s = typeof Data !== 'undefined' && Data.salah;
    return s && s.times && s.day === ymd(day) ? s : null;
  }

  /** The Hijri date of the local day `day`: {day, month (1-12), year, text}; the text is the mosque's when it has one. */
  function hijri(day) {
    var h = calendarHijri(day), s = mosque(day);
    if (s && s.hijri) h.text = s.hijri.replace(/,?\s*\d{4}\s*$/, '');
    return h;
  }

  function calendarHijri(day) {
    var adjust = ((CONFIG.islam || {}).hijriAdjust | 0) * 86400000;
    var at = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 12) + adjust);
    if (hijriNumeric) {
      var p = hijriNumeric.format(at).match(/(\d+)\D+(\d+)\D+(\d+)/);
      if (p) return {month: +p[1], day: +p[2], year: +p[3], text: hijriText(at)};
    }
    // The tabular (Kuwaiti) calendar: a day off a sighting now and then, which hijri_adjust can take back.
    var jd = Math.floor(at.getTime() / 86400000 + 2440587.5) + 1, z = jd - 1948440 + 10632;
    var n = Math.floor((z - 1) / 10631); z = z - 10631 * n + 354;
    var j = Math.floor((10985 - z) / 5316) * Math.floor(50 * z / 17719) + Math.floor(z / 5670) * Math.floor(43 * z / 15238);
    z = z - Math.floor((30 - j) / 15) * Math.floor(17719 * j / 50) - Math.floor(j / 16) * Math.floor(15238 * j / 43) + 29;
    var month = Math.floor(24 * z / 709), d = z - Math.floor(709 * month / 24), year = 30 * n + j - 30;
    return {month: month, day: d, year: year, text: d + ' ' + MONTHS[month - 1]};
  }

  function names() {
    return {fajr: tr('Fajr'), sunrise: tr('Sunrise'), dhuhr: tr('Dhuhr'), asr: tr('Asr'), maghrib: tr('Maghrib'), isha: tr('Isha')};
  }
  var ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

  /** `day`'s times as {key: {adhan, iqamah}}: the mosque's when it published that day, else worked out here. */
  function dayTimes(day, lat, lon) {
    var s = mosque(day), out = {}, k;
    if (s) {
      for (k in s.times) if (s.times.hasOwnProperty(k)) out[k] = {adhan: s.times[k].adhan, iqamah: s.times[k].iqamah || 0};
      var j = /^(\d\d):(\d\d)$/.exec(s.jumuah || '');
      if (j && day.getDay() === 5) {
        var at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), +j[1], +j[2]).getTime();
        out.dhuhr = {adhan: at, iqamah: at};
      }
      return out;
    }
    var t = times(day, lat, lon);
    for (k in t) if (t.hasOwnProperty(k)) out[k] = {adhan: t[k], iqamah: 0};
    return out;
  }

  /** The next prayer from now: {key, name, at (adhan), iqamah (0 if none)}, kept until its jamaat when the mosque has one.
   * In Ramadan Fajr is Suhoor's end and Maghrib Iftar; Friday's Dhuhr is Jumu'ah. */
  function next(now, lat, lon) {
    var day = new Date(now), name = names();
    for (var i = 0; i < 2; i++) {
      var t = dayTimes(day, lat, lon), ramadan = hijri(day).month === 9;
      for (var k = 0; k < ORDER.length; k++) {
        var key = ORDER[k];
        if (!t[key] || Math.max(t[key].adhan, t[key].iqamah) <= now) continue;
        var label = name[key];
        if (ramadan && key === 'fajr') label = tr('Suhoor');
        else if (ramadan && key === 'maghrib') label = tr('Iftar');
        else if (key === 'dhuhr' && day.getDay() === 5) label = tr("Jumu'ah");
        return {key: key, name: label, at: t[key].adhan, iqamah: t[key].iqamah !== t[key].adhan ? t[key].iqamah : 0};
      }
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    }
    return null;
  }

  /** "Eid Mubarak, …" on the Eids, "Ramadan Mubarak, …" in Ramadan, "Jumu'ah Mubarak, …" on Friday mornings; else null. */
  function greeting(names, now) {
    var d = new Date(now), h = hijri(d);
    if ((h.month === 10 && h.day <= 3) || (h.month === 12 && h.day >= 10 && h.day <= 13)) return trf('Eid Mubarak, {names}', {names: names});
    if (h.month === 9) return trf('Ramadan Mubarak, {names}', {names: names});
    if (d.getDay() === 5 && d.getHours() >= 5 && d.getHours() < 12) return trf("Jumu'ah Mubarak, {names}", {names: names});
    return null;
  }

  return {on: function () { return !!(CONFIG.islam && CONFIG.islam.prayer); }, times: times, hijri: hijri, next: next, greeting: greeting};
})();
