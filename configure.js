'use strict';

/**
 * Format dialog for the Line Chart extension ("Format Extension" on the
 * Marks card, or right-click / double-click in the chart or the legend).
 *
 * Every change is saved straight away (debounced), so the chart behind the
 * modeless dialog updates live. Cancel restores what was stored on open.
 * The chart passes the current series and axis labels as the dialog
 * payload, because a dialog can't read the worksheet.
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var activeTab = 'series';
  var shapeIndex = null;
  var info = { series: [], xs: [], hasTime: false, colorDim: '', focus: null };
  var selected = '__defaults';

  var WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']];
  var LINE_STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
  var REF_COLORS = ['#EB644C', '#0E7C66', '#2F4B7C', '#7A5195', '#B4431E'];

  var TABS = [
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'series', label: 'Series', build: buildSeriesTab, keys: ['seriesDefaults', 'series', 'chart.palette', 'chart.missing', 'chart.xSpacing'] },
    { id: 'areas', label: 'Areas', build: buildAreasTab, keys: ['areas'] },
    { id: 'refs', label: 'Reference lines', build: buildRefsTab, keys: ['refs', 'band', 'forecast'] },
    { id: 'axes', label: 'Axes', build: buildAxesTab, keys: ['axisY', 'axisY2', 'axisX'] },
    { id: 'lines', label: 'Lines', build: buildLinesTab, keys: ['lines'] },
    { id: 'legend', label: 'Legend & tooltip', build: buildLegendTab,
      keys: ['legend', 'chart.tooltip', 'chart.tooltipSort', 'chart.tooltipTotal', 'chart.hoverDim', 'chart.rightClickMenu', 'numbers.tooltipFull'] },
    { id: 'numbers', label: 'Numbers', build: buildNumbersTab, keys: ['format', 'numbers.font'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card'] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try {
        var p = JSON.parse(payload || '{}');
        info.series = p.series || [];
        info.xs = p.xs || [];
        info.hasTime = !!p.hasTime;
        info.colorDim = p.colorDim || '';
        info.focus = p.focus || null;
      } catch (e) { /* opened without payload */ }

      cfg = Lc.read();
      cfg.refs = (cfg.refs || []).map(function (r) { return Lc.refCfg(r); });
      original = Lc.clone(cfg);

      if (!info.series.length) {
        // No data passed: list what's stored so the Series tab still works.
        info.series = Object.keys(cfg.series).map(function (k, i) {
          return { key: k, name: k, color: Lc.paletteColor(cfg.chart.palette, i) };
        });
      }
      if (info.series.length) selected = info.series[0].key;
      if (info.focus) {
        if (info.focus.tab) activeTab = info.focus.tab;
        if (info.focus.item) selected = info.focus.item;
      }
      if (selected !== '__defaults' && !seriesInfo(selected)) selected = info.series.length ? info.series[0].key : '__defaults';

      buildTabs();
      document.getElementById('cancel').addEventListener('click', function () {
        cfg = original;
        flush().then(close);
      });
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('Line Chart dialog failed to initialize:', err);
    });
  }

  function buildTabs () {
    var nav = document.getElementById('tabs');
    var panels = document.getElementById('panels');
    var scroll = panels.scrollTop;
    nav.innerHTML = '';
    panels.innerHTML = '';

    TABS.forEach(function (tab) {
      var b = h('button', { className: 'tab', type: 'button', role: 'tab', textContent: tab.label });
      b.setAttribute('aria-selected', String(tab.id === activeTab));
      b.addEventListener('click', function () { activeTab = tab.id; panels.scrollTop = 0; buildTabs(); });
      nav.appendChild(b);

      var panel = h('section', { className: 'panel', role: 'tabpanel' });
      panel.hidden = tab.id !== activeTab;
      if (!panel.hidden) tab.build(panel);
      panels.appendChild(panel);
    });
    panels.scrollTop = scroll;
  }

  /** Rebuild but keep the scroll position (for controls that show/hide rows). */
  function rebuild () { buildTabs(); }

  /** Restores the tab's settings; keys can be whole blocks ('lines') or paths ('chart.palette'). */
  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) {
      var path = k.split('.');
      var def = path.reduce(function (o, x) { return o[x]; }, Lc.DEFAULTS);
      var last = path.pop();
      path.reduce(function (o, x) { return o[x]; }, cfg)[last] = Lc.clone(def);
    });
    changed();
    buildTabs();
  }

  // ---------------------------------------------------------------------------
  // Number format editor (KPI Card 3 "Big number" options + signs)
  // ---------------------------------------------------------------------------
  function fmtRows (g, base, opts) {
    opts = opts || {};
    var fmtRow = selectRow('Number format', P(base, 'scale'), [
      ['dynamic', 'Dynamic (K / M / B)'], ['K', 'Thousands (K)'], ['M', 'Millions (M)'],
      ['B', 'Billions (B)'], ['none', 'Full number'],
      ['percent', 'Percentage (%)'], ['percentDynamic', 'Percentage, dynamic (K / M / B %)'],
      ['workbook', 'Workbook format']
    ]);
    fmtRow.querySelector('select').addEventListener('change', rebuild);
    g.appendChild(fmtRow);
    var scale = get(P(base, 'scale'));
    if (scale === 'percent' || scale === 'percentDynamic') {
      g.appendChild(checkboxRow('Value is a 0–1 ratio', P(base, 'pctFromRatio')));
      g.appendChild(help('On: 0.4523 → 45.23%. Off: 45.23 → 45.23%.'));
    }
    if (scale === 'workbook') g.appendChild(help('Uses Tableau’s format when a point is a single value; summed points fall back to Dynamic.'));
    g.appendChild(numberRow('Decimal places', P(base, 'decimals'), 0, 6, 1));
    g.appendChild(textRow('Unit', P(base, 'unit'), 'e.g. SAR, M, %'));
    g.appendChild(selectRow('Unit position', P(base, 'unitPosition'), [['suffix', 'After number'], ['prefix', 'Before number']]));
    if (!opts.noSign) g.appendChild(checkboxRow('“+” on positive values', P(base, 'plusSign')));
    g.appendChild(selectRow('Negative numbers', P(base, 'negStyle'), [['minus', '−201.4'], ['hyphen', '-201.4'], ['paren', '(201.4)']]));
    var sample = h('div', { className: 'sample' });
    var upd = function () {
      var f = get(base);
      sample.textContent = 'Preview: ' + Lc.formatNumber(1284500, f) + '   ' + Lc.formatNumber(262100, f, { signed: true }) +
        '   ' + Lc.formatNumber(-45200, f, { signed: true }) + '   ' + Lc.formatNumber(0, f, { signed: true, zeroSign: -1 });
    };
    upd();
    g.addEventListener('input', upd);
    g.addEventListener('change', upd);
    g.appendChild(sample);
  }

  /** Format controls for one label: own format when the scope is "each". */

  // ---------------------------------------------------------------------------
  // Series tab
  // ---------------------------------------------------------------------------
  function seriesInfo (key) { return info.series.find(function (s) { return s.key === key; }); }

  function seriesName (s) {
    var own = cfg.series[s.key];
    return (own && own.label) || s.name;
  }

  /** Effective colour of a series: its own, else its palette colour. */
  function seriesColor (s) {
    var own = cfg.series[s.key];
    var i = info.series.indexOf(s);
    return (own && Lc.normalizeHex(own.color)) || Lc.paletteColor(cfg.chart.palette, i < 0 ? 0 : i);
  }

  function seriesOptions (withAll) {
    var out = withAll ? [['', withAll]] : [];
    info.series.forEach(function (s) { out.push([s.key, seriesName(s)]); });
    return out;
  }

  function buildSeriesTab (p) {
    var isDef = selected === '__defaults';
    var s = isDef ? null : seriesInfo(selected);
    var base = isDef ? ['seriesDefaults'] : ['series', selected];

    var g0 = group(p, 'Series to format');
    var r0 = row('Series');
    var sel = h('select');
    sel.appendChild(h('option', { value: '__defaults', textContent: 'All series (defaults)' }));
    info.series.forEach(function (x, i) {
      sel.appendChild(h('option', { value: x.key, textContent: (i + 1) + '. ' + seriesName(x) }));
    });
    sel.value = selected;
    sel.addEventListener('change', function () { selected = sel.value; rebuild(); });
    r0.appendChild(sel);
    g0.appendChild(r0);
    g0.appendChild(help(isDef
      ? 'Used by every series you haven’t formatted on its own. Pick a series above to change just that one.'
      : 'One measure' + (info.colorDim ? ' × ' + info.colorDim + ' member' : '') + ' from the Marks card. Tip: right-click or double-click a line or a legend item to jump here.'));

    var g1 = group(p, 'Mark');
    if (!isDef) g1.appendChild(textRow('Label', P(base, 'label'), s.name));
    g1.appendChild(segRow('Draw as', P(base, 'type'), [['line', 'Line'], ['area', 'Area'], ['hidden', 'Hidden']], rebuild));
    if (!isDef) {
      g1.appendChild(seriesColorRow(s));
    } else {
      g1.appendChild(help('Colours come from the palette under Chart below; each series can have its own.'));
    }
    g1.appendChild(segRow('Axis', P(base, 'axis'), [['left', 'Left'], ['right', 'Right']]));
    g1.appendChild(help('Put a series on the right axis for a dual-axis chart (e.g. amounts left, counts or % right).'));

    var type = get(P(base, 'type'));
    var g2 = group(p, type === 'area' ? 'Outline' : 'Line');
    g2.appendChild(numberRow('Width (px)', P(base, 'width'), 0.5, 8, 0.5));
    g2.appendChild(segRow('Style', P(base, 'style'), LINE_STYLES));
    g2.appendChild(segRow('Shape', P(base, 'curve'), [['linear', 'Straight'], ['smooth', 'Smooth'], ['step', 'Step']]));
    g2.appendChild(numberRow('Dash last points', P(base, 'dashLast'), 0, 24, 1));
    g2.appendChild(help('Draws the last N segments dashed, e.g. 1 for a month that isn’t complete yet. 0 = off.'));
    if (type === 'area') g2.appendChild(help('Fill opacity, stacking and whether the outline shows are on the Areas tab.'));

    var g3 = group(p, 'Markers');
    g3.appendChild(selectRow('Show', P(base, 'markers'), [['none', 'None'], ['all', 'Every point'], ['last', 'Last point'], ['minmax', 'Highest and lowest']], null, rebuild));
    if (get(P(base, 'markers')) !== 'none') g3.appendChild(numberRow('Radius (px)', P(base, 'markerSize'), 1.5, 10, 0.5));

    var g4 = group(p, 'Value labels');
    g4.appendChild(selectRow('Show', P(base, 'labels'), [['none', 'None'], ['last', 'Last value (right of the line)'], ['all', 'Every point'],
      ['minmax', 'Highest and lowest'], ['firstlast', 'First and last']], null, rebuild));
    if (get(P(base, 'labels')) !== 'none') {
      g4.appendChild(numberRow('Size (px)', P(base, 'labelSize'), 6, 30, 1));
      g4.appendChild(selectRow('Weight', P(base, 'labelWeight'), WEIGHTS));
      g4.appendChild(segRow('Color', P(base, 'labelColorMode'), [['series', 'Series colour'], ['custom', 'Custom']], rebuild));
      if (get(P(base, 'labelColorMode')) === 'custom') g4.appendChild(colorRow('Text color', P(base, 'labelColor')));
      g4.appendChild(help('Values use the format on the Numbers tab.'));
    }

    if (!isDef && cfg.series[selected]) {
      var btn = h('button', { type: 'button', className: 'btn', textContent: 'Use the defaults for this series' });
      btn.addEventListener('click', function () { delete cfg.series[selected]; changed(); rebuild(); });
      group(p, 'Reset').appendChild(btn);
    }

    var g5 = group(p, 'Chart');
    g5.appendChild(selectRow('Palette', 'chart.palette', Object.keys(Lc.PALETTES).map(function (k) { return [k, Lc.PALETTES[k].label]; }), null, rebuild));
    var sw = h('div', { className: 'swatches' });
    (Lc.PALETTES[cfg.chart.palette] || Lc.PALETTES.house).colors.forEach(function (c) {
      var sp = h('span', { className: 'swatch', title: c });
      sp.style.background = c;
      sw.appendChild(sp);
    });
    g5.appendChild(sw);
    g5.appendChild(selectRow('Missing values', 'chart.missing', [['gap', 'Leave a gap'], ['connect', 'Connect across'], ['zero', 'Show as zero']]));
    if (info.hasTime) {
      g5.appendChild(segRow('Spacing', 'chart.xSpacing', [['even', 'Even'], ['time', 'By date']]));
      g5.appendChild(help('By date: points sit at their real distance in time, so missing dates leave room.'));
    }
  }

  function seriesColorRow (s) {
    var path = ['series', s.key, 'color'];
    var r = row('Color');
    var wrap = h('div', { className: 'inline' });
    var cur = seriesColor(s);
    var picker = h('input', { type: 'color', value: cur });
    var hex = h('input', { type: 'text', className: 'hex', value: cur, maxLength: 7, spellcheck: false });
    var auto = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Palette' });
    auto.title = 'Use the palette colour';
    picker.addEventListener('input', function () { hex.value = picker.value.toUpperCase(); set(path, hex.value); });
    hex.addEventListener('input', function () {
      var v = Lc.normalizeHex(hex.value);
      hex.classList.toggle('is-invalid', !v);
      if (v) { picker.value = v; set(path, v); }
    });
    hex.addEventListener('blur', function () { hex.value = seriesColor(s); hex.classList.remove('is-invalid'); });
    auto.addEventListener('click', function () { set(path, ''); rebuild(); });
    wrap.append(picker, hex, auto);
    r.appendChild(wrap);
    return r;
  }

  // ---------------------------------------------------------------------------
  // Areas tab
  // ---------------------------------------------------------------------------
  function buildAreasTab (p) {
    var g1 = group(p, 'Areas');
    g1.appendChild(segRow('Areas', 'areas.mode', [['overlay', 'Overlap'], ['stack', 'Stacked'], ['percent', '100% stacked']], rebuild));
    g1.appendChild(help(cfg.areas.mode === 'overlay'
      ? 'Every area fills down to zero on its own; later areas sit in front.'
      : cfg.areas.mode === 'stack'
        ? 'Areas on the same axis are stacked in Marks card order; the tooltip shows the total.'
        : 'Areas are stacked to 100% on the left axis (share of the total). Lines move to the right axis.'));
    g1.appendChild(rangeRow('Fill opacity', 'areas.opacity', 0, 100, 1, '%'));
    g1.appendChild(checkboxRow('Gradient fill', 'areas.gradient'));
    g1.appendChild(help('Fades the fill towards the baseline.'));
    g1.appendChild(checkboxRow('Outline', 'areas.outline'));
    g1.appendChild(help('The line along the top of each area (width and style per series).'));

    var g2 = group(p, 'Line or area per series');
    if (!info.series.length) g2.appendChild(help('Drop measures on the Measures tile first.'));
    info.series.forEach(function (s) {
      g2.appendChild(segRow(seriesName(s), ['series', s.key, 'type'], [['line', 'Line'], ['area', 'Area'], ['hidden', 'Hidden']]));
    });
  }

  // ---------------------------------------------------------------------------
  // Reference lines, band, forecast
  // ---------------------------------------------------------------------------
  var REF_KINDS = { constant: 'Target / constant', average: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum', last: 'Latest value' };

  function buildRefsTab (p) {
    var g0 = group(p, 'Reference lines');
    if (!cfg.refs.length) g0.appendChild(help('Horizontal lines for a target, the average, the median, the min / max or the latest value.'));
    cfg.refs.forEach(function (r, k) {
      var base = ['refs', k];
      var g = group(p, 'Line ' + (k + 1) + ' — ' + (REF_KINDS[r.kind] || r.kind));
      g.appendChild(checkboxRow('Show', P(base, 'show')));
      g.appendChild(selectRow('Value', P(base, 'kind'), [['constant', 'Constant (target)'], ['average', 'Average'], ['median', 'Median'],
        ['min', 'Minimum'], ['max', 'Maximum'], ['last', 'Latest value']], null, rebuild));
      if (r.kind === 'constant') {
        g.appendChild(numberRow('Constant', P(base, 'value'), -1e15, 1e15, 'any'));
        g.appendChild(segRow('Axis', P(base, 'axis'), [['left', 'Left'], ['right', 'Right']]));
      } else {
        g.appendChild(selectRow('Of', P(base, 'series'), seriesOptions('Every visible series on the axis'), null, rebuild));
        if (!r.series) g.appendChild(segRow('Axis', P(base, 'axis'), [['left', 'Left'], ['right', 'Right']]));
      }
      g.appendChild(textRow('Label', P(base, 'label'), 'Automatic (e.g. Average)'));
      g.appendChild(checkboxRow('Show the value', P(base, 'showValue')));
      g.appendChild(segRow('Label side', P(base, 'labelPos'), [['left', 'Left'], ['right', 'Right']]));
      g.appendChild(colorRow('Color', P(base, 'color')));
      g.appendChild(numberRow('Width (px)', P(base, 'width'), 0.5, 6, 0.5));
      g.appendChild(segRow('Style', P(base, 'style'), LINE_STYLES));
      g.appendChild(numberRow('Text size (px)', P(base, 'size'), 6, 24, 1));
      var del = h('button', { type: 'button', className: 'btn', textContent: 'Remove line ' + (k + 1) });
      del.addEventListener('click', function () { cfg.refs.splice(k, 1); changed(); rebuild(); });
      g.appendChild(del);
    });
    var add = h('button', { type: 'button', className: 'btn btn--primary', textContent: 'Add reference line' });
    add.addEventListener('click', function () {
      var r = Lc.clone(Lc.REF);
      r.color = REF_COLORS[cfg.refs.length % REF_COLORS.length];
      cfg.refs.push(r);
      changed();
      rebuild();
    });
    var addWrap = h('div', { className: 'group' });
    addWrap.appendChild(add);
    p.appendChild(addWrap);

    var b = cfg.band;
    var g1 = group(p, 'Band between two measures');
    g1.appendChild(checkboxRow('Show band', 'band.show', rebuild));
    g1.appendChild(help('Shades the range between a lower and an upper measure, e.g. forecast low / high, min / max or a budget corridor.'));
    if (b.show) {
      var opts = seriesOptions('— choose —');
      g1.appendChild(selectRow('Lower', 'band.lower', opts));
      g1.appendChild(selectRow('Upper', 'band.upper', opts));
      g1.appendChild(textRow('Name', 'band.label', 'e.g. Forecast range'));
      g1.appendChild(colorRow('Color', 'band.color'));
      g1.appendChild(rangeRow('Opacity', 'band.opacity', 0, 100, 1, '%'));
      g1.appendChild(checkboxRow('Hide the two lines', 'band.hideLines'));
      g1.appendChild(checkboxRow('Dashed edges', 'band.edges'));
    }

    var f = cfg.forecast;
    var g2 = group(p, 'Forecast / projection');
    g2.appendChild(checkboxRow('Mark forecast', 'forecast.show', rebuild));
    g2.appendChild(help('From the chosen point on, lines are dashed on a shaded background, e.g. forecast or budget months.'));
    if (f.show) {
      var xs = [['', '— choose —']].concat(info.xs.map(function (x) { return [x, x]; }));
      if (f.from && info.xs.indexOf(f.from) < 0) xs.push([f.from, f.from + ' (not in the data)']);
      g2.appendChild(selectRow('First forecast point', 'forecast.from', xs));
      g2.appendChild(checkboxRow('Dashed lines', 'forecast.dash'));
      g2.appendChild(checkboxRow('Shade background', 'forecast.shade'));
      g2.appendChild(colorRow('Shade color', 'forecast.shadeColor'));
      g2.appendChild(textRow('Label', 'forecast.label', 'e.g. Forecast'));
      g2.appendChild(colorRow('Label color', 'forecast.labelColor'));
    }
  }

  // ---------------------------------------------------------------------------
  // Axes tab
  // ---------------------------------------------------------------------------
  function yAxisGroups (p, key, title) {
    var a = cfg[key];
    var g1 = group(p, title + ' — range');
    g1.appendChild(segRow('Starts at', key + '.base', [['zero', 'Zero'], ['auto', 'Close to the data'], ['manual', 'Fixed value']], rebuild));
    if (a.base === 'auto') {
      g1.appendChild(rangeRow('Room around data', key + '.padding', 0, 100, 1, '%'));
      g1.appendChild(help('Space below the lowest and above the highest value, as a share of the data range. Areas always start at zero.'));
    } else if (a.base === 'manual') {
      g1.appendChild(numberRow('Minimum', key + '.manualMin', -1e15, 1e15, 'any'));
    }
    g1.appendChild(segRow('Ends at', key + '.maxMode', [['auto', 'Automatic'], ['manual', 'Fixed value']], rebuild));
    if (a.maxMode === 'manual') g1.appendChild(numberRow('Maximum', key + '.manualMax', -1e15, 1e15, 'any'));
    g1.appendChild(numberRow('Tick marks (about)', key + '.ticks', 2, 12, 1));

    var g2 = group(p, title + ' — labels');
    g2.appendChild(checkboxRow('Show axis', key + '.show', rebuild));
    if (a.show) {
      g2.appendChild(textRow('Axis title', key + '.title', 'e.g. SAR M'));
      fontRows(g2, key, false);
      g2.appendChild(checkboxRow('Axis line', key + '.showLine', rebuild));
      if (a.showLine) g2.appendChild(colorRow('Line color', key + '.lineColor'));
      var g3 = group(p, title + ' — number format');
      g3.appendChild(checkboxRow('Use shared format', key + '.useGlobalFormat', rebuild));
      if (!a.useGlobalFormat) fmtRows(g3, key + '.fmt', { noSign: true });
    }
  }

  function buildAxesTab (p) {
    yAxisGroups(p, 'axisY', 'Left axis');
    p.appendChild(h('p', { className: 'note', textContent: 'The right axis appears when a series is set to Axis → Right on the Series tab (dual axis), or with 100% stacked areas.' }));
    yAxisGroups(p, 'axisY2', 'Right axis');

    var x = cfg.axisX;
    var g4 = group(p, 'Horizontal axis');
    g4.appendChild(checkboxRow('Show labels', 'axisX.show', rebuild));
    if (x.show) {
      g4.appendChild(segRow('Labels', 'axisX.orientation', [['auto', 'Horizontal'], ['angled', 'Angled'], ['vertical', 'Vertical']]));
      g4.appendChild(help('Labels that don’t fit are skipped; the last point is always labelled.'));
      g4.appendChild(textRow('Axis title', 'axisX.title', 'e.g. Month'));
      fontRows(g4, 'axisX', false);
    }
    g4.appendChild(checkboxRow('Axis line', 'axisX.showLine', rebuild));
    if (x.showLine) {
      g4.appendChild(colorRow('Line color', 'axisX.lineColor'));
      g4.appendChild(numberRow('Line width', 'axisX.lineWidth', 0.5, 6, 0.5));
    }
    g4.appendChild(checkboxRow('Tick marks', 'axisX.ticks'));
  }

  // ---------------------------------------------------------------------------
  // Lines tab
  // ---------------------------------------------------------------------------
  function buildLinesTab (p) {
    [['hGrid', 'Horizontal gridlines'], ['vGrid', 'Vertical gridlines (at the labels)'],
      ['zero', 'Zero line'], ['crosshair', 'Hover line (crosshair)']].forEach(function (x) {
      var base = 'lines.' + x[0];
      var g = group(p, x[1]);
      g.appendChild(checkboxRow('Show', base + '.show', rebuild));
      if (get(base + '.show')) {
        g.appendChild(colorRow('Color', base + '.color'));
        g.appendChild(numberRow('Width (px)', base + '.width', 0.5, 6, 0.5));
        g.appendChild(segRow('Style', base + '.style', LINE_STYLES));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Legend & tooltip tab
  // ---------------------------------------------------------------------------
  function buildLegendTab (p) {
    var lg = cfg.legend;
    var g1 = group(p, 'Legend');
    g1.appendChild(checkboxRow('Show legend', 'legend.show', rebuild));
    if (lg.show) {
      g1.appendChild(segRow('Position', 'legend.position', [['top', 'Top'], ['bottom', 'Bottom'], ['right', 'Right']], rebuild));
      if (lg.position !== 'right') g1.appendChild(segRow('Align', 'legend.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
      g1.appendChild(checkboxRow('Click to hide / show', 'legend.interactive'));
      g1.appendChild(help('Viewers can click a legend item to hide that series (until the sheet reloads). Hovering an item highlights its series.'));
      g1.appendChild(checkboxRow('Latest value', 'legend.showLatest'));
      fontRows(g1, 'legend', false);
    }

    var g2 = group(p, 'Tooltip');
    g2.appendChild(checkboxRow('Show tooltip', 'chart.tooltip', rebuild));
    if (cfg.chart.tooltip) {
      g2.appendChild(selectRow('Order', 'chart.tooltipSort', [['tile', 'Marks card order'], ['valDesc', 'Value, high to low'], ['valAsc', 'Value, low to high']]));
      g2.appendChild(checkboxRow('Full numbers', 'numbers.tooltipFull'));
      g2.appendChild(help('Unabbreviated values (Tableau’s own format when a point is a single value) instead of the chart format.'));
      g2.appendChild(checkboxRow('Total of stacked areas', 'chart.tooltipTotal'));
    }

    var g3 = group(p, 'Interaction');
    g3.appendChild(checkboxRow('Fade other series on legend hover', 'chart.hoverDim'));
    g3.appendChild(checkboxRow('Right-click menu', 'chart.rightClickMenu'));
  }

  // ---------------------------------------------------------------------------
  // Numbers tab
  // ---------------------------------------------------------------------------
  function buildNumbersTab (p) {
    var g1 = group(p, 'Number format');
    fmtRows(g1, 'format');
    g1.appendChild(help('Used by value labels, reference lines and the legend. The axes have their own format on the Axes tab.'));

    var g2 = group(p, 'Chart text');
    g2.appendChild(fontFamilyRow('Font', 'numbers.font'));
    g2.appendChild(help('Font of value labels, reference line labels and the tooltip. Axis and legend fonts are on their own tabs.'));
  }

  function buildCardTab (p) {
    var g1 = group(p, 'Card');
    g1.appendChild(numberRow('Padding (px)', 'card.padding', 0, 60, 1));
    g1.appendChild(numberRow('Space above chart', 'card.gap', 0, 60, 1));
    g1.appendChild(checkboxRow('Dashed right divider', 'card.divider'));
    g1.appendChild(colorRow('Divider color', 'card.dividerColor'));

    var g2 = group(p, 'Background');
    g2.appendChild(colorRow('Color', 'card.bgColor'));
    g2.appendChild(rangeRow('Opacity', 'card.bgOpacity', 0, 100, 1, '%'));
    g2.appendChild(help('0% is fully transparent. Set worksheet and container shading to None in Tableau to see through.'));
  }

  function help (text) { return h('div', { className: 'help', textContent: text }); }

  /** Path helper: P('a.b', 'c.d') or P(['steps', key], 'total.show') → array. */
  function P (base, rest) {
    var a = Array.isArray(base) ? base.slice() : String(base).split('.');
    return rest == null ? a : a.concat(String(rest).split('.'));
  }

  function buildIconTab (p) {
    var ic = cfg.icon;

    var preview = h('div', { className: 'icon-preview' });
    var slot = h('div', { className: 'slot' });
    var name = h('div', { className: 'name' });
    preview.append(slot, name);
    var refreshPreview = function () {
      slot.innerHTML = '';
      slot.classList.remove('slot--dark');
      if (!ic.show) { name.textContent = 'Icon hidden'; return; }
      if (ic.source === 'builtin') {
        var r = Lc.iconHtml(ic.builtinId, ic.color);
        slot.innerHTML = r.html;
        slot.classList.toggle('slot--dark', !!r.icon.light);
        name.textContent = r.icon.label;
      } else if (ic.dataUrl) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 24; var hh = img.naturalHeight || 24;
          if (w >= hh) { img.style.width = '24px'; img.style.height = 'auto'; } else { img.style.height = '24px'; img.style.width = 'auto'; }
        };
        img.src = ic.dataUrl;
        slot.appendChild(img);
        name.textContent = ic.name || (ic.source === 'shape' ? 'Tableau shape' : 'Uploaded image');
      } else {
        name.textContent = 'No image chosen yet';
      }
    };
    refreshPreview();

    var g = group(p, 'Icon');
    g.appendChild(preview);
    g.appendChild(checkboxRow('Show icon', 'icon.show', function () { refreshPreview(); }));
    g.appendChild(rangeRow('Size', 'icon.size', 12, 96, 1, ' px'));
    g.appendChild(h('div', { className: 'help', textContent: 'Length of the icon\u2019s longer side. Figma default is 24 px; icons stay sharpest up to about 48 px.' }));

    var sources = [['builtin', 'Built-in'], ['shape', 'Tableau shapes'], ['upload', 'Upload']];
    var sourceRow = row('Source');
    var seg = h('div', { className: 'seg' });
    sources.forEach(function (s) {
      var b = h('button', { type: 'button', textContent: s[1] });
      b.setAttribute('aria-pressed', String(ic.source === s[0]));
      b.addEventListener('click', function () {
        ic.source = s[0];
        if (s[0] === 'builtin') ic.show = true;
        changed();
        buildTabs();
      });
      seg.appendChild(b);
    });
    sourceRow.appendChild(seg);
    g.appendChild(sourceRow);

    var body = group(p, sources.find(function (s) { return s[0] === ic.source; })[1]);

    if (ic.source === 'builtin') {
      var gridWrap = h('div');
      var fillGrid = function () {
        gridWrap.innerHTML = '';
        Lc.ICON_GROUPS.forEach(function (groupName) {
          var icons = Lc.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Lc.iconHtml(icon.id, ic.color).html;
            if (icon.id === ic.builtinId) cell.classList.add('is-active');
            cell.addEventListener('click', function () {
              ic.builtinId = icon.id;
              ic.show = true;
              Array.prototype.forEach.call(gridWrap.querySelectorAll('.cell'), function (c) { c.classList.remove('is-active'); });
              cell.classList.add('is-active');
              changed();
              refreshPreview();
            });
            grid.appendChild(cell);
          });
          gridWrap.appendChild(grid);
        });
      };
      body.appendChild(colorRow('Icon color', 'icon.color', function () { refreshPreview(); fillGrid(); }));
      body.appendChild(h('div', { className: 'help', textContent: 'Recolours the built-in icons.' }));
      fillGrid();
      body.appendChild(gridWrap);
    } else if (ic.source === 'shape') {
      buildShapePicker(body, refreshPreview);
    } else {
      buildUpload(body, refreshPreview);
    }
  }

  /** Lists Tableau shape palettes served by serve.py (/shapes/index.json). */
  function buildShapePicker (body, refreshPreview) {
    var note = h('p', { className: 'note', textContent: 'Loading shape palettes…' });
    body.appendChild(note);

    var loadIndex = shapeIndex ? Promise.resolve(shapeIndex)
      : fetch(baseUrl() + 'shapes/index.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (j) { shapeIndex = j; return j; });

    loadIndex.then(function (index) {
      var palettes = (index.palettes || []).filter(function (pl) { return pl.files && pl.files.length; });
      if (!palettes.length) {
        note.innerHTML = 'No shape palettes found. serve.py looked in:<br><code>' +
          (index.searched || []).map(escapeHtml).join('</code><br><code>') +
          '</code><br>Set <code>KPI_SHAPES_DIRS</code> before starting it to add folders.';
        return;
      }
      note.textContent = 'Shapes are copied into the workbook when picked, so they keep working after publishing.';

      var selRow = row('Palette');
      var sel = h('select');
      palettes.forEach(function (pl, i) { sel.appendChild(h('option', { value: String(i), textContent: pl.name + ' (' + pl.files.length + ')' })); });
      var remembered = palettes.findIndex(function (pl) { return cfg.icon.name.indexOf(pl.name + ' / ') === 0; });
      sel.value = String(remembered >= 0 ? remembered : 0);
      selRow.appendChild(sel);
      body.appendChild(selRow);

      var grid = h('div', { className: 'grid' });
      body.appendChild(grid);

      var fill = function () {
        grid.innerHTML = '';
        var pl = palettes[Number(sel.value)];
        pl.files.forEach(function (f) {
          var label = pl.name + ' / ' + f.name;
          var cell = h('button', { type: 'button', className: 'cell', title: f.name });
          cell.appendChild(h('img', { src: baseUrl() + f.url, alt: '', loading: 'lazy' }));
          if (cfg.icon.source === 'shape' && cfg.icon.name === label) cell.classList.add('is-active');
          cell.addEventListener('click', function () {
            fetch(baseUrl() + f.url).then(function (r) { return r.blob(); })
              .then(blobToIconDataUrl)
              .then(function (url) {
                cfg.icon.source = 'shape';
                cfg.icon.dataUrl = url;
                cfg.icon.name = label;
                cfg.icon.show = true;
                Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('is-active'); });
                cell.classList.add('is-active');
                changed();
                refreshPreview();
              })
              .catch(function (e) { setStatus('Could not load that shape: ' + e.message); });
          });
          grid.appendChild(cell);
        });
      };
      sel.addEventListener('change', fill);
      fill();
    }).catch(function () {
      note.innerHTML = 'Tableau shapes are listed by the local helper server. Start the extension with ' +
        '<code>./serve.sh</code> (it runs <code>serve.py</code>), then reopen this dialog. ' +
        'You can still upload a shape file from the <b>Upload</b> tab.';
    });
  }

  function buildUpload (body, refreshPreview) {
    var drop = h('label', { className: 'drop' });
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp,.ico' });
    drop.append(input,
      h('b', { textContent: 'Choose an image' }),
      h('span', { textContent: 'or drop it here — PNG, SVG, JPG, GIF. Tableau custom shapes work too.' }));
    body.appendChild(drop);
    body.appendChild(h('p', {
      className: 'note',
      textContent: 'Scaled to 24 px on its longer side. Raster images are stored at 96 px for sharp rendering on high-DPI screens.'
    }));

    var take = function (file) {
      if (!file) return;
      blobToIconDataUrl(file).then(function (url) {
        cfg.icon.source = 'upload';
        cfg.icon.dataUrl = url;
        cfg.icon.name = file.name;
        cfg.icon.show = true;
        changed();
        refreshPreview();
      }).catch(function (e) { setStatus('Could not read that image: ' + e.message); });
    };
    input.addEventListener('change', function () { take(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) { take(e.dataTransfer.files[0]); });
  }

  function buildTextTab (p) {
    var g1 = group(p, 'Title');
    g1.appendChild(textRow('Title', 'title.text', 'Defaults to the measure names'));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(textRow('Text', 'explanation.text', 'e.g. % Top-Up vs Local Transfer'));
    fontRows(g2, 'explanation', true);
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function fontRows (g, section, withItalic) {
    g.appendChild(fontFamilyRow('Font', P(section, 'font')));
    g.appendChild(numberRow('Size (px)', P(section, 'size'), 6, 160, 1));
    g.appendChild(selectRow('Weight', P(section, 'weight'), WEIGHTS));
    g.appendChild(colorRow('Color', P(section, 'color')));
    if (withItalic !== false) g.appendChild(checkboxRow('Italic', P(section, 'italic')));
  }

  function fontFamilyRow (label, path) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var sel = h('select');
    Lc.FONTS.forEach(function (f) { sel.appendChild(h('option', { value: f, textContent: f })); });
    sel.appendChild(h('option', { value: '__custom', textContent: 'Other…' }));
    var custom = h('input', { type: 'text', placeholder: 'Installed font name' });
    var current = get(path);
    if (Lc.FONTS.indexOf(current) >= 0) { sel.value = current; custom.hidden = true; } else { sel.value = '__custom'; custom.value = current; }
    sel.addEventListener('change', function () {
      custom.hidden = sel.value !== '__custom';
      if (sel.value !== '__custom') { set(path, sel.value); } else { custom.focus(); }
    });
    custom.addEventListener('input', function () { if (custom.value.trim()) set(path, custom.value.trim()); });
    wrap.append(sel, custom);
    r.appendChild(wrap);
    return r;
  }

  function textRow (label, path, placeholder) {
    var r = row(label);
    var input = h('input', { type: 'text', value: get(path), placeholder: placeholder || '' });
    input.addEventListener('input', function () { set(path, input.value); });
    r.appendChild(input);
    return r;
  }

  function numberRow (label, path, min, max, step) {
    var r = row(label);
    var input = h('input', { type: 'number', min: min, max: max, step: step, value: get(path) });
    input.addEventListener('input', function () {
      var n = Number(input.value);
      if (input.value === '' || !isFinite(n)) return;
      set(path, Math.max(min, Math.min(max, n)));
    });
    r.appendChild(input);
    return r;
  }

  function rangeRow (label, path, min, max, step, unit) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var input = h('input', { type: 'range', min: min, max: max, step: step, value: get(path) });
    var out = h('span', { className: 'readout', textContent: get(path) + (unit || '') });
    input.addEventListener('input', function () { set(path, Number(input.value)); out.textContent = input.value + (unit || ''); });
    wrap.append(input, out);
    r.appendChild(wrap);
    return r;
  }

  function selectRow (label, path, options, help, after) {
    var r = row(label);
    var sel = h('select');
    options.forEach(function (o) { sel.appendChild(h('option', { value: String(o[0]), textContent: o[1] })); });
    sel.value = String(get(path));
    sel.addEventListener('change', function () {
      var orig = options.find(function (o) { return String(o[0]) === sel.value; })[0];
      set(path, orig);
      if (after) after();
    });
    r.appendChild(sel);
    if (help) { var frag = document.createDocumentFragment(); frag.append(r, h('div', { className: 'help', textContent: help })); return wrapRows(frag); }
    return r;
  }

  function segRow (label, path, options, after) {
    var r = row(label);
    var seg = h('div', { className: 'seg' });
    options.forEach(function (o) {
      var b = h('button', { type: 'button', textContent: o[1] });
      b.setAttribute('aria-pressed', String(get(path) === o[0]));
      b.addEventListener('click', function () {
        set(path, o[0]);
        Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        if (after) after();
      });
      seg.appendChild(b);
    });
    r.appendChild(seg);
    return r;
  }

  function checkboxRow (label, path, after) {
    var r = row(label);
    var input = h('input', { type: 'checkbox' });
    input.checked = !!get(path);
    input.addEventListener('change', function () { set(path, input.checked); if (after) after(); });
    r.appendChild(h('div', { className: 'inline' }, [input]));
    return r;
  }

  function colorRow (label, path, after) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var picker = h('input', { type: 'color', value: Lc.normalizeHex(get(path)) || '#000000' });
    var hex = h('input', { type: 'text', className: 'hex', value: get(path), maxLength: 7, spellcheck: false });
    picker.addEventListener('input', function () {
      hex.value = picker.value.toUpperCase(); hex.classList.remove('is-invalid');
      set(path, hex.value); if (after) after();
    });
    hex.addEventListener('input', function () {
      var v = Lc.normalizeHex(hex.value);
      hex.classList.toggle('is-invalid', !v);
      if (v) { picker.value = v; set(path, v); if (after) after(); }
    });
    hex.addEventListener('blur', function () { hex.value = get(path); hex.classList.remove('is-invalid'); });
    wrap.append(picker, hex);
    r.appendChild(wrap);
    return r;
  }

  function wrapRows (frag) { var d = h('div'); d.appendChild(frag); return d; }

  function row (label) {
    var r = h('div', { className: 'row' });
    r.appendChild(h('label', { textContent: label }));
    return r;
  }

  function group (parent, title) {
    var g = h('div', { className: 'group' });
    g.appendChild(h('h3', { className: 'group-title', textContent: title }));
    parent.appendChild(g);
    return g;
  }

  function h (tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'role') n.setAttribute('role', props[k]); else n[k] = props[k];
    });
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  // ---------------------------------------------------------------------------
  // Images
  // ---------------------------------------------------------------------------

  /**
   * Converts an image file/blob into a compact data URL for the workbook.
   * Small SVGs are kept as vectors; everything else is rasterised so its
   * longer side is 96 px (4× the 24 px display size).
   */
  function blobToIconDataUrl (blob) {
    return readAsDataUrl(blob).then(function (url) {
      var isSvg = /svg/i.test(blob.type) || /^data:image\/svg/i.test(url);
      if (isSvg && url.length < 60000) return url;
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 96;
          var hh = img.naturalHeight || 96;
          var k = 96 / Math.max(w, hh);
          if (k >= 1 && url.length < 60000) { resolve(url); return; }
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * Math.min(k, 1)));
          c.height = Math.max(1, Math.round(hh * Math.min(k, 1)));
          var ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = function () { reject(new Error('unsupported image format')); };
        img.src = url;
      });
    });
  }

  function readAsDataUrl (blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  function get (path) {
    var keys = P(path);
    var v = keys.reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg);
    // A series without its own value shows the series default.
    if (v === undefined && keys[0] === 'series' && keys.length > 2) {
      v = keys.slice(2).reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg.seriesDefaults);
    }
    return v;
  }

  function set (path, value) {
    var keys = P(path);
    var last = keys.pop();
    keys.reduce(function (o, k) {
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      return o[k];
    }, cfg)[last] = value;
    changed();
  }

  function changed () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 180);
  }

  function flush () {
    clearTimeout(saveTimer);
    return persist();
  }

  function persist () {
    try {
      setStatus('Saving…');
      return Lc.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function setStatus (text) {
    document.getElementById('status').textContent = text;
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }

  function baseUrl () {
    return window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
  }

  function escapeHtml (s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }


  window.LineChartConfigure = { init: init };
})();
