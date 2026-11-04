/* The home screen's sky (CONFIG.livingSky): the real sun's height over your city sets the colours, the forecast's weather
 * code the cloud, rain and snow. Built once; after that only a gradient changes, once a minute, and only transform and
 * opacity move. */
var Sky = (function () {
  'use strict';

  var RAD = Math.PI / 180;

  /** The sun's height in degrees, and whether it's rising (NOAA's low-precision formulas). */
  function sun(at, lat, lon) {
    var d = at / 86400000 + 2440587.5 - 2451545, g = (357.529 + 0.98560028 * d) * RAD, q = 280.459 + 0.98564736 * d;
    var l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, e = (23.439 - 0.00000036 * d) * RAD;
    var ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l)), dec = Math.asin(Math.sin(e) * Math.sin(l));
    var hour = ((18.697374558 + 24.06570982441908 * d) * 15 + lon) * RAD - ra;
    var alt = Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(hour));
    return {alt: alt / RAD, rising: Math.sin(hour) < 0};
  }

  // The sun's height, then the sky's top, middle and bottom; the last two rows' horizon is warmer at dusk than at dawn.
  var NIGHT = [[-18, [5, 7, 15], [10, 15, 31], [17, 22, 43]], [-8, [11, 19, 48], [28, 36, 80], [74, 53, 96]]];
  var DAY = [[10, [111, 169, 224], [169, 208, 238], [244, 227, 194]], [30, [95, 165, 232], [165, 211, 245], [230, 243, 251]]];
  var DAWN = [[-2, [22, 32, 74], [74, 63, 120], [194, 96, 122]], [3, [79, 122, 184], [232, 168, 120], [255, 195, 110]]];
  var DUSK = [[-2, [22, 32, 74], [92, 60, 110], [217, 112, 63]], [3, [79, 122, 184], [240, 160, 100], [255, 176, 84]]];

  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  function colours(alt, rising) {
    var rows = NIGHT.concat(rising ? DAWN : DUSK, DAY), i = 0;
    if (alt <= rows[0][0]) return rows[0].slice(1);
    if (alt >= rows[rows.length - 1][0]) return rows[rows.length - 1].slice(1);
    while (alt > rows[i + 1][0]) i++;
    var t = (alt - rows[i][0]) / (rows[i + 1][0] - rows[i][0]);
    return [mix(rows[i][1], rows[i + 1][1], t), mix(rows[i][2], rows[i + 1][2], t), mix(rows[i][3], rows[i + 1][3], t)];
  }

  /** How much cloud a weather code means (WMO codes, as Open-Meteo gives them), and what falls. */
  function weather(code) {
    var rain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
    var snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    return {cover: rain || snow ? 0.75 : code === 45 || code === 48 ? 0.9 : code === 3 ? 0.8 : code === 2 ? 0.35 : code === 1 ? 0.15 : 0,
      fall: rain ? 'rain' : snow ? 'snow' : ''};
  }

  function rgba(c, a) { return 'rgba(' + Math.round(c[0]) + ', ' + Math.round(c[1]) + ', ' + Math.round(c[2]) + ', ' + a + ')'; }

  var live, stars, fall, falling = '';

  function canvasFor(width, height, paint) {
    var c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    paint(c.getContext('2d'));
    return c;
  }

  /** Stars in two layers that fade in turn, so they twinkle; a fixed sequence, so they stay put between days. */
  function starLayer(seed, parent) {
    var r = seed;
    function next() { r = (r * 16807) % 2147483647; return r / 2147483647; }
    var c = canvasFor(1920, 760, function (ctx) {
      for (var i = 0; i < 90; i++) {
        var y = next() * 760, size = 0.7 + next() * 1.3;
        ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.35 + next() * 0.65) * (1 - y / 900) + ')';
        ctx.beginPath();
        ctx.arc(next() * 1920, y, size, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    parent.appendChild(c);
  }

  /** A tile of rain or snow that repeats, so what falls is one layer sliding down by a tile. */
  function tile(kind, night) {
    return canvasFor(960, 960, function (ctx) {
      var r = 7;
      function next() { r = (r * 16807) % 2147483647; return r / 2147483647; }
      ctx.lineCap = 'round';
      for (var i = 0; i < (kind === 'rain' ? 120 : 70); i++) {
        var x = next() * 960, y = next() * 960, n = next();
        if (kind === 'rain') {
          ctx.strokeStyle = night ? 'rgba(205, 220, 245, ' + (0.4 + n * 0.45) + ')' : 'rgba(45, 70, 105, ' + (0.4 + n * 0.45) + ')';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 5, y + 26 + n * 22);
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.45 + n * 0.5) + ')';
          ctx.beginPath();
          ctx.arc(x, y, 1.6 + n * 3, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    }).toDataURL();
  }

  function layer(cls, parent) {
    var d = document.createElement('div');
    d.className = cls;
    parent.insertBefore(d, parent === fall ? null : parent.querySelector('.lift'));
    return d;
  }

  function init(sky) {
    live = layer('live', sky);
    stars = layer('stars', sky);
    starLayer(4021, stars);
    starLayer(9973, stars);
    fall = layer('fall', sky);
  }

  /** The sky now. The theme keeps its side of the horizon: dark text never sits on a night sky, nor white on a bright one. */
  function paint(at, lat, lon, night, code) {
    var s = sun(at, lat, lon), wx = weather(code), alt = night ? Math.min(s.alt, -1) : Math.max(s.alt, 2);
    var grey = night ? [21, 23, 28] : [201, 206, 214], c = colours(alt, s.rising);
    var top = mix(c[0], grey, wx.cover), mid = mix(c[1], grey, wx.cover), low = mix(c[2], grey, wx.cover * 0.85);
    var a = night ? [0.92, 0.84, 0.72] : [0.86, 0.78, 0.66];
    live.style.background = 'linear-gradient(' + rgba(top, a[0]) + ', ' + rgba(mid, a[1]) + ' 55%, ' + rgba(low, a[2]) + ')';
    stars.style.opacity = night ? Math.max(0, Math.min(1, (-alt - 4) / 8)) * (1 - wx.cover) : 0;
    var want = wx.fall ? wx.fall + (night ? ' night' : '') : '';
    if (want === falling) return;
    falling = want;
    fall.className = 'fall ' + wx.fall;
    fall.innerHTML = '';
    if (!wx.fall) return;
    var url = tile(wx.fall, night);
    for (var i = 0; i < 2; i++) layer('falling', fall).style.backgroundImage = 'url(' + url + ')';
  }

  return {init: init, paint: paint, sun: sun};
})();
