'use strict';

/**
 * Line Chart — shared configuration.
 *
 * Loaded by both the chart (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, number formatting and
 * the built-in icon set (the same icon set as KPI Card 3 and Waterfall).
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  var STORAGE_KEY = 'linechart1';

  var FONT_STACK_FALLBACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  /** Font families offered in the dialog. "Lato" ships with the extension. */
  var FONTS = [
    'Lato',
    'IBM Plex Sans',
    'Tableau Book',
    'Tableau Medium',
    'Tableau Semibold',
    'Tableau Bold',
    'Benton Sans',
    'Arial',
    'Helvetica Neue',
    'Segoe UI',
    'Roboto',
    'Open Sans',
    'Georgia',
    'Times New Roman',
    'Courier New'
  ];

  /** Number format — the same options as KPI Card 3 and Waterfall. */
  var FORMAT = {
    scale: 'dynamic', // none | K | M | B | dynamic | workbook | percent | percentDynamic
    decimals: 1,
    pctFromRatio: true, // percent formats: value is a 0–1 ratio (0.4523 → 45.23%)
    unit: '',
    unitPosition: 'suffix', // suffix | prefix
    plusSign: false, // "+262.1" on positive values
    negStyle: 'minus' // minus (−201.4) | hyphen (-201.4) | paren ((201.4))
  };

  function fmtCopy () { return JSON.parse(JSON.stringify(FORMAT)); }

  /** Series colours. A series without its own colour takes the next palette colour. */
  var PALETTES = {
    house: { label: 'House (navy, coral, teal)', colors: ['#2F4B7C', '#EB644C', '#0E7C66', '#F2A541', '#7A5195', '#4E9CB5', '#B4431E', '#8C9AAB', '#D45087', '#3A4656'] },
    tableau10: { label: 'Tableau 10', colors: ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'] },
    colorblind: { label: 'Color blind', colors: ['#1170AA', '#FC7D0B', '#A3ACB9', '#57606C', '#5FA2CE', '#C85200', '#7B848F', '#A3CCE9', '#FFBC79', '#C8D0D9'] },
    blues: { label: 'Blues', colors: ['#1F3A60', '#2F5C8F', '#4A7FB5', '#76A3CF', '#A6C6E4', '#5D6B7D', '#0E3150', '#3C6E9C'] },
    warm: { label: 'Warm', colors: ['#EB644C', '#F2A541', '#B4431E', '#D45087', '#8A3B12', '#F5C26B', '#C9302C', '#7A5195'] }
  };

  /**
   * One series (a measure, or a measure × Color member). Stored per series
   * under cfg.series[key]; unstyled series use cfg.seriesDefaults.
   */
  var SERIES = {
    label: '', // empty → the field (or member) name
    type: 'line', // line | area | hidden
    color: '', // empty → palette colour
    axis: 'left', // left | right
    width: 2,
    style: 'solid', // solid | dashed | dotted
    curve: 'linear', // linear | smooth | step
    markers: 'none', // none | all | last | minmax
    markerSize: 3.5,
    labels: 'none', // none | last | all | minmax | firstlast
    labelSize: 10,
    labelWeight: 600,
    labelColorMode: 'series', // series | custom
    labelColor: '#17202B',
    dashLast: 0 // last N segments dashed (e.g. an incomplete month)
  };

  /** One reference line (cfg.refs is a list of these). */
  var REF = {
    show: true,
    kind: 'average', // constant | average | median | min | max | last
    series: '', // series key it is computed from (empty → every visible series on its axis)
    value: 0, // constant
    axis: 'left', // left | right
    label: '', // empty → automatic ("Average")
    showValue: true,
    labelPos: 'right', // right | left
    color: '#EB644C',
    width: 1,
    style: 'dashed',
    size: 10,
    weight: 600
  };

  function axisFmtDefault () { var f = fmtCopy(); f.decimals = 0; return f; }

  function yAxis (position) {
    return {
      show: true,
      position: position,
      base: 'auto', // zero | auto (close to the data) | manual
      padding: 10, // auto: room below / above the data, % of the data range
      manualMin: 0,
      maxMode: 'auto', // auto | manual
      manualMax: 100,
      ticks: 5,
      title: '',
      font: 'Lato',
      size: 10,
      weight: 400,
      color: '#55606E',
      showLine: false,
      lineColor: '#C9CDD4',
      useGlobalFormat: false,
      fmt: axisFmtDefault()
    };
  }

  var DEFAULTS = {
    icon: {
      show: true,
      source: 'builtin', // builtin | upload | shape
      builtinId: 'fg-line-chart',
      size: 24,
      color: '#EB644C',
      dataUrl: '',
      name: ''
    },
    title: {
      text: '', // empty → the measure names
      font: 'Lato',
      size: 16,
      weight: 500,
      color: '#68707D',
      italic: false
    },
    explanation: {
      show: true,
      text: '',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: true
    },
    card: {
      padding: 15,
      bgColor: '#FFFFFF',
      bgOpacity: 0,
      divider: false,
      dividerColor: '#E2E4E8',
      gap: 10 // space between the header and the chart
    },

    // ---- Numbers ---------------------------------------------------------
    numbers: {
      font: 'Lato', // font of all chart text
      tooltipFull: true // tooltips show full numbers (Tableau's format when available)
    },
    format: fmtCopy(),

    // ---- Chart ------------------------------------------------------------
    chart: {
      palette: 'house',
      missing: 'gap', // gap | zero | connect
      xSpacing: 'even', // even | time (by real date distance)
      tooltip: true,
      tooltipSort: 'tile', // tile | valDesc | valAsc
      tooltipTotal: true, // total row when areas are stacked
      hoverDim: true, // fade other series when hovering a legend item
      rightClickMenu: true
    },
    areas: {
      mode: 'overlay', // overlay | stack | percent
      opacity: 22, // %
      gradient: true, // fade towards the baseline
      outline: true // draw the line on top of the area
    },
    seriesDefaults: JSON.parse(JSON.stringify(SERIES)),
    series: {}, // series key → SERIES overrides

    // Last seen measure names on the Marks card, so a renamed pill keeps its settings.
    layout: { measures: [] },

    // ---- Reference lines, band, forecast ------------------------------------
    refs: [], // list of REF
    band: {
      show: false,
      lower: '', // series key
      upper: '', // series key
      label: 'Range',
      color: '#2F4B7C',
      opacity: 14,
      hideLines: true, // don't draw the lower / upper series themselves
      edges: false // thin dashed edges along the band
    },
    forecast: {
      show: false,
      from: '', // label of the first forecast point on the horizontal axis
      dash: true, // lines dashed from there
      shade: true,
      shadeColor: '#F2F4F7',
      label: 'Forecast',
      labelColor: '#8C96A3'
    },

    // ---- Axes -------------------------------------------------------------
    axisY: yAxis('left'),
    axisY2: yAxis('right'),
    axisX: {
      show: true,
      title: '',
      font: 'Lato',
      size: 10,
      weight: 400,
      color: '#55606E',
      orientation: 'auto', // auto (skip labels to fit) | angled | vertical
      showLine: true,
      lineColor: '#C9CDD4',
      lineWidth: 1,
      ticks: false
    },

    // ---- Lines ------------------------------------------------------------
    lines: {
      hGrid: { show: true, color: '#ECEEF1', width: 1, style: 'solid' },
      vGrid: { show: false, color: '#ECEEF1', width: 1, style: 'solid' },
      zero: { show: true, color: '#C9CDD4', width: 1, style: 'solid' },
      crosshair: { show: true, color: '#8C96A3', width: 1, style: 'dashed' }
    },

    // ---- Legend -----------------------------------------------------------
    legend: {
      show: true,
      position: 'top', // top | bottom | right
      align: 'left', // left | center | right (top / bottom)
      font: 'Lato',
      size: 11,
      weight: 400,
      color: '#55606E',
      interactive: true, // click to hide / show a series
      showLatest: false // latest value next to each name
    }
  };

  // -------------------------------------------------------------------------
  // Built-in icons: only the Figma "Icons for Extension" set (icons.js).
  // -------------------------------------------------------------------------
  var ICONS = (window.KPI3_FIGMA_ICONS || []).map(function (ic) {
    var o = {}; for (var k in ic) o[k] = ic[k]; o.figma = true; return o;
  });

  var ICON_GROUPS = ['Chart icons', 'Others'];

  /** Icon by id. Ids of removed icons fall back to the default icon. */
  function findIcon (id) {
    var fallback = ICONS[0];
    for (var i = 0; i < ICONS.length; i++) {
      if (ICONS[i].id === id) return ICONS[i];
      if (ICONS[i].id === DEFAULTS.icon.builtinId) fallback = ICONS[i];
    }
    return fallback;
  }

  /** Display size: `target` px (default 24) on the longer side, keeping proportions. */
  function iconSize (icon, target) {
    var t = Number(target) > 0 ? Number(target) : 24;
    var w = icon.w || 24;
    var h = icon.h || 24;
    return w >= h
      ? { w: t, h: Math.max(1, Math.round(t * h / w)) }
      : { w: Math.max(1, Math.round(t * w / h)), h: t };
  }

  /**
   * Markup for any built-in icon plus its display size.
   *   path icons      inline SVG painted with `color`
   *   Figma, tint     PNG used as a mask over `color` (follows Icon color)
   *   Figma, no tint  plain <img> in its own colours (logos, multi-colour)
   */
  function iconHtml (id, color, target) {
    var icon = findIcon(id);
    var size = iconSize(icon, target);
    var html;
    if (icon.src) {
      if (icon.tint) {
        var m = 'url(' + icon.src + ') center / contain no-repeat';
        html = '<span class="kpi3-icon-mask" style="display:block;width:' + size.w + 'px;height:' + size.h +
          'px;background-color:' + color + ';-webkit-mask:' + m + ';mask:' + m + '"></span>';
      } else {
        html = '<img src="' + icon.src + '" alt="" width="' + size.w + '" height="' + size.h +
          '" style="display:block;width:' + size.w + 'px;height:' + size.h + 'px">';
      }
    } else {
      var paint = icon.mode === 'stroke'
        ? 'fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
        : 'fill="' + color + '"';
      html = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size.w + '" height="' + size.h + '" viewBox="0 0 24 24" style="display:block">' +
        '<path ' + paint + ' d="' + icon.d + '"/></svg>';
    }
    return { html: html, w: size.w, h: size.h, icon: icon };
  }

  /** Kept for existing callers: markup only. */
  function iconSvg (id, color) {
    return iconHtml(id, color).html;
  }


  // -------------------------------------------------------------------------
  // Settings I/O
  // -------------------------------------------------------------------------
  function clone (o) { return JSON.parse(JSON.stringify(o)); }

  function isMap (o) { return o && typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length; }

  /**
   * Deep-merges stored values over the defaults so new keys get defaults.
   * An empty object in the defaults ({}) is a map (series, colours
   * …): the stored map is copied as is.
   */
  function merge (base, over) {
    var out = clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(out).forEach(function (k) {
      if (!(k in over)) return;
      if (isMap(out[k])) {
        if (over[k] && typeof over[k] === 'object') out[k] = clone(over[k]);
      } else if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = merge(out[k], over[k]);
      } else if (typeof over[k] === typeof out[k] || out[k] === '' || out[k] == null) {
        out[k] = over[k];
      }
    });
    return out;
  }

  function read () {
    try {
      var raw = tableau.extensions.settings.get(STORAGE_KEY);
      return merge(DEFAULTS, raw ? JSON.parse(raw) : null);
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  function write (cfg) {
    tableau.extensions.settings.set(STORAGE_KEY, JSON.stringify(cfg));
    return tableau.extensions.settings.saveAsync();
  }

  /** Settings of one series: stored overrides on top of the series defaults. */
  function seriesCfg (cfg, key) {
    return merge(cfg.seriesDefaults, cfg.series[key]);
  }

  /** One reference line, with defaults for keys added later. */
  function refCfg (r) {
    return merge(REF, r);
  }

  /** Default colour of the i-th series in a palette. */
  function paletteColor (name, i) {
    var p = PALETTES[name] || PALETTES.house;
    return p.colors[((i % p.colors.length) + p.colors.length) % p.colors.length];
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------
  var SCALES = { K: 1e3, M: 1e6, B: 1e9 };

  function pickScale (value, scale) {
    if (scale === 'dynamic') {
      var a = Math.abs(value);
      return a >= 1e9 ? 'B' : a >= 1e6 ? 'M' : a >= 1e3 ? 'K' : '';
    }
    return SCALES[scale] ? scale : '';
  }

  function fixed (n, decimals) {
    var d = Math.max(0, Math.min(10, Number(decimals) || 0));
    try {
      return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d
      }).format(n);
    } catch (e) {
      return n.toFixed(d);
    }
  }

  function formatScaled (value, scale, decimals, forceScale) {
    if (!isFinite(value)) return '—';
    var suffix = forceScale != null ? forceScale : pickScale(value, scale);
    var divisor = SCALES[suffix] || 1;
    var text = fixed(value / divisor, decimals);
    if (/^-[0.,]+$/.test(text)) text = text.slice(1);
    return text + suffix;
  }

  /**
   * Formats a number with a format object (see FORMAT).
   *   opts.signed      write "+" on positive values (changes)
   *   opts.fv          Tableau's formatted value (Workbook format)
   *   opts.forceScale  reuse a K/M/B suffix (axis ticks share one)
   *   opts.noUnit      leave the unit off
   *   opts.zeroSign    -1 / 1: sign of a signed value that is exactly 0 (the
   *                    bar's direction). Values that round to 0 keep their own sign.
   */
  function formatNumber (v, f, opts) {
    opts = opts || {};
    f = f || FORMAT;
    if (!isFinite(v)) return '—';
    var body;
    var neg = v < 0;
    var a = Math.abs(v);
    if (f.scale === 'percent' || f.scale === 'percentDynamic') {
      var p = f.pctFromRatio ? a * 100 : a;
      body = formatScaled(p, f.scale === 'percentDynamic' ? 'dynamic' : 'none', f.decimals,
        f.scale === 'percentDynamic' ? opts.forceScale : '') + '%';
    } else if (f.scale === 'workbook' && opts.fv) {
      body = String(opts.fv).replace(/^[-−(]\s*/, '').replace(/\)$/, '');
    } else {
      var sc = f.scale === 'workbook' ? 'dynamic' : f.scale;
      body = formatScaled(a, sc, f.decimals, opts.forceScale);
    }
    // A value that rounds to zero: changes (signed) show the bar's sign
    // (+0.0 / −0.0); other numbers carry no sign.
    var isZero = !/[1-9]/.test(body);
    if (isZero) neg = opts.signed ? (v < 0 || (v === 0 && opts.zeroSign < 0)) : false;
    if (!opts.noUnit && f.unit) body = f.unitPosition === 'prefix' ? f.unit + ' ' + body : body + ' ' + f.unit;
    if (neg) {
      if (f.negStyle === 'paren') return '(' + body + ')';
      return (f.negStyle === 'hyphen' ? '-' : '−') + body;
    }
    if (opts.signed && f.plusSign) return '+' + body;
    return body;
  }

  function fontStack (family) {
    if (!family) return FONT_STACK_FALLBACK;
    return '"' + String(family).replace(/"/g, '') + '", ' + FONT_STACK_FALLBACK;
  }

  function normalizeHex (value) {
    if (typeof value !== 'string') return null;
    var hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/(.)/g, '$1$1');
    return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : null;
  }

  function rgb (hex) {
    var h = normalizeHex(hex) || '#000000';
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function rgba (hex, alpha) {
    var c = rgb(hex);
    return 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + alpha + ')';
  }

  /** Mixes a colour with white: t = 0 → the colour, t = 1 → white. */
  function tint (hex, t) {
    var c = rgb(hex);
    var m = function (x) { return Math.round(x + (255 - x) * t); };
    return '#' + [m(c[0]), m(c[1]), m(c[2])].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('').toUpperCase();
  }

  /** Dark or light text, whichever reads better on `hex`. */
  function contrastText (hex) {
    var c = rgb(hex).map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return L > 0.36 ? '#17202B' : '#FFFFFF';
  }

  /** Shades of one colour for breakdown segments: first = the colour itself. */
  function shades (hex, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(tint(hex, n <= 1 ? 0 : (i / (n - 1)) * 0.62));
    return out;
  }

  function dashArray (style, width) {
    var w = Math.max(0.5, Number(width) || 1);
    if (style === 'dashed') return (3 * w) + ',' + (3 * w);
    if (style === 'dotted') return w + ',' + (2 * w);
    return '';
  }

  window.Lc = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    SERIES: SERIES,
    REF: REF,
    FORMAT: FORMAT,
    PALETTES: PALETTES,
    FONTS: FONTS,
    ICONS: ICONS,
    ICON_GROUPS: ICON_GROUPS,
    findIcon: findIcon,
    iconHtml: iconHtml,
    iconSvg: iconSvg,
    clone: clone,
    merge: merge,
    read: read,
    write: write,
    seriesCfg: seriesCfg,
    refCfg: refCfg,
    paletteColor: paletteColor,
    pickScale: pickScale,
    fixed: fixed,
    formatScaled: formatScaled,
    formatNumber: formatNumber,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba,
    tint: tint,
    shades: shades,
    contrastText: contrastText,
    dashArray: dashArray
  };
  // The icon helpers in icons.js / the KPI picker code refer to Kpi3.
  window.Kpi3 = window.Kpi3 || window.Lc;
})();
