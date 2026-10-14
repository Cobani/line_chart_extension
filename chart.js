'use strict';

/**
 * Line Chart — Tableau Viz Extension.
 *
 * Marks card tiles (declared in line-chart.trex):
 *   date      The horizontal axis: one or more date fields at any level
 *             (YEAR + MONTH, exact date, ...) or any other dimension.
 *   measures  Any number of measures, dropped one by one. Each becomes a
 *             series drawn as a line or an area (Format → Series).
 *   color     Optional dimension that splits every measure into one series
 *             per member.
 *
 * Header (icon, title, explanation) and card options are the same as KPI
 * Card 3. Everything else is set in the Format dialog (configure.html), which
 * also opens from a right-click or double-click in the chart or the legend.
 */
(function () {
  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null; // see extract()
  var view = null; // last layout: { xs: [px], series: [...], ... } for hover
  var hidden = {}; // series hidden from the legend (this session only)
  var hoverKey = null; // legend item under the mouse
  var renderToken = 0;
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'body', 'legend', 'plot', 'svg', 'hint', 'tooltip', 'menu'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.svg.addEventListener('mousemove', onHover);
    el.svg.addEventListener('mouseleave', function () { hideTooltip(); clearCrosshair(); });
    el.svg.addEventListener('contextmenu', onContextMenu);
    el.svg.addEventListener('dblclick', function (e) {
      var s = seriesFromEvent(e);
      openDialog({ tab: 'series', item: s ? s.key : null });
    });
    el.legend.addEventListener('click', onLegendClick);
    el.legend.addEventListener('dblclick', function (e) {
      var k = legendKey(e);
      if (k) openDialog({ tab: 'series', item: k });
    });
    el.legend.addEventListener('mouseover', function (e) { setHover(legendKey(e)); });
    el.legend.addEventListener('mouseleave', function () { setHover(null); });
    el.legend.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', function (e) {
      if (!el.menu.contains(e.target)) hideMenu();
    });
    window.addEventListener('blur', hideMenu);

    if (window.ExtTiming) ExtTiming.mark('initializeAsync start');
    return tableau.extensions.initializeAsync({ configure: function () { return openDialog(null); } }).then(function () {
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Lc.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () { cfg = Lc.read(); reconcileKeys(); paint(); }
      );

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      console.error('Line Chart failed to initialize:', err);
      showEmpty('Could not initialize the extension. See the console for details.');
    });
  }

  var queued = false;
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; paint(); });
  }

  /**
   * Opens the Format dialog. `focus` ({ tab, item }) preselects a tab and a
   * series. The dialog gets the current series and axis labels as payload,
   * because it can't read the worksheet itself.
   */
  function openDialog (focus) {
    hideMenu();
    hideTooltip();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var list = model && cfg ? resolveSeries() : [];
    var payload = JSON.stringify({
      focus: focus || null,
      series: list.map(function (s) {
        return { key: s.key, name: s.name, color: s.color, measure: s.mkey, member: s.member };
      }),
      xs: model ? model.xs.map(function (x) { return x.label; }) : [],
      hasTime: !!(model && model.hasTime),
      colorDim: model && model.colorDim ? model.colorDim.name : ''
    });
    var options = { width: 600, height: 760 };
    if (tableau.DialogStyle && tableau.DialogStyle.Modeless) options.dialogStyle = tableau.DialogStyle.Modeless;
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Line Chart dialog:', err && err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Last-render cache: on load, draw the previous result straight away (right
  // after the Tableau handshake), then replace it with the live data. Stored in
  // this browser only (localStorage), per worksheet, and only reused when the
  // same fields are on the Marks card. Any storage error just skips the cache.
  // ---------------------------------------------------------------------------
  var CACHE_PREFIX = 'line-chart:lastRender:v1:';
  var CACHE_MAX_AGE = 30 * 24 * 3600 * 1000; // 30 days
  var CACHE_MAX_CHARS = 400000;
  var cacheTried = false;

  function cacheKey () {
    var host = '';
    try { host = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { /* ignore */ }
    return CACHE_PREFIX + host + '|' + (worksheet && worksheet.name);
  }

  /** Identifies what's on the Marks card, so a cache is only used for the same setup. */
  function fieldsSig (fields) {
    var out = {};
    Object.keys(fields).sort().forEach(function (k) {
      out[k] = fields[k].map(function (f) { return (f.id || '') + '|' + (f.name || ''); });
    });
    return JSON.stringify(out);
  }

  // JSON keeps Dates and NaN/Infinity intact.
  function enc (k, v) {
    var raw = this[k];
    if (raw instanceof Date) return { $d: raw.getTime() };
    if (typeof raw === 'number' && !isFinite(raw)) return { $n: String(raw) };
    return v;
  }
  function dec (k, v) {
    if (v && typeof v === 'object') {
      if (Object.prototype.hasOwnProperty.call(v, '$d')) return new Date(v.$d);
      if (Object.prototype.hasOwnProperty.call(v, '$n')) return Number(v.$n);
    }
    return v;
  }

  /** The saved result for this worksheet, if fresh: { sig, data }. */
  function readCacheEntry () {
    try {
      var s = window.localStorage.getItem(cacheKey());
      if (!s) return null;
      var c = JSON.parse(s, dec);
      if (!c || !c.data || !(Date.now() - c.t < CACHE_MAX_AGE)) return null;
      return c;
    } catch (e) { return null; }
  }

  function writeCache (fields, data) {
    try {
      var s = JSON.stringify({ sig: fieldsSig(fields), t: Date.now(), data: data }, enc);
      if (s.length > CACHE_MAX_CHARS) return;
      try {
        window.localStorage.setItem(cacheKey(), s);
      } catch (full) {
        // Storage full: drop this extension's old entries and try once more.
        for (var i = window.localStorage.length - 1; i >= 0; i--) {
          var k = window.localStorage.key(i);
          if (k && k.indexOf(CACHE_PREFIX) === 0) window.localStorage.removeItem(k);
        }
        window.localStorage.setItem(cacheKey(), s);
      }
    } catch (e) { /* ignore */ }
  }

  function clearCache () {
    try { window.localStorage.removeItem(cacheKey()); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      // Ask Tableau for the encodings and the data at the same time (one round trip instead of two).
      // A data error only matters when fields are encoded, so it is held until then.
      var tFields = 0;
      var tData = 0;
      var fieldsP = getEncodedFields().then(function (r) { tFields = ms(); if (first) T.mark('fields received (Marks card)'); return r; });
      var dataP = readSummaryData().then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });

      // First load: draw the last result from cache right after the handshake,
      // while Tableau is still working on the fields and the data. If the fields
      // on the Marks card turn out to be different, the cached drawing is removed.
      if (!cacheTried) {
        cacheTried = true;
        var entry = readCacheEntry();
        if (entry && !model) {
          model = entry.data;
          try { paint(); T.mark('cached result drawn'); } catch (e) { model = null; entry = null; }
        }
        if (entry) {
          fieldsP.then(function (f) {
            if (token !== renderToken || model !== entry.data || entry.sig === fieldsSig(f)) return;
            model = null;
            showEmpty('');
            T.mark('cached result removed (fields changed)');
          }).catch(function () { /* handled below */ });
        }
      }

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== renderToken) return;
      var fields = results[0];

      if (!fields.measures.length) {
        model = null;
        clearCache();
        if (first) { T.mark('no measures on the Marks card'); T.done('Line Chart load timings'); }
        showEmpty('Drag measures onto <b>Measures</b> (one at a time) and a date onto <b>Date</b>.<br>' +
          'Add a dimension to <b>Color</b> to split each measure into several lines.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      model = extract(table, fields);
      reconcileKeys();
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Line Chart load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
      writeCache(fields, model);
    } catch (err) {
      console.error('Line Chart render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Line Chart load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. See the console for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = { date: [], measures: [], color: [] };
    marks.encodings.forEach(function (enc) {
      if (!enc.field) return;
      (fields[enc.id] = fields[enc.id] || []).push(enc.field);
    });
    return fields;
  }

  async function readSummaryData () {
    var reader = await worksheet.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
    try {
      return await reader.getAllPagesAsync();
    } finally {
      await reader.releaseAsync();
    }
  }

  function norm (s) {
    return String(s || '').replace(/^[A-Z_]+\((.*)\)$/i, '$1').trim().toLowerCase();
  }

  /** Name without an inline-calculation comment: "SUM([X]) //New name" → both parts. */
  function nameParts (s) {
    var str = String(s || '');
    var i = str.indexOf('//');
    if (i < 0) return [norm(str)];
    return [norm(str.slice(i + 2)), norm(str.slice(0, i))].filter(Boolean);
  }

  function isMN (c) { return /^measure (names|values)$/i.test(c.fieldName); }
  function isNumericCol (c) { return /^(float|int|real|integer|number)$/i.test(String(c.dataType || '')); }

  /** Column for a field by id or name (exact, without aggregation, or around a // comment). */
  function findColumn (table, field, taken) {
    if (!field) return null;
    var cols = table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    var fid = field.id || field.fieldId;
    var fn = nameParts(field.name);
    return cols.find(function (c) { return fid && c.fieldId && c.fieldId === fid; }) ||
      cols.find(function (c) { return c.fieldName === field.name; }) ||
      cols.find(function (c) { return norm(c.fieldName) === norm(field.name); }) ||
      cols.find(function (c) {
        var cn = nameParts(c.fieldName);
        return cn.some(function (x) { return fn.indexOf(x) >= 0; });
      }) ||
      null;
  }

  /**
   * Fields that couldn't be matched by id or name get the columns nobody else
   * took, in order: dimensions prefer text/date columns, measures numeric ones.
   * This happens when a pill is renamed (double-click, "//New name"): Tableau
   * then reports the field and its data column under different names.
   */
  function matchLeftovers (table, reqs, taken, pivoted) {
    var free = function () {
      return table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    };
    var take = function (r, c) { if (c) { r.col = c; taken.push(c); r.guessed = true; } };
    // 1. dimensions → text / date columns
    reqs.forEach(function (r) {
      if (!r.col && r.dim) take(r, free().find(function (x) { return !isNumericCol(x); }));
    });
    // 2. measures → numeric columns (not when they come as Measure Names / Values)
    if (!pivoted) {
      reqs.forEach(function (r) {
        if (!r.col && !r.dim) take(r, free().find(isNumericCol));
      });
    }
    // 3. anything left (numeric dimensions, columns without a data type) → in order
    reqs.forEach(function (r) {
      if (!r.col && (r.dim || !pivoted)) take(r, free()[0]);
    });
    var guessed = reqs.filter(function (r) { return r.guessed; });
    if (guessed.length) {
      console.info('Line Chart: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  function toNumber (cell) {
    if (!cell) return NaN;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v === null || v === '%null%' || v === '') return NaN;
    return typeof v === 'number' ? v : Number(v);
  }

  function cleanName (name) {
    var s = String(name || '');
    var i = s.indexOf('//');
    if (i >= 0 && s.slice(i + 2).trim()) return s.slice(i + 2).trim();
    return s.replace(/^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|ATTR)\((.*)\)$/i, '$2');
  }

  // ---- dates (same rules as KPI Card) -----------------------------------------
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  /**
   * How fine a date column is, so combined fields sort coarse → fine
   * (YEAR before QUARTER before MONTH ...) whatever order they were dropped in.
   */
  function granularity (fieldName) {
    var m = /^(\w+)\(/.exec(String(fieldName || ''));
    var p = m ? m[1].toUpperCase() : '';
    var rank = {
      YEAR: 1, YR: 1, TYEAR: 1,
      QUARTER: 2, QR: 2, TQUARTER: 2,
      MONTH: 3, MN: 3, MY: 3, TMONTH: 3,
      WEEK: 4, WK: 4, TWEEK: 4,
      DAY: 5, DY: 5, MDY: 5, TDAY: 5,
      WEEKDAY: 6,
      HOUR: 7, MINUTE: 8, SECOND: 9
    };
    return rank[p] || 5; // exact dates and other dimensions count as day level
  }

  /**
   * Turns one cell into something sortable. Handles real dates (exact or
   * truncated), numeric date parts (YEAR 2026, MONTH 5, WEEK 18, QUARTER 2)
   * and named parts ("May", "Q2", "Monday", "May 2026"). Other text → NaN
   * (keeps Tableau's order).
   */
  function ordinal (cell) {
    if (!cell) return NaN;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    var strs = [v, cell.formattedValue];
    for (var i = 0; i < strs.length; i++) {
      var s = strs[i];
      if (s == null || s === '%null%') continue;
      s = String(s).trim();
      var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
      if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)).getTime();
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      var q = /^(?:q|quarter\s*)(\d)$/i.exec(s);
      if (q) return Number(q[1]);
      var w = /^(?:w|week\s*)(\d{1,2})$/i.exec(s);
      if (w) return Number(w[1]);
      var low = s.toLowerCase();
      if (/^[a-z]+$/.test(low)) {
        var mi = MONTHS.indexOf(low.slice(0, 3));
        if (mi >= 0 && !/^(mon|tue|wed|thu|fri|sat|sun)/.test(low)) return mi + 1;
        var wi = WEEKDAYS.indexOf(low.slice(0, 3));
        if (wi >= 0) return wi + 1;
      }
      if (/\d/.test(s)) {
        var parsed = Date.parse(s);
        if (!isNaN(parsed)) return parsed;
      }
    }
    return NaN;
  }

  /** A real calendar date for a cell as UTC ms at midnight, or null for date parts. */
  function toDay (cell) {
    if (!cell) return null;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      // Tableau sends dates as UTC midnight; anything else is a local time.
      var utc = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
      return utc ? Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())
        : Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes());
    }
    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v == null ? '' : v).trim());
    return iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) : null;
  }

  function compareKeys (a, b) {
    for (var i = 0; i < a.key.length; i++) {
      var x = a.key[i];
      var y = b.key[i];
      var xn = isNaN(x);
      var yn = isNaN(y);
      if (xn && yn) continue;
      if (xn) return 1;
      if (yn) return -1;
      if (x !== y) return x - y;
    }
    return a.i - b.i; // Tableau's own order as the tie-breaker
  }

  /** Granularity of a date field from its pill or column name ("MONTH(Order Date)"). */
  function fieldGrain (r) {
    var a = /^\w+\(/.test(String(r.field && r.field.name)) ? r.field.name : r.col.fieldName;
    return granularity(a);
  }

  /**
   * Summary data → {
   *   xs:       [{ label, t }]  points on the horizontal axis, in date order
   *             (t = UTC ms when every point is a real date, else null)
   *   series:   [{ key, mkey, member, name, vals: [number|NaN per x], fvs }]
   *   measures: [{ key, name }], colorDim: { key, name } | null
   * }
   * Rows that share the same x (and Color member) are summed. If Tableau
   * delivers several measures as Measure Names / Measure Values, those are
   * pivoted back into one value per measure.
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var cMN = table.columns.find(function (c) { return /^measure names$/i.test(c.fieldName); });
    var cMV = table.columns.find(function (c) { return /^measure values$/i.test(c.fieldName); });

    var dReqs = fields.date.map(function (f) { return { field: f, dim: true, col: null }; });
    var cReqs = fields.color.slice(0, 1).map(function (f) { return { field: f, dim: true, col: null }; });
    var seen = {};
    var mReqs = fields.measures.map(function (f) {
      var key = f.name;
      while (seen[key]) key += '+'; // the same field twice
      seen[key] = true;
      return { field: f, col: null, key: key, name: cleanName(f.name) };
    });

    var reqs = dReqs.concat(cReqs, mReqs);
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    matchLeftovers(table, reqs, taken, !!(cMN && cMV));

    // Date columns coarse → fine, so YEAR + MONTH sorts by year first.
    var cDates = dReqs.filter(function (r) { return r.col; })
      .map(function (r, k) { return { c: r.col, k: k, g: fieldGrain(r) }; })
      .sort(function (a, b) { return a.g - b.g || a.k - b.k; })
      .map(function (o) { return o.c; });
    var cColor = cReqs[0] && cReqs[0].col;

    // The finest date column that holds real dates gives the time scale.
    var cDay = null;
    if (cDates.length) {
      var finest = cDates[cDates.length - 1];
      for (var ri = 0; ri < rows.length; ri++) {
        var cellD = rows[ri][finest.index];
        var raw = cellD && (cellD.nativeValue != null ? cellD.nativeValue : cellD.value);
        if (raw == null || raw === '%null%' || raw === '') continue;
        if (toDay(cellD) != null) cDay = finest;
        break;
      }
    }

    // Date parts read best fine → coarse ("March 2025"); other dimensions in tile order.
    var allParts = cDates.length > 1 && dReqs.every(function (r) { return !r.col || /^(YEAR|QUARTER|MONTH|WEEK|DAY|WEEKDAY)\(/i.test(r.field.name); });
    var labelCols = allParts ? cDates.slice().reverse() : cDates;
    var labelSep = allParts ? ' ' : ' · ';

    var xs = [];
    var xIndex = {};
    var members = [];
    var memberSeen = {};
    var acc = {};

    rows.forEach(function (r, rowI) {
      var label = labelCols.map(function (c) { return String(r[c.index].formattedValue); }).join(labelSep);
      if (!(label in xIndex)) {
        xIndex[label] = xs.length;
        xs.push({
          label: label,
          key: cDates.map(function (c) { return ordinal(r[c.index]); }),
          t: cDay ? toDay(r[cDay.index]) : null,
          i: rowI
        });
      }
      var member = cColor ? String(r[cColor.index].formattedValue) : null;
      if (member != null && !memberSeen[member]) { memberSeen[member] = 1; members.push(member); }
      var mn = cMN ? norm(r[cMN.index].formattedValue || r[cMN.index].value) : null;
      mReqs.forEach(function (m) {
        var cell = null;
        if (m.col) cell = r[m.col.index];
        else if (cMN && cMV && (mn === norm(m.field.name) || mn === norm(m.name))) cell = r[cMV.index];
        if (!cell) return;
        var v = toNumber(cell);
        if (!isFinite(v)) return;
        var skey = member == null ? m.key : m.key + ' · ' + member;
        var a = acc[skey] || (acc[skey] = { m: m, member: member, sums: {}, n: {}, fv: {} });
        a.sums[label] = (a.sums[label] || 0) + v;
        a.n[label] = (a.n[label] || 0) + 1;
        a.fv[label] = a.n[label] === 1 ? cell.formattedValue : null;
      });
    });

    if (cDates.length) xs.sort(compareKeys);

    var series = [];
    mReqs.forEach(function (m) {
      (cColor ? members : [null]).forEach(function (member) {
        var skey = member == null ? m.key : m.key + ' · ' + member;
        var a = acc[skey];
        if (!a) return;
        series.push({
          key: skey,
          mkey: m.key,
          member: member,
          name: member == null ? m.name : (mReqs.length === 1 ? member : m.name + ' · ' + member),
          vals: xs.map(function (x) { return x.label in a.sums ? a.sums[x.label] : NaN; }),
          fvs: xs.map(function (x) { return a.fv[x.label] != null ? a.fv[x.label] : null; })
        });
      });
    });

    return {
      xs: xs.map(function (x) { return { label: x.label, t: x.t }; }),
      series: series,
      measures: mReqs.map(function (m) { return { key: m.key, name: m.name }; }),
      colorDim: cReqs[0] ? { key: cReqs[0].field.name, name: cleanName(cReqs[0].field.name) } : null,
      xName: dReqs.map(function (r) { return cleanName(r.field.name); }).join(' · '),
      hasDate: cDates.length > 0,
      dateMissing: fields.date.length > 0 && !cDates.length,
      hasTime: !!cDay && xs.length > 1 && xs.every(function (x) { return x.t != null; }),
      missing: mReqs.filter(function (m) { return !series.some(function (s) { return s.mkey === m.key; }); }).map(function (m) { return m.name; })
    };
  }

  // ---------------------------------------------------------------------------
  // Renamed pills keep their settings
  //
  // Settings are stored by series key (the measure's pill name, plus " · member"
  // with a Color dimension). When a pill is renamed (double-click → "//New
  // name"), its name changes but its place on the tile doesn't. cfg.layout
  // remembers the names last seen; a name that disappeared while a new one
  // appeared at the same position is a rename, and its settings move along.
  // ---------------------------------------------------------------------------
  function renames (prev, cur) {
    var out = {};
    if (!prev || !prev.length || prev.length !== cur.length) return out;
    var gone = prev.filter(function (k) { return cur.indexOf(k) < 0; });
    var added = cur.filter(function (k) { return prev.indexOf(k) < 0; });
    if (!gone.length || gone.length !== added.length) return out;
    gone.forEach(function (k) {
      var n = cur[prev.indexOf(k)];
      if (added.indexOf(n) >= 0) out[k] = n;
    });
    return out;
  }

  /** Applies renames to cfg (in memory) and saves when anything changed. */
  function reconcileKeys () {
    if (!cfg || !model || !model.measures) return;
    var cur = { measures: model.measures.map(function (m) { return m.key; }) };
    var prev = cfg.layout || { measures: [] };
    var dirty = false;

    var rs = renames(prev.measures, cur.measures);
    Object.keys(rs).forEach(function (oldK) {
      var newK = rs[oldK];
      var move = function (k) {
        if (k === oldK) return newK;
        if (typeof k === 'string' && k.indexOf(oldK + ' · ') === 0) return newK + k.slice(oldK.length);
        return k;
      };
      Object.keys(cfg.series).forEach(function (k) {
        var nk = move(k);
        if (nk !== k && !cfg.series[nk]) { cfg.series[nk] = cfg.series[k]; delete cfg.series[k]; dirty = true; }
      });
      ['lower', 'upper'].forEach(function (b) {
        var nk = move(cfg.band[b]);
        if (nk !== cfg.band[b]) { cfg.band[b] = nk; dirty = true; }
      });
      (cfg.refs || []).forEach(function (r) {
        if (r && r.series) { var nk = move(r.series); if (nk !== r.series) { r.series = nk; dirty = true; } }
      });
      if (hidden[oldK]) { hidden[newK] = true; delete hidden[oldK]; }
    });

    if (JSON.stringify(prev) !== JSON.stringify(cur)) { cfg.layout = cur; dirty = true; }
    if (dirty) {
      // Saving only works while authoring; viewers still get the renames in memory.
      try { Lc.write(cfg).catch(function () { /* read-only */ }); } catch (e) { /* read-only */ }
    }
  }

  /** Series with their resolved settings, display names and colours. */
  function resolveSeries () {
    return model.series.map(function (s, i) {
      var sc = Lc.seriesCfg(cfg, s.key);
      return {
        key: s.key,
        mkey: s.mkey,
        member: s.member,
        name: sc.label || s.name,
        vals: s.vals,
        fvs: s.fvs || [],
        sc: sc,
        color: Lc.normalizeHex(sc.color) || Lc.paletteColor(cfg.chart.palette, i),
        i: i
      };
    });
  }

  function lastIndex (vals) {
    for (var i = vals.length - 1; i >= 0; i--) if (isFinite(vals[i])) return i;
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Number text
  // ---------------------------------------------------------------------------
  function fmt (v, fv) {
    return Lc.formatNumber(v, cfg.format, { fv: fv });
  }

  /** Full, unabbreviated value for tooltips (Tableau's own text when it is a single value). */
  function fullText (v, fv) {
    if (!cfg.numbers.tooltipFull) return fmt(v, fv);
    var f = cfg.format;
    if (fv && (f.scale === 'workbook' || f.scale === 'dynamic' || /^[KMB]$/.test(f.scale) || f.scale === 'none')) return String(fv);
    var g = Lc.clone(f);
    if (g.scale === 'percentDynamic') g.scale = 'percent';
    else if (g.scale !== 'percent') g.scale = 'none';
    return Lc.formatNumber(v, g);
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg || !model) return;
    var list = resolveSeries();
    if (!list.length || !model.xs.length) {
      showEmpty(model.missing && model.missing.length
        ? 'No values for <b>' + esc(model.missing.join(', ')) + '</b>.'
        : 'No values to show.');
      return;
    }
    el.card.classList.remove('is-empty');
    hideTooltip();
    paintCard();
    paintHeader(list);
    paintLegend(list);
    drawChart(list);
  }

  function applyFont (node, f) {
    node.style.fontFamily = Lc.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Lc.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.card.style.borderRightColor = c.divider ? c.dividerColor : 'transparent';
    el.card.style.borderRightWidth = c.divider ? '1px' : '0';
    el.body.style.marginTop = c.gap + 'px';
  }

  function paintHeader (list) {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Lc.iconHtml(ic.builtinId, ic.color, iconTarget());
        el.icon.innerHTML = r.html;
        setIconBox(r.w, r.h);
      } else {
        var img = new Image();
        img.alt = '';
        img.onload = function () { sizeImageIcon(img); };
        img.src = ic.dataUrl;
        el.icon.appendChild(img);
        if (img.complete) sizeImageIcon(img);
      }
    }

    applyFont(el.title, cfg.title);
    var names = model.colorDim
      ? model.measures.map(function (m) { return m.name; })
      : list.filter(function (s) { return s.sc.type !== 'hidden'; }).map(function (s) { return s.name; });
    if (!names.length) names = model.measures.map(function (m) { return m.name; });
    el.title.textContent = cfg.title.text ||
      (names.length > 3 ? names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more' : names.join(' vs '));

    var ex = cfg.explanation;
    applyFont(el.explanation, ex);
    el.explanation.textContent = ex.text;
    el.explanation.style.display = ex.show && ex.text ? '' : 'none';
    updateIconSpan();
  }

  function sizeImageIcon (img) {
    var t = iconTarget();
    var w = img.naturalWidth || t;
    var h = img.naturalHeight || t;
    var W, H;
    if (w >= h) { W = t; H = Math.max(1, Math.round(t * h / w)); } else { H = t; W = Math.max(1, Math.round(t * w / h)); }
    img.style.width = W + 'px';
    img.style.height = H + 'px';
    setIconBox(W, H);
  }

  function iconTarget () {
    var n = Number(cfg.icon.size);
    return isFinite(n) && n > 0 ? Math.max(8, Math.min(128, n)) : 24;
  }

  var iconBoxH = 0;
  function setIconBox (w, h) {
    el.icon.style.width = w + 'px';
    el.icon.style.height = h + 'px';
    iconBoxH = h;
    updateIconSpan();
  }

  function updateIconSpan () {
    var head = el.icon.parentNode;
    var titleH = el.title.offsetHeight || 19;
    var hasExplanation = el.explanation.style.display !== 'none';
    head.classList.toggle('icon-span', hasExplanation && iconBoxH > titleH * 1.5);
  }

  // ---------------------------------------------------------------------------
  // Legend (HTML, above / below / right of the plot)
  // ---------------------------------------------------------------------------
  function bandActive (list) {
    var b = cfg.band;
    return b.show && b.lower && b.upper && b.lower !== b.upper &&
      list.some(function (s) { return s.key === b.lower; }) && list.some(function (s) { return s.key === b.upper; });
  }

  function swatch (s) {
    var c = s.color;
    if (s.band) {
      return '<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="2" width="18" height="8" rx="2" fill="' + c +
        '" fill-opacity="' + Math.max(0.15, cfg.band.opacity / 100 * 2) + '"/></svg>';
    }
    var dash = Lc.dashArray(s.sc.style, 2);
    if (s.sc.type === 'area') {
      return '<svg width="18" height="12" viewBox="0 0 18 12"><path d="M0 12V5L6 3L12 6L18 2V12Z" fill="' + c + '" fill-opacity="0.35"/>' +
        '<path d="M0 5L6 3L12 6L18 2" fill="none" stroke="' + c + '" stroke-width="2"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/></svg>';
    }
    return '<svg width="18" height="12" viewBox="0 0 18 12"><line x1="0" y1="6" x2="18" y2="6" stroke="' + c +
      '" stroke-width="2.2"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>' +
      (s.sc.markers !== 'none' ? '<circle cx="9" cy="6" r="2.8" fill="' + c + '" stroke="#fff" stroke-width="1"/>' : '') + '</svg>';
  }

  function legendItems (list) {
    var b = cfg.band;
    var bandOn = bandActive(list);
    var items = list.filter(function (s) {
      if (s.sc.type === 'hidden') return false;
      if (bandOn && b.hideLines && (s.key === b.lower || s.key === b.upper)) return false;
      return true;
    });
    if (bandOn) items.push({ key: '__band', name: b.label || 'Range', color: Lc.normalizeHex(b.color) || '#2F4B7C', band: true, sc: {} });
    return items;
  }

  function paintLegend (list) {
    var lg = cfg.legend;
    var items = legendItems(list);
    el.body.className = 'body legend-' + lg.position;
    if (!lg.show || items.length < 1 || (items.length < 2 && !lg.showLatest)) {
      el.legend.style.display = 'none';
      el.legend.innerHTML = '';
      return;
    }
    el.legend.style.display = '';
    el.legend.style.justifyContent = lg.position === 'right' ? '' : (lg.align === 'center' ? 'center' : lg.align === 'right' ? 'flex-end' : 'flex-start');
    applyFont(el.legend, lg);
    el.legend.classList.toggle('is-interactive', !!lg.interactive);
    el.legend.innerHTML = items.map(function (s) {
      var latest = '';
      if (lg.showLatest && !s.band) {
        var li = lastIndex(s.vals);
        if (li >= 0) latest = '<span class="lg-val">' + esc(fmt(s.vals[li], s.fvs[li])) + '</span>';
      }
      return '<button type="button" class="lg-item' + (hidden[s.key] ? ' is-off' : '') + '" data-key="' + esc(s.key) + '"' +
        ' title="' + esc(lg.interactive ? 'Click to hide or show. Double-click to format.' : s.name) + '">' +
        '<span class="lg-sw">' + swatch(s) + '</span><span class="lg-name">' + esc(s.name) + '</span>' + latest + '</button>';
    }).join('');
  }

  function legendKey (e) {
    var b = e.target.closest ? e.target.closest('.lg-item') : null;
    return b ? b.getAttribute('data-key') : null;
  }

  function onLegendClick (e) {
    var k = legendKey(e);
    if (!k || !cfg.legend.interactive) return;
    hidden[k] = !hidden[k];
    paint();
    setHover(k);
  }

  /** Fades every series except `key` (legend hover). */
  function setHover (key) {
    if (key === hoverKey) return;
    hoverKey = key;
    var dim = cfg && cfg.chart.hoverDim && key && !hidden[key];
    Array.prototype.forEach.call(el.svg.querySelectorAll('[data-key]'), function (n) {
      n.classList.toggle('is-dim', !!dim && n.getAttribute('data-key') !== key);
    });
  }

  // ---------------------------------------------------------------------------
  // Chart helpers
  // ---------------------------------------------------------------------------
  var measureCtx = null;
  function textWidth (text, size, weight, family) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = (weight || 400) + ' ' + size + 'px ' + Lc.fontStack(family);
    return measureCtx.measureText(String(text)).width;
  }

  function ellipsize (text, width, size, weight, family) {
    if (textWidth(text, size, weight, family) <= width) return text;
    var t = String(text).replace(/…$/, '');
    while (t.length > 1 && textWidth(t + '…', size, weight, family) > width) t = t.slice(0, -1);
    return t + '…';
  }

  function niceStep (raw) {
    if (!(raw > 0) || !isFinite(raw)) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; // 1-2-5 steps keep K/M tick labels exact
  }

  /**
   * Axis range and ticks for a set of values and an axis' settings.
   * `hasArea`: areas fill down to zero, so an automatic axis includes zero.
   * `pct`: 100% stacked areas → fixed 0–100%.
   */
  function scaleFor (a, values, hasArea, pct) {
    var count = Math.max(2, Math.min(12, Number(a.ticks) || 5));
    if (pct) {
      var st = niceStep(1 / count);
      var tk = [];
      for (var p = 0; p <= 1 + 1e-9; p += st) tk.push(Math.round(p * 1e9) / 1e9);
      return { min: 0, max: 1, step: st, ticks: tk };
    }
    var vals = values.filter(function (v) { return isFinite(v); });
    if (!vals.length) vals = [0, 1];
    var lo = Math.min.apply(null, vals);
    var hi = Math.max.apply(null, vals);
    var base = a.base === 'auto' && hasArea ? 'zero' : a.base;

    if (base === 'zero') {
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    } else if (base === 'auto') {
      var range = hi - lo || Math.abs(hi) * 0.2 || 1;
      var pad = Math.max(0, Number(a.padding) || 0) / 100 * range;
      lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
      hi = hi <= 0 ? Math.min(0, hi + pad) : hi + pad;
    } else {
      lo = Number(a.manualMin) || 0;
      hi = Math.max(hi, lo);
    }
    if (a.maxMode === 'manual' && Number(a.manualMax) > lo) hi = Number(a.manualMax);
    if (hi === lo) hi = lo + 1;

    var step = niceStep((hi - lo) / count);
    var min = base === 'manual' ? lo : Math.floor(lo / step + 1e-9) * step;
    var max = a.maxMode === 'manual' ? hi : Math.ceil(hi / step - 1e-9) * step;
    if (max <= min) max = min + step;
    var ticks = [];
    for (var t = Math.ceil(min / step - 1e-9) * step; t <= max + step * 1e-6; t += step) {
      ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    }
    return { min: min, max: max, step: step, ticks: ticks };
  }

  /** Tick label texts, adding decimals until they are distinct (1.2K, 1.4K rather than 1K, 1K). */
  function tickTexts (a, sc, pct) {
    if (pct) return sc.ticks.map(function (t) { return Math.round(t * 100) + '%'; });
    var af = a.useGlobalFormat ? cfg.format : a.fmt;
    var maxTick = Math.max.apply(null, sc.ticks.map(Math.abs));
    var force = af.scale === 'dynamic' ? Lc.pickScale(maxTick, 'dynamic')
      : af.scale === 'percentDynamic' ? Lc.pickScale(af.pctFromRatio ? maxTick * 100 : maxTick, 'dynamic') : null;
    var out;
    var use = Lc.clone(af);
    use.plusSign = false;
    for (var d = af.decimals; d <= Math.max(af.decimals, 4); d++) {
      use.decimals = d;
      out = sc.ticks.map(function (t) { return t === 0 ? '0' : Lc.formatNumber(t, use, { forceScale: force }); });
      var uniq = {};
      out.forEach(function (t) { uniq[t] = 1; });
      if (Object.keys(uniq).length === out.length || af.scale === 'workbook') break;
    }
    return out;
  }

  function node (tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] != null && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  function lineAttrs (l, crisp) {
    var o = { stroke: l.color, 'stroke-width': l.width, 'stroke-dasharray': Lc.dashArray(l.style, l.width) };
    if (crisp !== false) o['shape-rendering'] = 'crispEdges';
    return o;
  }

  function pt (p) { return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }

  function straightPath (pts) {
    return pts.map(function (p, i) { return (i ? 'L' : 'M') + pt(p); }).join('');
  }

  /** Step after: horizontal to the next x, then vertical. */
  function stepPoints (pts) {
    var out = [];
    pts.forEach(function (p, i) {
      if (i) out.push([p[0], pts[i - 1][1]]);
      out.push(p);
    });
    return out;
  }

  /**
   * Monotone cubic interpolation (Fritsch–Carlson): smooth, passes through
   * every point, never overshoots the real highs and lows. Same as KPI Card.
   */
  function smoothPath (pts) {
    var n = pts.length;
    if (n < 3) return straightPath(pts);
    var dx = [];
    var slope = [];
    var i;
    for (i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      slope[i] = dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i];
    }
    var m = [slope[0]];
    for (i = 1; i < n - 1; i++) m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
    m[n - 1] = slope[n - 2];
    for (i = 0; i < n - 1; i++) {
      if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      var a = m[i] / slope[i];
      var c = m[i + 1] / slope[i];
      var s = a * a + c * c;
      if (s > 9) { var t = 3 / Math.sqrt(s); m[i] = t * a * slope[i]; m[i + 1] = t * c * slope[i]; }
    }
    var d = 'M' + pt(pts[0]);
    for (i = 0; i < n - 1; i++) {
      var h3 = dx[i] / 3;
      d += 'C' + (pts[i][0] + h3).toFixed(2) + ' ' + (pts[i][1] + m[i] * h3).toFixed(2) + ' ' +
        (pts[i + 1][0] - h3).toFixed(2) + ' ' + (pts[i + 1][1] - m[i + 1] * h3).toFixed(2) + ' ' + pt(pts[i + 1]);
    }
    return d;
  }

  function curvePath (pts, curve) {
    if (curve === 'step') return straightPath(stepPoints(pts));
    if (curve === 'smooth') return smoothPath(pts);
    return straightPath(pts);
  }

  /**
   * Splits point indexes into drawable runs: consecutive points with a value.
   * `connect` joins across missing values instead of leaving a gap.
   */
  function runsOf (ok, n, connect) {
    var runs = [];
    var cur = [];
    for (var i = 0; i < n; i++) {
      if (ok(i)) cur.push(i);
      else if (!connect && cur.length) { runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    return runs;
  }

  /** Indexes of the points that get a marker / a value label. */
  function pickPoints (mode, vals) {
    var idx = [];
    var fin = [];
    vals.forEach(function (v, i) { if (isFinite(v)) fin.push(i); });
    if (!fin.length || mode === 'none') return idx;
    if (mode === 'all') return fin;
    if (mode === 'last') return [fin[fin.length - 1]];
    if (mode === 'firstlast') return fin.length > 1 ? [fin[0], fin[fin.length - 1]] : [fin[0]];
    if (mode === 'minmax') {
      var lo = fin[0];
      var hi = fin[0];
      fin.forEach(function (i) { if (vals[i] < vals[lo]) lo = i; if (vals[i] > vals[hi]) hi = i; });
      return lo === hi ? [hi] : [lo, hi];
    }
    return idx;
  }

  function median (a) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  var REF_NAMES = { constant: 'Target', average: 'Average', median: 'Median', min: 'Min', max: 'Max', last: 'Latest' };

  /** Reference lines with their values: [{ r, v, axis, text }]. */
  function computeRefs (list, act) {
    return (cfg.refs || []).map(function (raw) { return Lc.refCfg(raw); }).filter(function (r) { return r.show; }).map(function (r) {
      var axis = r.axis === 'right' ? 'right' : 'left';
      var v;
      if (r.kind === 'constant') {
        v = Number(r.value);
      } else {
        var src = r.series ? list.filter(function (s) { return s.key === r.series; })
          : act.filter(function (s) { return s.axis === axis; });
        if (r.series && src[0]) {
          var on = act.find(function (s) { return s.key === r.series; });
          if (on) axis = on.axis;
        }
        var vals = [];
        src.forEach(function (s) { s.vals.forEach(function (x) { if (isFinite(x)) vals.push(x); }); });
        if (!vals.length) return null;
        if (r.kind === 'average') v = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        else if (r.kind === 'median') v = median(vals);
        else if (r.kind === 'min') v = Math.min.apply(null, vals);
        else if (r.kind === 'max') v = Math.max.apply(null, vals);
        else if (r.kind === 'last') { var s0 = src[0]; var li = lastIndex(s0.vals); v = li >= 0 ? s0.vals[li] : NaN; }
      }
      if (!isFinite(v)) return null;
      var name = r.label || REF_NAMES[r.kind] || 'Reference';
      return { r: r, v: v, axis: axis, text: name + (r.showValue ? ' ' + fmt(v) : '') };
    }).filter(Boolean);
  }

  function zeros (n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------
  function drawChart (list) {
    var svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    view = null;
    hoverKey = null;
    var W = Math.max(1, el.plot.clientWidth);
    var H = Math.max(1, el.plot.clientHeight);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (W < 60 || H < 50) return;

    var family = cfg.numbers.font;
    var n = model.xs.length;
    var mode = cfg.areas.mode;
    var missing = cfg.chart.missing;
    var B = cfg.band;
    var F = cfg.forecast;
    var ax = cfg.axisX;
    var aL = cfg.axisY;
    var aR = cfg.axisY2;
    var Ln = cfg.lines;
    var byKey = {};
    list.forEach(function (s) { byKey[s.key] = s; });
    var bandDefined = bandActive(list);
    var bandOn = bandDefined && !hidden.__band;
    var bl = bandDefined ? byKey[B.lower] : null;
    var bu = bandDefined ? byKey[B.upper] : null;

    // ---- series to draw, their axis and stacked values ----------------------
    var act = list.filter(function (s) {
      if (s.sc.type === 'hidden' || hidden[s.key]) return false;
      if (bandDefined && B.hideLines && (s.key === B.lower || s.key === B.upper)) return false;
      return true;
    });
    var anyArea = act.some(function (s) { return s.sc.type === 'area'; });
    var pctLeft = mode === 'percent' && anyArea;
    act.forEach(function (s) {
      s.isArea = s.sc.type === 'area';
      s.axis = s.sc.axis === 'right' ? 'right' : 'left';
      // 100% areas take the left axis; lines move to the right one.
      if (pctLeft) s.axis = s.isArea ? 'left' : 'right';
      s.v = s.vals.map(function (v) { return isFinite(v) ? v : (missing === 'zero' ? 0 : NaN); });
      s.y0 = null;
      s.y1 = s.v;
      s.stacked = false;
    });
    ['left', 'right'].forEach(function (side) {
      var areas = act.filter(function (s) { return s.isArea && s.axis === side; });
      if (!areas.length) return;
      if (mode === 'overlay') { areas.forEach(function (s) { s.y0 = zeros(n); }); return; }
      var pos = zeros(n);
      var neg = zeros(n);
      var tot = zeros(n);
      if (mode === 'percent') {
        areas.forEach(function (s) { s.v.forEach(function (v, i) { if (isFinite(v)) tot[i] += Math.abs(v); }); });
      }
      areas.forEach(function (s) {
        s.y0 = [];
        s.y1 = [];
        s.v.forEach(function (v, i) {
          var val = isFinite(v) ? v : 0;
          if (mode === 'percent') val = tot[i] ? Math.abs(val) / tot[i] : 0;
          var base = val >= 0 ? pos : neg;
          s.y0[i] = base[i];
          s.y1[i] = base[i] + val;
          base[i] += val;
        });
        s.stacked = true;
      });
    });
    var bandSide = bl && (bl.sc.axis === 'right' || pctLeft) ? 'right' : 'left';
    var refs = computeRefs(list, act);
    refs.forEach(function (rf) { if (pctLeft && rf.axis === 'left') rf.axis = 'right'; });

    // ---- scales -------------------------------------------------------------
    var vals = { left: [], right: [] };
    act.forEach(function (s) {
      s.y1.forEach(function (v) { vals[s.axis].push(v); });
      if (s.y0) s.y0.forEach(function (v) { vals[s.axis].push(v); });
    });
    if (bandOn) [bl, bu].forEach(function (s) { s.vals.forEach(function (v) { vals[bandSide].push(v); }); });
    refs.forEach(function (rf) { vals[rf.axis].push(rf.v); });
    var onSide = function (side) {
      return act.some(function (s) { return s.axis === side; }) || (bandOn && bandSide === side) ||
        refs.some(function (rf) { return rf.axis === side; });
    };
    var useRight = onSide('right');
    var useLeft = onSide('left') || !useRight;
    var areaOn = function (side) { return act.some(function (s) { return s.isArea && s.axis === side; }); };
    var scL = useLeft ? scaleFor(aL, vals.left, areaOn('left'), pctLeft) : null;
    var scR = useRight ? scaleFor(aR, vals.right, areaOn('right'), false) : null;

    // ---- margins ------------------------------------------------------------
    var showL = !!scL && aL.show;
    var showR = !!scR && aR.show;
    var txL = showL ? tickTexts(aL, scL, pctLeft) : [];
    var txR = showR ? tickTexts(aR, scR, false) : [];
    var maxW = function (arr, a) { return arr.length ? Math.max.apply(null, arr.map(function (t) { return textWidth(t, a.size, a.weight, a.font); })) : 0; };
    var titleL = showL && aL.title ? aL.size + 6 : 0;
    var titleR = showR && aR.title ? aR.size + 6 : 0;
    var left = showL ? Math.ceil(maxW(txL, aL)) + 8 + titleL : 6;
    var right = showR ? Math.ceil(maxW(txR, aR)) + 8 + titleR : 6;

    var lastRoom = 0;
    var top = 8;
    act.forEach(function (s) {
      var sc = s.sc;
      if (sc.labels === 'last') {
        var li = lastIndex(s.vals);
        if (li >= 0) lastRoom = Math.max(lastRoom, textWidth(fmt(s.vals[li], s.fvs[li]), sc.labelSize, sc.labelWeight, family) + sc.markerSize + 10);
      } else if (sc.labels !== 'none') {
        top = Math.max(top, sc.labelSize + 10);
      }
    });
    if (refs.length) top = Math.max(top, Math.max.apply(null, refs.map(function (rf) { return rf.r.size; })) + 6);

    var plotW = Math.max(20, W - left - right - lastRoom);
    var inset = n > 1 ? Math.min(14, plotW / (2 * (n - 1))) : 0;
    var useTime = cfg.chart.xSpacing === 'time' && model.hasTime;
    var t0 = useTime ? model.xs[0].t : 0;
    var t1 = useTime ? model.xs[n - 1].t : 1;
    var xpx = model.xs.map(function (x, i) {
      if (n === 1) return left + plotW / 2;
      var f = useTime ? (x.t - t0) / ((t1 - t0) || 1) : i / (n - 1);
      return left + inset + f * (plotW - 2 * inset);
    });

    // ---- horizontal axis labels ---------------------------------------------
    var labels = model.xs.map(function (x) { return x.label; });
    var xText = [];
    var xW = [];
    var shown = [];
    var xlH = 0;
    var orient = ax.orientation;
    if (ax.show && model.hasDate) {
      var maxLen = Math.max(40, Math.min(180, H * 0.3, W * 0.3));
      xText = labels.map(function (l) { return ellipsize(l, maxLen, ax.size, ax.weight, ax.font); });
      xW = xText.map(function (t) { return textWidth(t, ax.size, ax.weight, ax.font); });
      var centre = function (k) { return Math.max(xW[k] / 2 + 1, Math.min(W - xW[k] / 2 - 1, xpx[k])); };
      // Keep the last point labelled, then every label that fits to its left.
      var kept = null;
      for (var i = n - 1; i >= 0; i--) {
        var fits = kept == null || (orient === 'auto'
          ? centre(kept) - centre(i) >= (xW[kept] + xW[i]) / 2 + 10
          : xpx[kept] - xpx[i] >= ax.size * 1.5);
        if (fits) { shown.push(i); kept = i; }
      }
      var shownW = shown.length ? Math.max.apply(null, shown.map(function (k) { return xW[k]; })) : 0;
      xlH = orient === 'auto' ? ax.size + 8 : orient === 'angled' ? shownW * 0.7071 + ax.size * 0.8 + 8 : shownW + 10;
    }
    var xTitleH = ax.show && ax.title ? ax.size + 8 : 0;
    var plotH = H - top - xlH - xTitleH;
    if (plotH < 30) { xlH = 0; shown = []; xTitleH = 0; plotH = H - top - 4; }
    var bottomY = top + plotH;

    var yOf = function (sc) {
      return function (v) { return top + (sc.max - v) / (sc.max - sc.min) * plotH; };
    };
    var yL = scL ? yOf(scL) : null;
    var yR = scR ? yOf(scR) : null;
    var Y = function (side) { return side === 'right' ? (yR || yL) : (yL || yR); };

    // ---- layers -------------------------------------------------------------
    var defs = node('defs');
    svg.appendChild(defs);
    var clipId = 'lc-clip';
    var cp = node('clipPath', { id: clipId });
    cp.appendChild(node('rect', { x: left - 8, y: top - 1, width: plotW + 16, height: plotH + 2 }));
    defs.appendChild(cp);
    var clip = 'url(#' + clipId + ')';

    var gBack = node('g'), gGrid = node('g'), gAreas = node('g'), gBand = node('g'), gLines = node('g'),
      gRefs = node('g'), gMarks = node('g'), gLabels = node('g'), gAxes = node('g'), gHover = node('g', { 'pointer-events': 'none' });
    [gBack, gGrid, gAreas, gBand, gLines, gRefs, gMarks, gLabels, gAxes, gHover].forEach(function (g) { svg.appendChild(g); });
    var halo = { 'paint-order': 'stroke', stroke: '#FFFFFF', 'stroke-width': 3, 'stroke-linejoin': 'round' };
    var withHalo = function (o) { Object.keys(halo).forEach(function (k) { o[k] = halo[k]; }); return o; };

    // forecast shading
    var fIdx = F.show && F.from ? labels.indexOf(F.from) : -1;
    if (fIdx >= 0 && F.shade) {
      var fx = fIdx > 0 ? (xpx[fIdx - 1] + xpx[fIdx]) / 2 : left;
      gBack.appendChild(node('rect', { x: fx, y: top, width: Math.max(0, left + plotW - fx), height: plotH, fill: F.shadeColor }));
      if (F.label) {
        gBack.appendChild(node('text', {
          x: fx + 6, y: top + 12, fill: F.labelColor, 'font-size': 10, 'font-weight': 600, 'font-family': Lc.fontStack(family)
        }, F.label));
      }
    }

    // gridlines
    var gridSc = scL || scR;
    var gridY = Y(scL ? 'left' : 'right');
    if (Ln.hGrid.show) {
      gridSc.ticks.forEach(function (t) {
        var yy = Math.round(gridY(t)) + 0.5;
        gGrid.appendChild(node('line', Object.assign({ x1: left, x2: left + plotW, y1: yy, y2: yy }, lineAttrs(Ln.hGrid))));
      });
    }
    if (Ln.vGrid.show) {
      shown.forEach(function (i) {
        var xx = Math.round(xpx[i]) + 0.5;
        gGrid.appendChild(node('line', Object.assign({ x1: xx, x2: xx, y1: top, y2: bottomY }, lineAttrs(Ln.vGrid))));
      });
    }
    if (Ln.zero.show && !pctLeft && gridSc.min < 0 && gridSc.max > 0) {
      var zy = Math.round(gridY(0)) + 0.5;
      gGrid.appendChild(node('line', Object.assign({ x1: left, x2: left + plotW, y1: zy, y2: zy }, lineAttrs(Ln.zero))));
    }

    // ---- areas --------------------------------------------------------------
    act.filter(function (s) { return s.isArea; }).forEach(function (s) {
      var yf = Y(s.axis);
      var op = Math.max(0, Math.min(100, Number(cfg.areas.opacity) || 0)) / 100;
      var fill = s.color;
      var fillOp = op;
      if (cfg.areas.gradient) {
        var gid = 'lc-grad-' + s.i;
        var lg = node('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
        lg.appendChild(node('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': Math.min(1, op * 1.35) }));
        lg.appendChild(node('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': op * 0.25 }));
        defs.appendChild(lg);
        fill = 'url(#' + gid + ')';
        fillOp = null;
      }
      var runs = runsOf(function (i) { return isFinite(s.y1[i]); }, n, missing === 'connect');
      runs.forEach(function (run) {
        var topPts = run.map(function (i) { return [xpx[i], yf(s.y1[i])]; });
        var botPts = run.map(function (i) { return [xpx[i], yf(s.y0[i])]; });
        var c = s.sc.curve;
        var dBot = c === 'step' ? straightPath(stepPoints(botPts).reverse()) : curvePath(botPts.slice().reverse(), c);
        gAreas.appendChild(node('path', {
          d: curvePath(topPts, c) + 'L' + dBot.slice(1) + 'Z', fill: fill, 'fill-opacity': fillOp, 'data-key': s.key, 'clip-path': clip
        }));
      });
    });

    // ---- band between two measures ------------------------------------------
    if (bandOn) {
      var yb = Y(bandSide);
      var bc = Lc.normalizeHex(B.color) || '#2F4B7C';
      runsOf(function (i) { return isFinite(bl.vals[i]) && isFinite(bu.vals[i]); }, n, missing === 'connect').forEach(function (run) {
        var up = run.map(function (i) { return [xpx[i], yb(bu.vals[i])]; });
        var lo = run.map(function (i) { return [xpx[i], yb(bl.vals[i])]; });
        gBand.appendChild(node('path', {
          d: straightPath(up) + 'L' + straightPath(lo.slice().reverse()).slice(1) + 'Z',
          fill: bc, 'fill-opacity': Math.max(0, Math.min(100, B.opacity)) / 100, 'data-key': '__band', 'clip-path': clip
        }));
        if (B.edges) {
          [up, lo].forEach(function (pts) {
            gBand.appendChild(node('path', {
              d: straightPath(pts), fill: 'none', stroke: bc, 'stroke-width': 1, 'stroke-opacity': 0.7,
              'stroke-dasharray': '3,3', 'data-key': '__band', 'clip-path': clip
            }));
          });
        }
      });
    }

    // ---- lines ----------------------------------------------------------------
    act.forEach(function (s) {
      if (s.isArea && !cfg.areas.outline) return;
      var yf = Y(s.axis);
      var sc = s.sc;
      var dashFrom = n; // first point of the dashed part
      if (fIdx >= 0 && F.dash) dashFrom = Math.max(0, fIdx - 1);
      var dl = Math.max(0, Math.round(Number(sc.dashLast) || 0));
      if (dl > 0) dashFrom = Math.min(dashFrom, Math.max(0, n - 1 - dl));
      var attrs = function (dashed) {
        var o = {
          fill: 'none', stroke: s.color, 'stroke-width': sc.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          'data-key': s.key, 'clip-path': clip
        };
        var st = dashed ? (sc.style === 'dashed' ? 'dotted' : 'dashed') : sc.style;
        var da = Lc.dashArray(st, sc.width);
        if (da) { o['stroke-dasharray'] = da; o['stroke-linecap'] = 'butt'; }
        return o;
      };
      runsOf(function (i) { return isFinite(s.y1[i]); }, n, missing === 'connect').forEach(function (run) {
        var solid = run.filter(function (i) { return i <= dashFrom; });
        var dashed = run.filter(function (i) { return i >= dashFrom; });
        var toPts = function (idx) { return idx.map(function (i) { return [xpx[i], yf(s.y1[i])]; }); };
        if (solid.length > 1) { var a1 = attrs(false); a1.d = curvePath(toPts(solid), sc.curve); gLines.appendChild(node('path', a1)); }
        if (dashed.length > 1) { var a2 = attrs(true); a2.d = curvePath(toPts(dashed), sc.curve); gLines.appendChild(node('path', a2)); }
      });
    });

    // ---- reference lines ----------------------------------------------------
    refs.forEach(function (rf) {
      var r = rf.r;
      var yy = Y(rf.axis)(rf.v);
      if (yy < top - 0.5 || yy > bottomY + 0.5) return;
      yy = Math.round(yy) + 0.5;
      gRefs.appendChild(node('line', Object.assign({ x1: left, x2: left + plotW, y1: yy, y2: yy }, lineAttrs(r))));
      var ty = yy - r.size * 0.45 < top + 2 ? yy + r.size + 3 : yy - 4;
      gRefs.appendChild(node('text', withHalo({
        x: r.labelPos === 'left' ? left + 3 : left + plotW - 3, y: ty, 'text-anchor': r.labelPos === 'left' ? 'start' : 'end',
        fill: r.color, 'font-size': r.size, 'font-weight': r.weight, 'font-family': Lc.fontStack(family)
      }), rf.text));
    });

    // ---- markers and value labels -------------------------------------------
    var lastLabs = [];
    act.forEach(function (s) {
      var yf = Y(s.axis);
      var sc = s.sc;
      var mk = pickPoints(sc.markers, s.v);
      for (var i = 0; i < n; i++) {
        // single values between gaps get a dot so they don't disappear
        if (!s.stacked && isFinite(s.y1[i]) && !isFinite(s.y1[i - 1]) && !isFinite(s.y1[i + 1]) && mk.indexOf(i) < 0 &&
          (missing !== 'connect' || n === 1)) mk.push(i);
      }
      mk.forEach(function (k) {
        if (!isFinite(s.y1[k])) return;
        gMarks.appendChild(node('circle', {
          cx: xpx[k], cy: yf(s.y1[k]), r: Math.max(1.5, sc.markerSize), fill: s.color, stroke: '#FFFFFF', 'stroke-width': 1.25, 'data-key': s.key
        }));
      });
      var lc = sc.labelColorMode === 'custom' ? sc.labelColor : s.color;
      var lb = pickPoints(sc.labels, s.v);
      var lo = lb.length > 1 && sc.labels === 'minmax' ? lb[0] : -1;
      lb.forEach(function (k) {
        if (!isFinite(s.y1[k])) return;
        var text = fmt(s.vals[k], s.fvs[k]);
        var yy = yf(s.y1[k]);
        if (sc.labels === 'last') {
          lastLabs.push({ key: s.key, text: text, x: xpx[k] + sc.markerSize + 5, y: yy, color: lc, size: sc.labelSize, weight: sc.labelWeight });
          return;
        }
        var w = textWidth(text, sc.labelSize, sc.labelWeight, family);
        var cx = Math.max(w / 2 + 1, Math.min(W - w / 2 - 1, xpx[k]));
        gLabels.appendChild(node('text', withHalo({
          x: cx, y: k === lo ? yy + sc.labelSize + 6 : yy - sc.markerSize - 4, 'text-anchor': 'middle', fill: lc,
          'font-size': sc.labelSize, 'font-weight': sc.labelWeight, 'font-family': Lc.fontStack(family), 'data-key': s.key
        }), text));
      });
    });
    // last-value labels: spread so they don't overlap
    lastLabs.sort(function (a, b) { return a.y - b.y; });
    for (var q = 1; q < lastLabs.length; q++) {
      var minGap = (lastLabs[q - 1].size + lastLabs[q].size) / 2 + 2;
      if (lastLabs[q].y - lastLabs[q - 1].y < minGap) lastLabs[q].y = lastLabs[q - 1].y + minGap;
    }
    for (var q2 = lastLabs.length - 1; q2 >= 0; q2--) {
      var lim = q2 === lastLabs.length - 1 ? bottomY - lastLabs[q2].size / 2 : lastLabs[q2 + 1].y - (lastLabs[q2].size + lastLabs[q2 + 1].size) / 2 - 2;
      if (lastLabs[q2].y > lim) lastLabs[q2].y = lim;
    }
    lastLabs.forEach(function (lb) {
      gLabels.appendChild(node('text', withHalo({
        x: lb.x, y: lb.y, dy: '0.35em', 'text-anchor': 'start', fill: lb.color, 'font-size': lb.size, 'font-weight': lb.weight,
        'font-family': Lc.fontStack(family), 'data-key': lb.key
      }), lb.text));
    });

    // ---- axes ---------------------------------------------------------------
    var axisText = function (a, attrs, text) {
      attrs.fill = a.color;
      attrs['font-size'] = a.size;
      attrs['font-weight'] = a.weight;
      attrs['font-family'] = Lc.fontStack(a.font);
      gAxes.appendChild(node('text', attrs, text));
    };
    if (showL) {
      scL.ticks.forEach(function (t, k) {
        axisText(aL, { x: left - 6, y: yL(t), dy: '0.32em', 'text-anchor': 'end' }, txL[k]);
      });
      if (aL.title) {
        axisText(aL, { x: 0, y: 0, 'text-anchor': 'middle', transform: 'translate(' + (aL.size * 0.8) + ',' + (top + plotH / 2) + ') rotate(-90)' }, aL.title);
      }
      if (aL.showLine) gAxes.appendChild(node('line', { x1: left + 0.5, x2: left + 0.5, y1: top, y2: bottomY, stroke: aL.lineColor, 'shape-rendering': 'crispEdges' }));
    }
    if (showR) {
      var rx = left + plotW + lastRoom;
      scR.ticks.forEach(function (t, k) {
        axisText(aR, { x: rx + 6, y: yR(t), dy: '0.32em', 'text-anchor': 'start' }, txR[k]);
      });
      if (aR.title) {
        axisText(aR, { x: 0, y: 0, 'text-anchor': 'middle', transform: 'translate(' + (W - aR.size * 0.8) + ',' + (top + plotH / 2) + ') rotate(90)' }, aR.title);
      }
      if (aR.showLine) gAxes.appendChild(node('line', { x1: left + plotW + 0.5, x2: left + plotW + 0.5, y1: top, y2: bottomY, stroke: aR.lineColor, 'shape-rendering': 'crispEdges' }));
    }
    if (ax.showLine) {
      var by = Math.round(bottomY) + 0.5;
      gAxes.appendChild(node('line', { x1: left, x2: left + plotW, y1: by, y2: by, stroke: ax.lineColor, 'stroke-width': ax.lineWidth, 'shape-rendering': 'crispEdges' }));
    }
    shown.forEach(function (i) {
      if (ax.ticks) {
        var tx = Math.round(xpx[i]) + 0.5;
        gAxes.appendChild(node('line', { x1: tx, x2: tx, y1: bottomY, y2: bottomY + 4, stroke: ax.lineColor, 'shape-rendering': 'crispEdges' }));
      }
      if (orient === 'auto') {
        var cx = Math.max(xW[i] / 2 + 1, Math.min(W - xW[i] / 2 - 1, xpx[i]));
        axisText(ax, { x: cx, y: bottomY + 5 + ax.size * 0.85, 'text-anchor': 'middle' }, xText[i]);
      } else {
        var deg = orient === 'angled' ? -45 : -90;
        axisText(ax, {
          x: 0, y: 0, 'text-anchor': 'end', dy: orient === 'angled' ? '0.6em' : '0.35em',
          transform: 'translate(' + xpx[i].toFixed(1) + ',' + (bottomY + 6) + ') rotate(' + deg + ')'
        }, xText[i]);
      }
    });
    if (xTitleH) axisText(ax, { x: left + plotW / 2, y: H - 3, 'text-anchor': 'middle' }, ax.title);

    view = {
      xpx: xpx, top: top, bottomY: bottomY, left: left, plotW: plotW, gHover: gHover, mode: mode,
      act: act.map(function (s) {
        var yf = Y(s.axis);
        return {
          s: s,
          py: s.y1.map(function (v) { return isFinite(v) ? yf(v) : NaN; }),
          py0: s.isArea && s.y0 ? s.y0.map(function (v) { return isFinite(v) ? yf(v) : NaN; }) : null
        };
      }),
      band: bandOn ? { lower: bl, upper: bu } : null
    };
  }

  // ---------------------------------------------------------------------------
  // Hover: crosshair + tooltip with every series at that point
  // ---------------------------------------------------------------------------
  function mousePos (e) {
    var r = el.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function nearestIndex (mx) {
    var xs = view.xpx;
    var best = 0;
    for (var i = 1; i < xs.length; i++) if (Math.abs(xs[i] - mx) < Math.abs(xs[best] - mx)) best = i;
    return best;
  }

  function inPlot (m) {
    return view && m.x >= view.left - 20 && m.x <= view.left + view.plotW + 20 && m.y >= view.top - 12 && m.y <= view.bottomY + 12;
  }

  /** The series drawn closest to the mouse (vertically, at the nearest point). */
  function seriesFromEvent (e) {
    if (!view) return null;
    var m = mousePos(e);
    if (!inPlot(m)) return null;
    var i = nearestIndex(m.x);
    var best = null;
    view.act.forEach(function (a) {
      var py = a.py[i];
      if (!isFinite(py)) return;
      var d = Math.abs(py - m.y);
      // inside a filled area counts as on it
      if (a.py0 && isFinite(a.py0[i]) && m.y >= Math.min(py, a.py0[i]) && m.y <= Math.max(py, a.py0[i])) d = Math.min(d, 6);
      if (!best || d < best.d) best = { d: d, s: a.s };
    });
    return best && best.d < 60 ? best.s : null;
  }

  function onHover (e) {
    if (!view || !cfg || el.menu.style.display === 'block') return;
    var m = mousePos(e);
    if (!inPlot(m)) { hideTooltip(); clearCrosshair(); return; }
    var i = nearestIndex(m.x);
    drawCrosshair(i);
    if (cfg.chart.tooltip) showTooltip(i, e); else hideTooltip();
  }

  function clearCrosshair () {
    if (view && view.gHover) while (view.gHover.firstChild) view.gHover.removeChild(view.gHover.firstChild);
  }

  function drawCrosshair (i) {
    clearCrosshair();
    var g = view.gHover;
    var x = Math.round(view.xpx[i]) + 0.5;
    var ch = cfg.lines.crosshair;
    if (ch.show) g.appendChild(node('line', Object.assign({ x1: x, x2: x, y1: view.top, y2: view.bottomY }, lineAttrs(ch))));
    view.act.forEach(function (a) {
      if (!isFinite(a.py[i]) || !isFinite(a.s.vals[i])) return;
      g.appendChild(node('circle', { cx: view.xpx[i], cy: a.py[i], r: Math.max(3.5, a.s.sc.width + 2), fill: a.s.color, stroke: '#FFFFFF', 'stroke-width': 2 }));
    });
  }

  function showTooltip (i, e) {
    var x = model.xs[i];
    var rows = view.act.filter(function (a) { return isFinite(a.s.vals[i]); }).map(function (a) {
      var share = view.mode === 'percent' && a.s.stacked ? a.s.y1[i] - a.s.y0[i] : null;
      return { name: a.s.name, color: a.s.color, v: a.s.vals[i], fv: a.s.fvs[i], share: share, area: a.s.isArea, stacked: a.s.stacked };
    });
    var sort = cfg.chart.tooltipSort;
    if (sort === 'valDesc') rows.sort(function (a, b) { return b.v - a.v; });
    else if (sort === 'valAsc') rows.sort(function (a, b) { return a.v - b.v; });

    var html = '<div class="tt-name">' + esc(x.label || model.xName || '') + '</div><div class="tt-rows">';
    html += rows.map(function (r) {
      return '<div class="tt-row"><span class="sw' + (r.area ? '' : ' sw--line') + '" style="background:' + r.color + '"></span><span class="nm">' +
        esc(r.name) + '</span><span class="vl">' + esc(fullText(r.v, r.fv)) +
        (r.share != null ? ' <span class="pc">' + esc(Lc.fixed(r.share * 100, 1)) + '%</span>' : '') + '</span></div>';
    }).join('');
    var stacked = rows.filter(function (r) { return r.stacked; });
    if (cfg.chart.tooltipTotal && stacked.length > 1) {
      var tot = stacked.reduce(function (s, r) { return s + r.v; }, 0);
      html += '<div class="tt-row tt-total"><span class="sw sw--none"></span><span class="nm">Total</span><span class="vl">' + esc(fullText(tot)) + '</span></div>';
    }
    if (view.band && isFinite(view.band.lower.vals[i]) && isFinite(view.band.upper.vals[i])) {
      html += '<div class="tt-row"><span class="sw sw--band" style="background:' + (Lc.normalizeHex(cfg.band.color) || '#2F4B7C') + '"></span><span class="nm">' +
        esc(cfg.band.label || 'Range') + '</span><span class="vl">' + esc(fullText(view.band.lower.vals[i], view.band.lower.fvs[i])) + ' – ' +
        esc(fullText(view.band.upper.vals[i], view.band.upper.fvs[i])) + '</span></div>';
    }
    html += '</div>';
    if (!rows.length && !view.band) { hideTooltip(); return; }

    var tt = el.tooltip;
    tt.innerHTML = html;
    tt.style.fontFamily = Lc.fontStack(cfg.numbers.font);
    tt.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var tw = tt.offsetWidth;
    var th = tt.offsetHeight;
    var left = e.clientX + 16;
    if (left + tw > vw - 4) left = e.clientX - tw - 16;
    var top = Math.min(Math.max(4, e.clientY - th / 2), vh - th - 4);
    tt.style.left = Math.max(4, left) + 'px';
    tt.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip () {
    if (el.tooltip) el.tooltip.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Right-click menu (viz extensions can't add to Tableau's own menu)
  // ---------------------------------------------------------------------------
  function onContextMenu (e) {
    if (!cfg || !cfg.chart.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    clearCrosshair();
    var key = legendKey(e);
    var s = null;
    if (key === '__band') s = { key: '__band', name: cfg.band.label || 'Range' };
    else if (key && model) s = resolveSeries().find(function (x) { return x.key === key; }) || null;
    else s = seriesFromEvent(e);

    var items = [];
    if (s && s.key === '__band') {
      items.push(['Format band…', { tab: 'refs' }], null);
    } else if (s) {
      items.push(['Format “' + s.name + '”…', { tab: 'series', item: s.key }]);
      items.push([(hidden[s.key] ? 'Show “' : 'Hide “') + s.name + '”', function () { hidden[s.key] = !hidden[s.key]; paint(); }], null);
    }
    items.push(
      ['Series…', { tab: 'series' }],
      ['Areas & stacking…', { tab: 'areas' }],
      ['Reference lines & band…', { tab: 'refs' }],
      ['Axes…', { tab: 'axes' }],
      ['Lines…', { tab: 'lines' }],
      ['Legend & tooltip…', { tab: 'legend' }],
      ['Numbers…', { tab: 'numbers' }],
      null
    );
    if (Object.keys(hidden).some(function (k) { return hidden[k]; })) {
      items.push(['Show all series', function () { hidden = {}; paint(); }]);
    }
    items.push(['Format extension…', null]);

    var m = el.menu;
    m.innerHTML = '';
    items.forEach(function (it) {
      if (!it) { m.appendChild(document.createElement('hr')); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', function () {
        if (typeof it[1] === 'function') { hideMenu(); it[1](); } else openDialog(it[1]);
      });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    m.style.left = Math.max(4, Math.min(e.clientX, vw - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(e.clientY, vh - m.offsetHeight - 4)) + 'px';
  }

  function hideMenu () {
    if (el.menu) el.menu.style.display = 'none';
  }

  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    view = null;
    el.hint.innerHTML = html;
  }

  window.LineChart = { init: init };
})();
