'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage (one set per sample data set), so the chart
 *   and the Format dialog (two frames) see each other's changes, like they do
 *   inside Tableau. Some data sets start with settings that show off a feature.
 * - Sample data: ?data=monthly | channels | forecast | daily | yearmonth | negative | single
 * - ?rename: the first measure pill is "renamed" (double-click → //New name):
 *   the Marks card reports a new name and the data column another name, as
 *   Tableau does for inline calculations.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var DS_KEY = 'lcMockData';
  var PAYLOAD_KEY = 'lcMockPayload';
  var RENAME = /[?&]rename\b/.test(location.search);

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function m (name) { return { name: name, id: '[' + name.replace(/^\w+\((.*)\)$/, '$1') + ']' }; }

  function cell (v, fmt) {
    return { value: v, nativeValue: v, formattedValue: fmt != null ? fmt : (typeof v === 'number' ? v.toLocaleString('en-US') : String(v)) };
  }

  /** n months starting Jan 2025 as discrete MONTH-YEAR cells. */
  function monthCells (n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var d = new Date(Date.UTC(2025, i, 1));
      out.push(cell(d, MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear()));
    }
    return out;
  }

  function wave (i, a, b, c) { return Math.sin(i * a + b) * c; }

  // Each data set: { dates: [field names], color: field|null, measures: [names],
  //                  rows: [[dateCells..., colorCell?, values...]], preset: settings }
  function monthly () {
    var mc = monthCells(24);
    return {
      dates: ['MY(Order Date)'],
      measures: ['SUM(Deposits)', 'SUM(Withdrawals)', 'SUM(Net Flow)', 'AVG(Active Customers)'],
      rows: mc.map(function (c, i) {
        var dep = 820 + i * 14 + wave(i, 0.9, 0.3, 60);
        var wd = 760 + i * 12 + wave(i, 0.7, 1.4, 70);
        return [c, dep, wd, dep - wd, 41200 + i * 520 + wave(i, 0.5, 0, 900)];
      }),
      preset: {
        series: {
          'SUM(Deposits)': { type: 'area' },
          'SUM(Withdrawals)': { type: 'area' },
          'SUM(Net Flow)': { labels: 'last', markers: 'last', width: 2.5 },
          'AVG(Active Customers)': { axis: 'right', style: 'dashed', width: 1.5 }
        },
        axisY: { title: 'SAR M' },
        axisY2: { title: 'Customers' },
        refs: [{ kind: 'average', series: 'SUM(Net Flow)', label: 'Avg net flow', color: '#0E7C66' }],
        title: { text: 'Deposits, withdrawals and net flow' },
        explanation: { text: 'Monthly, SAR M — customers on the right axis' }
      }
    };
  }

  function channels () {
    var mc = monthCells(18);
    var ch = [['App', 520, 18], ['Web', 260, 4], ['Branch', 180, -3], ['ATM', 140, -2]];
    var rows = [];
    mc.forEach(function (c, i) {
      ch.forEach(function (x, k) {
        rows.push([c, cell(x[0]), Math.max(5, x[1] + x[2] * i + wave(i, 0.8, k, 25))]);
      });
    });
    return {
      dates: ['MY(Txn Date)'],
      color: 'Channel',
      measures: ['SUM(Transactions)'],
      rows: rows,
      preset: { areas: { mode: 'stack' }, seriesDefaults: { type: 'area' }, legend: { showLatest: true }, title: { text: 'Transactions by channel' } }
    };
  }

  function forecast () {
    var mc = monthCells(24);
    return {
      dates: ['MY(Month)'],
      measures: ['SUM(Actual)', 'SUM(Forecast)', 'SUM(Forecast Low)', 'SUM(Forecast High)'],
      rows: mc.map(function (c, i) {
        var base = 1200 + i * 22 + wave(i, 1.1, 0.4, 45);
        var actual = i < 17 ? base : NaN;
        var fc = i >= 16 ? 1200 + i * 22 : NaN;
        var spread = i >= 16 ? (i - 15) * 18 : NaN;
        return [c, actual, fc, fc - spread, fc + spread];
      }),
      preset: {
        series: {
          'SUM(Actual)': { width: 2.5, markers: 'last', labels: 'last' },
          'SUM(Forecast)': { color: '#EB644C', style: 'dashed' }
        },
        band: { show: true, lower: 'SUM(Forecast Low)', upper: 'SUM(Forecast High)', label: 'Forecast range', color: '#EB644C' },
        forecast: { show: true, from: 'May 2026' },
        refs: [{ kind: 'constant', value: 1600, label: 'Target', color: '#0E7C66' }],
        title: { text: 'Balance: actual and forecast' }
      }
    };
  }

  function daily () {
    var rows = [];
    for (var i = 0; i < 120; i++) {
      if (i % 7 === 5 || i % 7 === 6) continue; // weekends missing
      var d = new Date(Date.UTC(2026, 5, 1 + i));
      rows.push([cell(d, (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear()),
        48e6 + i * 2.1e5 + wave(i, 0.4, 0, 3.2e6), 31e6 + i * 1.4e5 + wave(i, 0.3, 2, 2.6e6)]);
    }
    return {
      dates: ['MDY(Value Date)'],
      measures: ['SUM(SARIE Inflow)', 'SUM(SARIE Outflow)'],
      rows: rows,
      preset: { chart: { xSpacing: 'time' }, seriesDefaults: { curve: 'smooth' }, title: { text: 'Daily SARIE flows' } }
    };
  }

  function yearmonth () {
    var rows = [];
    [2025, 2026].forEach(function (y, yi) {
      for (var mo = 1; mo <= 12; mo++) {
        if (y === 2026 && mo > 9) break;
        var i = yi * 12 + mo;
        rows.push([cell(y, String(y)), cell(mo, MONTHS[mo - 1]), 0.42 + wave(i, 0.6, 0, 0.06) + i * 0.004, 0.31 + wave(i, 0.5, 1, 0.05)]);
      }
    });
    rows.reverse(); // Tableau's order isn't guaranteed; the chart sorts by date
    return {
      dates: ['MONTH(Date)', 'YEAR(Date)'],
      measures: ['AVG(Card Share)', 'AVG(Wallet Share)'],
      rows: rows.map(function (r) { return [r[1], r[0], r[2], r[3]]; }),
      preset: { format: { scale: 'percent', decimals: 1 }, axisY: { fmt: { scale: 'percent', decimals: 0 } }, seriesDefaults: { markers: 'all' } }
    };
  }

  function negative () {
    var mc = monthCells(15);
    return {
      dates: ['MY(Month)'],
      measures: ['SUM(Net Position)', 'SUM(FX Result)'],
      rows: mc.map(function (c, i) { return [c, wave(i, 0.7, 0, 90) + 10, wave(i, 0.45, 1, 40) - 15]; }),
      preset: { seriesDefaults: { labels: 'minmax', markers: 'minmax' } }
    };
  }

  function single () {
    return { dates: [], measures: ['SUM(Deposits)', 'SUM(Withdrawals)'], rows: [[1284.5, 961.2]] };
  }

  var DATASETS = { monthly: monthly, channels: channels, forecast: forecast, daily: daily, yearmonth: yearmonth, negative: negative, single: single };
  var dsName = params.get('data') || localStorage.getItem(DS_KEY) || 'monthly';
  if (!DATASETS[dsName]) dsName = 'monthly';
  var DS = DATASETS[dsName]();
  var SET_KEY = 'lcMockSettings:' + dsName;

  function pillName (name, j) { return RENAME && j === 0 ? 'Inflows (renamed)' : name; }

  function buildTable () {
    var columns = [];
    DS.dates.forEach(function (d) {
      columns.push({ fieldName: d, fieldId: '[' + d + ']', dataType: /^(YEAR|MONTH)\(/.test(d) ? 'int' : 'date', index: columns.length });
    });
    if (DS.color) columns.push({ fieldName: DS.color, fieldId: '[' + DS.color + ']', dataType: 'string', index: columns.length });
    DS.measures.forEach(function (ms, j) {
      var n = RENAME && j === 0 ? 'Calculation_4410' : ms;
      columns.push({ fieldName: n, fieldId: '[' + n + ']', dataType: 'float', index: columns.length });
    });
    var nd = DS.dates.length + (DS.color ? 1 : 0);
    var data = DS.rows.map(function (r) {
      return r.map(function (v, k) {
        if (k < nd) return v;
        return isFinite(v) ? cell(v) : cell(null, 'Null');
      });
    });
    return { columns: columns, data: data };
  }

  function encodings () {
    var enc = [];
    DS.dates.forEach(function (d) { enc.push({ id: 'date', field: m(d) }); });
    DS.measures.forEach(function (s, j) { enc.push({ id: 'measures', field: m(pillName(s, j)) }); });
    if (DS.color) enc.push({ id: 'color', field: m(DS.color) });
    return enc;
  }

  // ---- settings ----------------------------------------------------------
  function loadSettings () {
    try {
      var raw = localStorage.getItem(SET_KEY);
      if (raw == null && DS.preset) return { linechart1: JSON.stringify(DS.preset) };
      return JSON.parse(raw || '{}');
    } catch (e) { return {}; }
  }
  var pending = loadSettings();
  var settingsHandlers = [];
  window.addEventListener('storage', function (e) {
    if (e.key === SET_KEY) {
      pending = loadSettings();
      settingsHandlers.forEach(function (h) { h({}); });
    }
  });

  var configureFn = null;
  var dialogResolve = null;
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'lc-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'lc-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed' },
    DialogStyle: { Modeless: 'modeless' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
        return Promise.resolve();
      },
      initializeDialogAsync: function () {
        return Promise.resolve(localStorage.getItem(PAYLOAD_KEY) || '');
      },
      settings: {
        get: function (k) { return pending[k]; },
        set: function (k, v) { pending[k] = v; },
        getAll: function () { return pending; },
        saveAsync: function () {
          localStorage.setItem(SET_KEY, JSON.stringify(pending));
          // storage events don't fire in the frame that wrote, so notify it too
          settingsHandlers.forEach(function (h) { h({}); });
          return Promise.resolve();
        },
        addEventListener: function (type, h) { settingsHandlers.push(h); }
      },
      worksheetContent: {
        worksheet: {
          name: 'Mock sheet',
          addEventListener: function () {},
          getVisualSpecificationAsync: function () {
            return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: encodings() }] });
          },
          getSummaryDataReaderAsync: function () {
            var t = buildTable();
            return Promise.resolve({
              getAllPagesAsync: function () { return Promise.resolve(t); },
              releaseAsync: function () { return Promise.resolve(); }
            });
          }
        }
      },
      ui: {
        displayDialogAsync: function (url, payload) {
          localStorage.setItem(PAYLOAD_KEY, payload || '');
          var target = window.parent !== window ? window.parent : null;
          if (target) target.postMessage({ type: 'lc-open-dialog', url: url + (url.indexOf('?') >= 0 ? '&' : '?') + 'data=' + dsName }, '*');
          else window.open(url, 'lc-dialog', 'width=600,height=760');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'lc-close-dialog' }, '*');
          else window.close();
        }
      }
    }
  };
})();
