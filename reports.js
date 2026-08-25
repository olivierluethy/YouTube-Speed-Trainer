// YouTube Speed Trainer — Progress Reports & Goal Forecasting (issue #8)
//
// A full-page analytics dashboard opened in a browser tab. All computation is
// delegated to the shared STA library (analytics.js); this file only loads data
// from chrome.storage.local, drives the DOM, and hand-builds the SVG charts.
//
// Manifest V3 CSP: no inline handlers, no external scripts, no eval. Every
// listener is attached here. Charts are our own SVG strings injected via
// innerHTML (markup only, no script), which the CSP allows.

'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // Central page state, populated on load.
  const state = {
    stats: STA.emptyStats(),
    currentSpeed: 1.0,
    targetSpeed: 2.0,
    goalHistory: [],
    dropHistory: [],       // chronological manual speed drops
    videoStats: {},        // per-video telemetry
    scope: 'all',          // 'all' or a monthKey like '2026-08'
    dailySeries: [],       // full daily series (chronological)
    monthlySeries: []      // full monthly series
  };

  // ---- small formatting helpers -------------------------------------------

  const fmtDur = (s) => STA.formatDuration(s);
  const fmtSpeed = (n) => `${STA.round2(n).toFixed(2)}×`;

  // A human month label from a monthKey ("2026-08" -> "August 2026").
  function monthLabel(mk) {
    const [y, m] = mk.split('-').map(Number);
    const names = ['January','February','March','April','May','June','July',
      'August','September','October','November','December'];
    return `${names[m - 1]} ${y}`;
  }

  // A short date label ("2026-08-26" -> "Aug 26").
  function shortDate(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${names[m - 1]} ${d}`;
  }
  function shortMonth(mk) {
    const [, m] = mk.split('-').map(Number);
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return names[m - 1];
  }

  // ---- data loading --------------------------------------------------------

  function load() {
    chrome.storage.local.get(
      ['stats', 'currentSpeed', 'targetSpeed', 'goalHistory', 'dropHistory', 'videoStats'],
      (res) => {
        state.stats = STA.mergeStats(res.stats);
        state.currentSpeed = Number(res.currentSpeed) || STA.averageSpeed(state.stats);
        state.targetSpeed = Number(res.targetSpeed) || 2.0;
        state.goalHistory = Array.isArray(res.goalHistory) ? res.goalHistory : [];
        state.dropHistory = Array.isArray(res.dropHistory) ? res.dropHistory : [];
        state.videoStats = (res.videoStats && typeof res.videoStats === 'object') ? res.videoStats : {};
        state.dailySeries = STA.dailySeries(state.stats);
        state.monthlySeries = STA.monthlySeries(state.stats);
        init();
      }
    );
  }

  // Does the user have any meaningful data at all?
  function hasData() {
    return state.stats.totalReal > 0 || state.dailySeries.length > 0;
  }

  // ---- init / wiring -------------------------------------------------------

  function init() {
    // Print button
    $('btn-print').addEventListener('click', () => window.print());

    if (!hasData()) {
      $('fresh-state').style.display = 'block';
      $('report-body').style.display = 'none';
      return;
    }
    $('report-body').style.display = 'block';

    buildMonthSelector();

    // Target slider
    const slider = $('target-slider');
    slider.value = String(STA.clampSpeed(state.targetSpeed));
    slider.addEventListener('input', onTargetInput);
    slider.addEventListener('change', onTargetCommit);

    // Month selector
    $('month-select').addEventListener('change', (e) => {
      state.scope = e.target.value;
      renderReport();
    });

    // Per-video breakdown is period-independent — render once.
    renderVideos();

    // Record a goal-history snapshot (deduped) then render.
    recordGoalSnapshot();
    renderReport();
    renderGoals();
  }

  // Populate the period dropdown from months present in stats.daily.
  function buildMonthSelector() {
    const sel = $('month-select');
    const months = state.monthlySeries.map((m) => m.month);
    // newest first
    const ordered = months.slice().reverse();
    const opts = ['<option value="all">All time</option>']
      .concat(ordered.map((mk) => `<option value="${mk}">${monthLabel(mk)}</option>`));
    sel.innerHTML = opts.join('');
    // default to latest month present
    if (ordered.length) {
      state.scope = ordered[0];
      sel.value = ordered[0];
    } else {
      state.scope = 'all';
      sel.value = 'all';
    }
  }

  // ---- scope view ----------------------------------------------------------
  //
  // Build a "view" for the selected period: aggregate totals plus the chart
  // series (per-day within a month, or per-month for all-time).

  function buildView() {
    if (state.scope === 'all') {
      const s = state.stats;
      const points = state.monthlySeries.map((m) => ({
        label: shortMonth(m.month),
        saved: m.saved,
        avgSpeed: m.avgSpeed,
        real: m.real
      }));
      return {
        label: 'All time',
        real: s.totalReal,
        content: s.totalContent,
        saved: STA.timeSaved(s),
        avgSpeed: STA.averageSpeed(s),
        granularity: 'month',
        points
      };
    }
    // Month scope: filter daily series to this month.
    const mk = state.scope;
    const days = state.dailySeries.filter((d) => d.day.slice(0, 7) === mk);
    let real = 0, content = 0;
    for (const d of days) { real += d.real; content += d.content; }
    const points = days.map((d) => ({
      label: shortDate(d.day),
      saved: d.saved,
      avgSpeed: d.avgSpeed,
      real: d.real
    }));
    return {
      label: monthLabel(mk),
      real,
      content,
      saved: Math.max(0, content - real),
      avgSpeed: real ? STA.round2(content / real) : 0,
      granularity: 'day',
      points
    };
  }

  // ---- report (top) rendering ---------------------------------------------

  function renderReport() {
    const v = buildView();

    // sync selector (in case scope was set programmatically)
    $('month-select').value = state.scope;

    // Hero
    $('hero-value').innerHTML = colouredDuration(v.saved);
    $('hero-sub').textContent = v.saved > 0
      ? `You watched ${fmtDur(v.content)} of content in only ${fmtDur(v.real)} of real time — ${v.label}.`
      : `Watch a little more during ${v.label} to start banking saved time.`;

    // Print metadata line
    $('print-meta').textContent = `${v.label} · generated ${STA.dayKey(new Date())}`;

    $('overview-hint').textContent = v.label;

    // Tiles — personal average & natural range are inherently all-time
    // (timeAtSpeed has no date), so they're labelled as such.
    const pas = STA.personalAverageSpeed(state.stats);
    const nr = STA.naturalSpeedRange(state.stats);
    const overallAvg = STA.averageSpeed(state.stats);

    const tiles = [
      { label: 'Watch time (real)', value: fmtDur(v.real), foot: v.label },
      { label: 'Content consumed', value: fmtDur(v.content), foot: v.label },
      { label: 'Average speed', value: fmtSpeed(v.avgSpeed), foot: v.label, accent: true },
      { label: 'Personal average', value: fmtSpeed(pas), foot: 'since baseline · all time', accent: true },
      { label: 'Overall average', value: fmtSpeed(overallAvg), foot: 'all time', accent: true },
      { label: 'Natural speed range', value: `${nr.min.toFixed(2)}–${nr.max.toFixed(2)}×`, foot: `most-watched ${nr.mode.toFixed(2)}×` }
    ];
    $('tiles').innerHTML = tiles.map(tileHTML).join('');

    // Charts
    renderCharts(v);

    // Speed-drop history (period-filtered)
    renderDrops(v);
  }

  function tileHTML(t) {
    const val = t.accent
      ? t.value.replace(/×/g, '<span>×</span>')
      : t.value;
    return `<div class="tile">
      <div class="label">${t.label}</div>
      <div class="value">${val}</div>
      <div class="foot">${t.foot}</div>
    </div>`;
  }

  // Render the hero duration with the trailing unit tokens tinted teal.
  function colouredDuration(seconds) {
    const txt = fmtDur(seconds);
    // wrap letters (units) in spans
    return txt.replace(/([a-z]+)/g, '<span>$1</span>');
  }

  // ---- charts (hand-built SVG) --------------------------------------------

  function renderCharts(v) {
    const gran = v.granularity === 'day' ? 'per day' : 'per month';
    $('chart1-title').textContent = 'Time saved';
    $('chart1-desc').textContent = `Seconds banked ${gran} — ${v.label}`;
    $('chart2-title').textContent = 'Average playback speed';
    $('chart2-desc').textContent = `Weighted average speed ${gran} — ${v.label}`;

    if (!v.points.length) {
      $('chart-saved').innerHTML = '<div class="chart-empty">No data for this period.</div>';
      $('chart-speed').innerHTML = '<div class="chart-empty">No data for this period.</div>';
      return;
    }

    // Saved chart: bar chart, values in seconds but labelled with formatDuration.
    $('chart-saved').innerHTML = barChart(
      v.points.map((p) => ({ label: p.label, value: p.saved })),
      { yFormat: (val) => fmtDur(val), unit: 'saved' }
    );

    // Speed chart: line chart with area fill.
    $('chart-speed').innerHTML = lineChart(
      v.points.map((p) => ({ label: p.label, value: p.avgSpeed })),
      { yFormat: (val) => `${val.toFixed(2)}×`, baseline: 1.0 }
    );
  }

  // Shared chart geometry.
  const CW = 640, CH = 260, PAD_L = 52, PAD_R = 16, PAD_T = 18, PAD_B = 34;
  const plotW = CW - PAD_L - PAD_R;
  const plotH = CH - PAD_T - PAD_B;

  function niceTicks(min, max, count) {
    if (min === max) { max = min + 1; }
    const span = max - min;
    const step = span / count;
    const ticks = [];
    for (let i = 0; i <= count; i++) ticks.push(min + step * i);
    return ticks;
  }

  // Decide how many x labels to show so they never overlap.
  function labelStride(n) {
    if (n <= 12) return 1;
    return Math.ceil(n / 12);
  }

  function axisAndGrid(yMin, yMax, yFormat) {
    const ticks = niceTicks(yMin, yMax, 4);
    let g = '';
    for (const t of ticks) {
      const y = PAD_T + plotH - ((t - yMin) / (yMax - yMin)) * plotH;
      g += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${CW - PAD_R}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      g += `<text x="${PAD_L - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" font-family="'JetBrains Mono',monospace" fill="#888">${yFormat(t)}</text>`;
    }
    return g;
  }

  function xLabels(points) {
    const n = points.length;
    const stride = labelStride(n);
    const bandW = plotW / n;
    let g = '';
    for (let i = 0; i < n; i++) {
      if (i % stride !== 0 && i !== n - 1) continue;
      const x = PAD_L + bandW * i + bandW / 2;
      g += `<text x="${x.toFixed(1)}" y="${CH - 12}" text-anchor="middle" font-size="10" font-family="'JetBrains Mono',monospace" fill="#888">${points[i].label}</text>`;
    }
    return g;
  }

  function svgOpen() {
    return `<svg viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="xMidYMid meet" role="img">`;
  }

  function barChart(points, opts) {
    const vals = points.map((p) => p.value);
    const yMax = Math.max(1, ...vals) * 1.12;
    const yMin = 0;
    const yFormat = opts.yFormat || ((v) => String(Math.round(v)));
    const n = points.length;
    const bandW = plotW / n;
    const barW = Math.max(2, Math.min(38, bandW * 0.62));

    let bars = '';
    for (let i = 0; i < n; i++) {
      const h = ((points[i].value - yMin) / (yMax - yMin)) * plotH;
      const x = PAD_L + bandW * i + (bandW - barW) / 2;
      const y = PAD_T + plotH - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="url(#barGrad)"><title>${points[i].label}: ${yFormat(points[i].value)}</title></rect>`;
    }

    return svgOpen() +
      `<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#00d4aa"/><stop offset="100%" stop-color="#00a080"/>
      </linearGradient></defs>` +
      axisAndGrid(yMin, yMax, yFormat) +
      bars +
      xLabels(points) +
      '</svg>';
  }

  function lineChart(points, opts) {
    const vals = points.map((p) => p.value).filter((v) => v > 0);
    const dataMin = vals.length ? Math.min(...vals) : 1;
    const dataMax = vals.length ? Math.max(...vals) : 1;
    // pad the range, and include an optional baseline (e.g. 1.0x)
    let yMin = Math.min(dataMin, opts.baseline != null ? opts.baseline : dataMin);
    let yMax = dataMax;
    const pad = Math.max(0.1, (yMax - yMin) * 0.15);
    yMin = Math.max(0, yMin - pad);
    yMax = yMax + pad;
    if (yMax - yMin < 0.2) yMax = yMin + 0.2;
    const yFormat = opts.yFormat || ((v) => v.toFixed(2));

    const n = points.length;
    const bandW = plotW / n;
    const xOf = (i) => PAD_L + bandW * i + bandW / 2;
    const yOf = (val) => PAD_T + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

    // Build path over points that have a value (skip zero-watch days as gaps).
    const pts = points.map((p, i) => ({ x: xOf(i), y: yOf(p.value), v: p.value, label: p.label }));
    const shown = pts.filter((p) => p.v > 0);

    let path = '', area = '', dots = '';
    if (shown.length === 1) {
      // single point — draw a dot only
      const p = shown[0];
      dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#00d4aa"/>`;
    } else if (shown.length > 1) {
      path = 'M ' + shown.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ');
      const first = shown[0], last = shown[shown.length - 1];
      area = `M ${first.x.toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L ` +
        shown.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ') +
        ` L ${last.x.toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`;
      for (const p of shown) {
        dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#00d4aa"><title>${p.label}: ${yFormat(p.v)}</title></circle>`;
      }
    }

    // optional baseline marker
    let baseLine = '';
    if (opts.baseline != null && opts.baseline >= yMin && opts.baseline <= yMax) {
      const by = yOf(opts.baseline);
      baseLine = `<line x1="${PAD_L}" y1="${by.toFixed(1)}" x2="${CW - PAD_R}" y2="${by.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="4 4"/>` +
        `<text x="${CW - PAD_R}" y="${(by - 4).toFixed(1)}" text-anchor="end" font-size="9" font-family="'JetBrains Mono',monospace" fill="#666">${yFormat(opts.baseline)}</text>`;
    }

    return svgOpen() +
      `<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(0,212,170,0.28)"/><stop offset="100%" stop-color="rgba(0,212,170,0)"/>
      </linearGradient></defs>` +
      axisAndGrid(yMin, yMax, yFormat) +
      baseLine +
      (area ? `<path d="${area}" fill="url(#areaGrad)"/>` : '') +
      (path ? `<path d="${path}" fill="none" stroke="#00d4aa" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : '') +
      dots +
      xLabels(points) +
      '</svg>';
  }

  // ---- speed drop history (#3.5, #3.6) ------------------------------------
  //
  // Plot each manual slow-down as a bar positioned by time (x) with magnitude
  // `delta` (y). Hovering a bar reveals the transition, timestamp and video
  // title via an SVG <title>. A scrollable list mirrors the same data.

  // Filter drops to the current period (month scope), keeping chronology.
  function dropsForScope() {
    const drops = state.dropHistory.filter((d) => d && typeof d.time === 'number');
    if (state.scope === 'all') return drops;
    return drops.filter((d) => STA.monthKey(new Date(d.time)) === state.scope);
  }

  function renderDrops(v) {
    const drops = dropsForScope();
    $('drops-chart-desc').textContent = drops.length
      ? `${drops.length} drop(s) — ${v.label}`
      : `No drops — ${v.label}`;

    if (!drops.length) {
      $('chart-drops').innerHTML = '<div class="chart-empty">No speed drops recorded for this period. They appear when you manually slow a video down.</div>';
      $('drops-list').innerHTML = '<div class="chart-empty">Nothing to list yet.</div>';
      return;
    }

    $('chart-drops').innerHTML = dropChart(drops);

    // Newest first in the list.
    const rows = drops.slice().reverse().map((d) => {
      const mag = Math.abs(Number(d.delta) || (Number(d.from) - Number(d.to)) || 0);
      const when = fmtDateTime(d.time);
      const title = (d.title && String(d.title).trim()) || `video ${d.videoId || '—'}`;
      return `<div class="drop-item">
        <span class="trans">${fmtSpeed(d.from)}<span class="arrow">→</span>${fmtSpeed(d.to)}</span>
        <span class="delta">−${mag.toFixed(2)}</span>
        <span class="info">
          <span class="vtitle" title="${escapeAttr(title)}">${escapeHTML(title)}</span>
          <span class="vwhen">${when}</span>
        </span>
      </div>`;
    });
    $('drops-list').innerHTML = rows.join('');
  }

  // A time-positioned bar chart of drop magnitudes with rich hover tooltips.
  function dropChart(drops) {
    const times = drops.map((d) => d.time);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    const span = Math.max(1, tMax - tMin);
    const mags = drops.map((d) => Math.abs(Number(d.delta) || 0));
    const yMax = Math.max(0.1, ...mags) * 1.15;
    const yFormat = (val) => `−${val.toFixed(2)}×`;

    const xOf = (t) => PAD_L + ((t - tMin) / span) * plotW;
    const yOf = (m) => PAD_T + plotH - (m / yMax) * plotH;
    const barW = Math.max(3, Math.min(14, plotW / (drops.length * 1.6)));

    let bars = '';
    for (const d of drops) {
      const m = Math.abs(Number(d.delta) || 0);
      const x = xOf(d.time) - barW / 2;
      const y = yOf(m);
      const h = PAD_T + plotH - y;
      const title = (d.title && String(d.title).trim()) || `video ${d.videoId || '—'}`;
      const tip = `${STA.round2(d.from).toFixed(2)}× → ${STA.round2(d.to).toFixed(2)}×  (−${m.toFixed(2)})\n${fmtDateTime(d.time)}\n${title}`;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="url(#dropGrad)"><title>${escapeHTML(tip)}</title></rect>`;
      bars += `<circle cx="${xOf(d.time).toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#ff5252"><title>${escapeHTML(tip)}</title></circle>`;
    }

    // x labels: start / mid / end dates
    let xlab = '';
    const labs = [tMin, tMin + span / 2, tMax];
    for (let i = 0; i < labs.length; i++) {
      const x = xOf(labs[i]);
      const anchor = i === 0 ? 'start' : (i === labs.length - 1 ? 'end' : 'middle');
      xlab += `<text x="${x.toFixed(1)}" y="${CH - 12}" text-anchor="${anchor}" font-size="10" font-family="'JetBrains Mono',monospace" fill="#888">${shortDate(STA.dayKey(new Date(labs[i])))}</text>`;
    }

    return svgOpen() +
      `<defs><linearGradient id="dropGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ff5252"/><stop offset="100%" stop-color="rgba(255,82,82,0.25)"/>
      </linearGradient></defs>` +
      dropAxis(yMax, yFormat) +
      bars +
      xlab +
      '</svg>';
  }

  // Gridlines + y labels for the drop chart (0..yMax, red-ish theme).
  function dropAxis(yMax, yFormat) {
    const ticks = niceTicks(0, yMax, 4);
    let g = '';
    for (const t of ticks) {
      const y = PAD_T + plotH - (t / yMax) * plotH;
      g += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${CW - PAD_R}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      g += `<text x="${PAD_L - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" font-family="'JetBrains Mono',monospace" fill="#888">${yFormat(t)}</text>`;
    }
    return g;
  }

  // ---- per-video breakdown (#3.6, #3.7) -----------------------------------

  function renderVideos() {
    const entries = Object.entries(state.videoStats || {})
      .map(([id, v]) => {
        const real = Number(v && v.real) || 0;
        const content = Number(v && v.content) || 0;
        const saved = v && v.saved != null ? Number(v.saved) : Math.max(0, content - real);
        return {
          id,
          title: (v && v.title && String(v.title).trim()) || `video ${id}`,
          real,
          avg: real ? STA.round2(content / real) : 0,
          saved
        };
      })
      .filter((v) => v.real > 0)
      .sort((a, b) => b.saved - a.saved)
      .slice(0, 20);

    const cap = $('videos-caption');
    const table = $('video-table');

    if (!entries.length) {
      cap.textContent = 'No per-video data yet — watch a few videos with the trainer and they will show up here.';
      table.innerHTML = '';
      return;
    }

    cap.textContent = 'These are the videos where the Speed Trainer saved you the most time (top 20 by time saved).';
    let html = '<tr><th>Video</th><th>Watch time</th><th>Avg speed</th><th>Time saved</th></tr>';
    for (const v of entries) {
      html += `<tr>
        <td class="vname" title="${escapeAttr(v.title)}">${escapeHTML(v.title)}</td>
        <td class="num">${STA.formatDuration(v.real)}</td>
        <td class="num">${v.avg.toFixed(2)}×</td>
        <td class="num saved">${STA.formatDuration(v.saved)}</td>
      </tr>`;
    }
    table.innerHTML = html;
  }

  // ---- small text helpers --------------------------------------------------

  function fmtDateTime(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${shortDate(STA.dayKey(d))}, ${hh}:${mm}`;
  }

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, '&quot;');
  }

  // ---- goal snapshot recording (dedup) ------------------------------------
  //
  // Append a snapshot to goalHistory only when the target changed or a day has
  // passed since the last entry — so loads don't spam the history.

  function recordGoalSnapshot() {
    const fc = STA.forecastGoal(state.stats, state.targetSpeed, currentSpeedForForecast());
    const today = STA.dayKey(new Date());
    const last = state.goalHistory[state.goalHistory.length - 1];
    const targetChanged = !last || STA.round2(last.target) !== STA.round2(state.targetSpeed);
    const dayPassed = !last || STA.dayKey(new Date(last.t)) !== today;
    if (targetChanged || dayPassed) {
      state.goalHistory.push({
        t: Date.now(),
        target: STA.round2(state.targetSpeed),
        etaDays: fc.etaDays,
        etaDate: fc.etaDate,
        avgSpeed: fc.current
      });
      // keep history bounded
      if (state.goalHistory.length > 60) state.goalHistory = state.goalHistory.slice(-60);
      chrome.storage.local.set({ goalHistory: state.goalHistory });
    }
  }

  function currentSpeedForForecast() {
    return Number(state.currentSpeed) || STA.averageSpeed(state.stats);
  }

  // ---- target slider handlers ---------------------------------------------

  let commitTimer = null;
  function onTargetInput(e) {
    const v = STA.round2(parseFloat(e.target.value));
    state.targetSpeed = v;
    $('target-x').textContent = v.toFixed(2);
    renderGoals(); // live recompute (cheap)
  }

  function onTargetCommit() {
    // persist + record a fresh snapshot (target likely changed)
    chrome.storage.local.set({ targetSpeed: state.targetSpeed });
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      recordGoalSnapshot();
      renderGoalHistory();
    }, 250);
  }

  // ---- goals / forecast rendering -----------------------------------------

  function renderGoals() {
    const target = STA.round2(state.targetSpeed);
    const current = currentSpeedForForecast();
    $('target-x').textContent = target.toFixed(2);

    const fc = STA.forecastGoal(state.stats, target, current);

    // Progress bar
    const denom = Math.max(0.0001, target - 1.0);
    const pct = Math.max(0, Math.min(100, Math.round(((current - 1.0) / denom) * 100)));
    $('progress-pct').textContent = `${pct}%`;
    $('progress-fill').style.width = `${pct}%`;
    $('progress-cur').textContent = fmtSpeed(current);
    $('progress-tgt').textContent = fmtSpeed(target);

    // Feasibility badge
    const fb = $('feasible-badge');
    if (fc.reached) {
      fb.className = 'badge ok'; fb.textContent = '✓ Target reached';
    } else if (fc.feasible === true) {
      fb.className = 'badge ok'; fb.textContent = '✓ On track';
    } else if (fc.feasible === false) {
      fb.className = 'badge warn'; fb.textContent = '✕ Not on current path';
    } else {
      fb.className = 'badge conf-low'; fb.textContent = '• Needs more data';
    }

    // Confidence badge
    const cb = $('confidence-badge');
    cb.className = `badge conf-${fc.confidence}`;
    cb.textContent = `${fc.confidence} confidence`;

    // ETA blocks
    $('eta-date').textContent = fc.reached ? '—' : (fc.etaDate || '—');
    $('eta-days').textContent = fc.reached ? '0' : (fc.etaDays != null ? String(fc.etaDays) : '—');
    $('eta-perday').textContent = fc.perDay ? `+${fc.perDay.toFixed(3)}` : '—';

    $('forecast-explain').textContent = fc.explanation || '';

    // Disclaimer reflects reached/feasible state but always flags "estimate".
    $('forecast-disclaimer').innerHTML = fc.reached
      ? '⚠ Estimates elsewhere are projections, not guarantees. Nice work hitting this target.'
      : '⚠ This is an <strong>estimate</strong> from your recent trend — <strong>not a guarantee</strong>. Your actual date depends on how you keep watching.';

    renderRequiredProgress(fc);
    renderScenarios(fc);
    renderRecovery(fc);
    renderPlan(fc);
    renderGoalHistory();
  }

  // Active viewing days per week, from the meaningful daily series.
  function activeDaysPerWeek() {
    const series = state.dailySeries.filter((d) => d.real > 60);
    if (series.length < 2) return series.length ? 3.5 : 0; // rough default
    const first = new Date(series[0].day);
    const last = new Date(series[series.length - 1].day);
    const calSpan = Math.max(1, (last - first) / 86400000 + 1);
    const ratio = Math.min(1, series.length / calSpan);
    return Math.max(0.5, ratio * 7);
  }

  // #8.11–14: required per-active-day gain for 30/60/90 day windows vs current.
  function renderRequiredProgress(fc) {
    const target = fc.target;
    const current = fc.current;
    const gap = Math.max(0, target - current);
    const perWeek = activeDaysPerWeek();
    const curPerDay = fc.perDay || 0;

    const rows = [30, 60, 90].map((days) => {
      const activeDays = Math.max(1, (days / 7) * perWeek);
      const needed = gap / activeDays;
      const ok = curPerDay >= needed - 1e-6 && gap > 0;
      const reached = gap <= 0;
      return { days, needed, ok, reached };
    });

    let html = `<tr><th>Window</th><th>Needed gain / active day</th><th>Your pace</th><th>Verdict</th></tr>`;
    const cur = curPerDay > 0 ? `+${curPerDay.toFixed(3)}×` : '±0.000×';
    for (const r of rows) {
      let verdict, cls;
      if (r.reached) { verdict = 'reached'; cls = 'verdict-ok'; }
      else if (r.ok) { verdict = '✓ achievable'; cls = 'verdict-ok'; }
      else { verdict = '✕ too fast'; cls = 'verdict-no'; }
      html += `<tr>
        <td>${r.days} days</td>
        <td>${r.reached ? '—' : '+' + r.needed.toFixed(3) + '×'}</td>
        <td>${cur}</td>
        <td class="${cls}">${verdict}</td>
      </tr>`;
    }
    $('req-table').innerHTML = html;
  }

  // #8.19,20,28: illustrative scenarios by scaling pace / active days.
  function renderScenarios(fc) {
    const target = fc.target;
    const current = fc.current;
    const gap = Math.max(0, target - current);
    const perWeek = Math.max(0.5, activeDaysPerWeek());

    // Base per-active-day gain. If the user isn't trending up, assume a modest
    // achievable starting pace so the scenarios stay illustrative but useful.
    const basePerDay = fc.perDay > 0.0005 ? fc.perDay : 0.02;

    function eta(perDay, weekDays) {
      if (gap <= 0) return { days: 0, date: STA.dayKey(new Date()) };
      const activeDaysNeeded = gap / perDay;
      const calDays = Math.ceil(activeDaysNeeded / Math.max(0.15, weekDays / 7));
      const date = STA.dayKey(new Date(Date.now() + calDays * 86400000));
      return { days: calDays, date };
    }

    const scenarios = [
      { name: 'Steady', tag: 'Your current pace', perDay: basePerDay, week: perWeek, highlight: fc.feasible === true },
      { name: 'Motivated', tag: '+50% more viewing days', perDay: basePerDay, week: Math.min(7, perWeek * 1.5) },
      { name: 'Intense', tag: 'Bigger speed steps (+50%)', perDay: basePerDay * 1.5, week: perWeek }
    ];

    if (gap <= 0) {
      $('scenarios').innerHTML = `<div class="scenario highlight"><div class="name">Reached 🎉</div><div class="tag">You're already at or past your target.</div><div class="eta">Done</div></div>`;
      return;
    }

    $('scenarios').innerHTML = scenarios.map((sc) => {
      const e = eta(sc.perDay, sc.week);
      const illus = fc.perDay > 0.0005 ? '' : '<div class="etadate">assumes you start climbing</div>';
      return `<div class="scenario ${sc.highlight ? 'highlight' : ''}">
        <div class="name">${sc.name}</div>
        <div class="tag">${sc.tag}</div>
        <div class="eta">${e.days} days</div>
        <div class="etadate">≈ ${e.date}</div>
        ${illus}
      </div>`;
    }).join('');
  }

  // #8.21: recovery options when behind (infeasible, or ETA slipped).
  function renderRecovery(fc) {
    const behind = fc.feasible === false || goalDelayed();
    const section = $('recovery-section');
    if (!behind) { section.style.display = 'none'; return; }
    section.style.display = 'block';

    const items = [];
    const perWeek = Math.round(activeDaysPerWeek());
    items.push({ ico: '📅', text: `Watch on more days each week. You currently average about ${perWeek} active day(s)/week — adding one or two steadier days compounds your average-speed gains faster than longer single sessions.` });
    items.push({ ico: '⏫', text: 'Increase your step size a notch in the popup. Slightly larger nudges raise your average speed sooner, provided you don\'t have to slow back down often.' });
    items.push({ ico: '⏱️', text: 'Raise your level-up frequency (shorten the interval) so auto-progression pushes you upward more often — as long as the current speed still feels comfortable.' });
    if (fc.feasible === false) {
      items.unshift({ ico: '⚠️', text: 'Your recent trend is flat or downward, so the target isn\'t reachable on the current path. The changes below would turn the trend positive again.' });
    }
    $('recovery-list').innerHTML = items.map((i) =>
      `<div class="list-item"><span class="ico">${i.ico}</span><span>${i.text}</span></div>`).join('');
  }

  // #8.27,28: an actionable plan box derived from the data.
  function renderPlan(fc) {
    const items = [];
    const target = fc.target;

    if (fc.reached) {
      items.push({ ico: '🎯', text: `You've reached ${fmtSpeed(target)}. Raise the target slider to keep training — a small stretch (about +0.25×) keeps progress comfortable.` });
    } else if (fc.feasible === true) {
      items.push({ ico: '✅', text: `Keep your current habits: at +${(fc.perDay || 0).toFixed(3)}× per active day you're on track to reach ${fmtSpeed(target)} around ${fc.etaDate}.` });
      items.push({ ico: '📈', text: `To arrive sooner, add one more active viewing day per week (see the Motivated scenario above).` });
    } else if (fc.feasible === false) {
      items.push({ ico: '🔧', text: `Nudge your speed up a little more often so your average-speed trend turns positive — the forecast will then produce an ETA.` });
      items.push({ ico: '🗓️', text: `Aim for at least 3 steady viewing days a week; consistency matters more than long single sessions.` });
    } else {
      items.push({ ico: '🌱', text: `Watch on a few more days at varied speeds. Once there are 3+ meaningful days, a forecast and ETA will appear here.` });
    }

    // Data-driven extra: natural range headroom.
    const nr = STA.naturalSpeedRange(state.stats);
    if (!fc.reached && nr.max < target) {
      items.push({ ico: '🎚️', text: `Your comfortable range currently tops out near ${nr.max.toFixed(2)}×. Spend short bursts just above it to stretch your natural ceiling toward ${fmtSpeed(target)}.` });
    }

    $('plan-list').innerHTML = items.slice(0, 4).map((i) =>
      `<div class="list-item plan"><span class="ico">${i.ico}</span><span>${i.text}</span></div>`).join('');
  }

  // Did the newest ETA slip vs a previous entry for the same target?
  function goalDelayed() {
    const h = state.goalHistory;
    if (h.length < 2) return false;
    const last = h[h.length - 1];
    if (last.etaDays == null) return false;
    // find previous entry with same target and an ETA
    for (let i = h.length - 2; i >= 0; i--) {
      if (STA.round2(h[i].target) === STA.round2(last.target) && h[i].etaDays != null) {
        return last.etaDays > h[i].etaDays + 0.5;
      }
    }
    return false;
  }

  // #8.15,16,26,29: goal history with delay labels.
  function renderGoalHistory() {
    const h = state.goalHistory;
    const box = $('history-list');
    if (!h.length) {
      box.innerHTML = '<div class="empty-note">No history yet — snapshots are recorded as your forecast updates over time.</div>';
      return;
    }
    // Show newest first; compare each to the previous same-target ETA.
    const rows = h.slice().reverse().map((entry, idx, arr) => {
      const when = STA.dayKey(new Date(entry.t));
      const etaTxt = entry.etaDate || (entry.etaDays != null ? `${entry.etaDays}d` : 'no ETA');
      // previous chronological entry (arr is reversed, so next index is older)
      let deltaHTML = '';
      const older = arr.slice(idx + 1).find((e) => STA.round2(e.target) === STA.round2(entry.target) && e.etaDays != null);
      if (older && entry.etaDays != null) {
        const diff = entry.etaDays - older.etaDays;
        if (diff > 0) deltaHTML = `<span class="delay">delayed +${diff}d</span>`;
        else if (diff < 0) deltaHTML = `<span class="improve">sooner ${diff}d</span>`;
      }
      return `<div class="history-row">
        <span class="when">${when}</span>
        <span class="meta">→ ${fmtSpeed(entry.target)} · avg ${entry.avgSpeed != null ? entry.avgSpeed.toFixed(2) : '—'}× · ETA ${etaTxt}</span>
        ${deltaHTML}
      </div>`;
    });
    box.innerHTML = rows.join('');
  }

  // ---- go ------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
