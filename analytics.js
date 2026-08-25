// YouTube Speed Trainer - Shared Analytics Library
// Pure(ish) computation helpers shared by the content script and extension pages
// (popup, reports, shortcuts). Loaded as a plain script so it must not use ES
// module syntax. Everything is exposed on globalThis.STA.
//
// The single source of truth is chrome.storage.local. This file never touches
// storage directly (except the small load/save helpers at the bottom); it takes
// plain data objects and returns plain results, so it is trivially testable and
// reusable across every surface of the extension.

(function () {
  'use strict';

  const MIN_SPEED = 0.5;
  const MAX_SPEED = 4.0;

  // ---- generic helpers -----------------------------------------------------

  const round2 = (n) => Math.round(n * 100) / 100;
  const clampSpeed = (n) => Math.max(MIN_SPEED, Math.min(MAX_SPEED, n));
  const speedKey = (n) => round2(n).toFixed(2);

  // Local calendar day as YYYY-MM-DD (not UTC — a viewer's streak should follow
  // their own midnight).
  function dayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function monthKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // Format a duration in seconds into a compact human string.
  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (seconds < 3600) {
      const s = seconds % 60;
      return s ? `${mins}m ${s}s` : `${mins}m`;
    }
    const hrs = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (seconds < 86400) return m ? `${hrs}h ${m}m` : `${hrs}h`;
    const days = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return h ? `${days}d ${h}h` : `${days}d`;
  }

  function formatClock(seconds) {
    seconds = Math.floor(Math.max(0, seconds));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (seconds < 3600) return `${mins}:${String(secs).padStart(2, '0')}`;
    const hrs = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${hrs}:${String(m).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // ---- default state shapes ------------------------------------------------

  function emptyStats() {
    return {
      timeAtSpeed: {},   // speedKey -> real seconds watched at that speed
      daily: {},         // dayKey -> { real, content, maxSpeed }
      totalReal: 0,      // total real seconds watched (playing, foreground)
      totalContent: 0,   // total content seconds consumed (= sum real*speed)
      // Personal-average baseline: snapshot subtracted so a user can restart
      // their "personal speed" without deleting historical analytics.
      baselineReal: 0,
      baselineContent: 0,
      baselineResetAt: null
    };
  }

  function mergeStats(raw) {
    const s = emptyStats();
    if (raw && typeof raw === 'object') {
      s.timeAtSpeed = raw.timeAtSpeed && typeof raw.timeAtSpeed === 'object' ? raw.timeAtSpeed : {};
      s.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
      s.totalReal = Number(raw.totalReal) || 0;
      s.totalContent = Number(raw.totalContent) || 0;
      s.baselineReal = Number(raw.baselineReal) || 0;
      s.baselineContent = Number(raw.baselineContent) || 0;
      s.baselineResetAt = raw.baselineResetAt ?? null;
    }
    return s;
  }

  // ---- core analytics ------------------------------------------------------

  // Time saved (seconds) = content consumed minus real time spent.
  function timeSaved(stats) {
    return Math.max(0, (stats.totalContent || 0) - (stats.totalReal || 0));
  }

  // Weighted average playback speed over all recorded watch time.
  function averageSpeed(stats) {
    if (!stats.totalReal) return 1.0;
    return round2(stats.totalContent / stats.totalReal);
  }

  // Average speed *since the last personal-baseline reset* (issue #3: a user can
  // reset their personal average without losing history).
  function personalAverageSpeed(stats) {
    const real = (stats.totalReal || 0) - (stats.baselineReal || 0);
    const content = (stats.totalContent || 0) - (stats.baselineContent || 0);
    if (real <= 0) return 1.0;
    return round2(content / real);
  }

  function timeSavedSinceBaseline(stats) {
    const real = (stats.totalReal || 0) - (stats.baselineReal || 0);
    const content = (stats.totalContent || 0) - (stats.baselineContent || 0);
    return Math.max(0, content - real);
  }

  // The speed band where the user actually spends their watch time. Returns the
  // busiest contiguous window plus the single most-watched speed.
  function naturalSpeedRange(stats) {
    const entries = Object.entries(stats.timeAtSpeed || {})
      .map(([k, v]) => [parseFloat(k), Number(v) || 0])
      .filter(([, v]) => v > 0)
      .sort((a, b) => a[0] - b[0]);
    if (!entries.length) return { min: 1.0, max: 1.0, mode: 1.0, total: 0 };

    let total = 0, mode = entries[0][0], modeVal = 0;
    for (const [sp, v] of entries) {
      total += v;
      if (v > modeVal) { modeVal = v; mode = sp; }
    }
    // Trim the tails that together hold <15% of watch time so a couple of stray
    // seconds at 4x don't widen the "natural" range.
    const tail = total * 0.075;
    let lo = 0, hi = entries.length - 1, acc = 0;
    while (lo < hi && acc + entries[lo][1] < tail) { acc += entries[lo][1]; lo++; }
    acc = 0;
    while (hi > lo && acc + entries[hi][1] < tail) { acc += entries[hi][1]; hi--; }
    return { min: entries[lo][0], max: entries[hi][0], mode: round2(mode), total };
  }

  // Content seconds watched at or above a given speed — used by achievements so
  // that milestones require genuine viewing, not button-mashing.
  function contentAtOrAbove(stats, speed) {
    let real = 0;
    for (const [k, v] of Object.entries(stats.timeAtSpeed || {})) {
      if (parseFloat(k) >= speed - 0.001) real += (Number(v) || 0) * parseFloat(k);
    }
    return real;
  }

  // ---- daily series / trends ----------------------------------------------

  // Return a chronological array of { day, real, content, saved, avgSpeed, maxSpeed }.
  function dailySeries(stats) {
    return Object.keys(stats.daily || {})
      .sort()
      .map((day) => {
        const d = stats.daily[day] || {};
        const real = Number(d.real) || 0;
        const content = Number(d.content) || 0;
        return {
          day,
          real,
          content,
          saved: Math.max(0, content - real),
          avgSpeed: real ? round2(content / real) : 0,
          maxSpeed: Number(d.maxSpeed) || 0
        };
      });
  }

  // Aggregate the daily series by month for reports.
  function monthlySeries(stats) {
    const byMonth = {};
    for (const d of dailySeries(stats)) {
      const mk = d.day.slice(0, 7);
      const m = byMonth[mk] || (byMonth[mk] = { month: mk, real: 0, content: 0, days: 0, maxSpeed: 0 });
      m.real += d.real;
      m.content += d.content;
      m.days += d.real > 30 ? 1 : 0;
      m.maxSpeed = Math.max(m.maxSpeed, d.maxSpeed);
    }
    return Object.values(byMonth)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ ...m, saved: Math.max(0, m.content - m.real), avgSpeed: m.real ? round2(m.content / m.real) : 0 }));
  }

  // Simple ordinary-least-squares fit of y against an integer x index.
  function linearFit(points) {
    const n = points.length;
    if (n < 2) return { slope: 0, intercept: n ? points[0].y : 0, r2: 0, n };
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (const p of points) {
      sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
    }
    const denom = n * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    const rDen = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    const r = rDen === 0 ? 0 : (n * sxy - sx * sy) / rDen;
    return { slope, intercept, r2: r * r, n };
  }

  // ---- goal forecasting (issue #8) ----------------------------------------
  //
  // We model the user's *average speed per active day* over time and project it
  // forward with a linear fit. This gives an ETA to a target speed, a feasibility
  // verdict, and a confidence level — all explained in plain language.

  function forecastGoal(stats, targetSpeed, currentSpeed) {
    const series = dailySeries(stats).filter((d) => d.real > 60); // meaningful days only
    const current = round2(currentSpeed ?? averageSpeed(stats));
    const target = round2(targetSpeed);

    const base = {
      target,
      current,
      reached: current >= target,
      feasible: null,
      etaDays: null,
      etaDate: null,
      perDay: 0,
      confidence: 'low',
      dataDays: series.length,
      explanation: ''
    };

    if (base.reached) {
      base.feasible = true;
      base.confidence = 'high';
      base.explanation = `You've already reached ${target.toFixed(2)}×. Set a higher target to keep progressing.`;
      return base;
    }
    if (series.length < 3) {
      base.explanation = `Not enough history yet — watch on ${3 - series.length} more day(s) at varied speeds and a forecast will appear.`;
      return base;
    }

    // Fit average speed against day index.
    const points = series.map((d, i) => ({ x: i, y: d.avgSpeed }));
    const fit = linearFit(points);
    const perDay = fit.slope; // avg-speed increase per active day
    base.perDay = round2(perDay * 100) / 100;

    // Confidence from fit quality and amount of data.
    if (fit.r2 >= 0.5 && series.length >= 10) base.confidence = 'high';
    else if (fit.r2 >= 0.25 && series.length >= 5) base.confidence = 'medium';
    else base.confidence = 'low';

    if (perDay <= 0.0005) {
      base.feasible = false;
      base.explanation = `Your average speed isn't trending upward right now, so ${target.toFixed(2)}× isn't reachable on your current path. Try nudging speed up a little more often, or lengthen the level-up interval so gains stick.`;
      return base;
    }

    const projected = target - series[series.length - 1].avgSpeed;
    const activeDaysNeeded = projected / perDay;
    // Convert active watch-days into calendar days using how often the user
    // actually watches (active days / calendar span).
    const firstDay = new Date(series[0].day);
    const lastDay = new Date(series[series.length - 1].day);
    const calSpan = Math.max(1, (lastDay - firstDay) / 86400000 + 1);
    const activeRatio = Math.min(1, series.length / calSpan);
    const calendarDays = Math.ceil(activeDaysNeeded / Math.max(0.15, activeRatio));

    base.feasible = true;
    base.etaDays = calendarDays;
    const eta = new Date(lastDay.getTime() + calendarDays * 86400000);
    base.etaDate = dayKey(eta);
    base.explanation = `At your recent pace of +${(perDay).toFixed(3)}× per active viewing day (you watch about ${Math.round(activeRatio * 7)} day(s)/week), you should reach ${target.toFixed(2)}× around ${base.etaDate}.`;
    return base;
  }

  // ---- step-size recommendation (issue #4) --------------------------------
  //
  // Reads the manual speed-change log and recommends a step size that would
  // minimise how often the user has to press the controls. Two signals:
  //   • overshoot  — an increase quickly reversed by a decrease (step too big)
  //   • grinding   — long runs of same-direction presses (step too small)

  function recommendStepSize(speedChangeLog, currentStep) {
    const log = Array.isArray(speedChangeLog) ? speedChangeLog : [];
    const manual = log.filter((e) => e && (e.dir === 'up' || e.dir === 'down'));
    const cur = round2(currentStep || 0.05);

    const result = {
      value: cur,
      current: cur,
      changed: false,
      confidence: 'low',
      samples: manual.length,
      overshoots: 0,
      grinds: 0,
      avgRun: 0,
      explanation: '',
      benefit: ''
    };

    if (manual.length < 8) {
      result.explanation = `Keep adjusting speed manually — after about ${8 - manual.length} more change(s) we can suggest a step size tuned to how you watch.`;
      return result;
    }

    // Detect overshoots: an "up" immediately followed by a "down" within 20s.
    let overshoots = 0;
    for (let i = 1; i < manual.length; i++) {
      const prev = manual[i - 1], cur2 = manual[i];
      if (prev.dir === 'up' && cur2.dir === 'down' && (cur2.t - prev.t) < 20000) overshoots++;
    }

    // Detect grinding: runs of >=3 presses in the same direction.
    let runs = [], run = 1;
    for (let i = 1; i < manual.length; i++) {
      if (manual[i].dir === manual[i - 1].dir) run++;
      else { runs.push(run); run = 1; }
    }
    runs.push(run);
    const grinds = runs.filter((r) => r >= 3).length;
    const avgRun = runs.reduce((a, b) => a + b, 0) / runs.length;

    result.overshoots = overshoots;
    result.grinds = grinds;
    result.avgRun = round2(avgRun);

    const overshootRate = overshoots / manual.length;
    const STEPS = [0.02, 0.03, 0.05, 0.1, 0.15, 0.2, 0.25];
    let value = cur;
    if (overshootRate > 0.18) {
      // Overshooting a lot → smaller step for finer control.
      value = STEPS[Math.max(0, STEPS.indexOf(nearestStep(cur, STEPS)) - 1)];
      result.explanation = `You often nudge the speed up and then straight back down (${overshoots} times), which usually means the step is a touch coarse. A smaller ${value.toFixed(2)} step gives finer control so you land on the right speed first try.`;
      result.benefit = `Expect fewer over-corrections — roughly ${Math.round(overshootRate * 100)}% of your changes were quick reversals.`;
    } else if (avgRun >= 2.4 || grinds >= 2) {
      // Grinding through many presses → larger step.
      value = STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(nearestStep(cur, STEPS)) + 1)];
      result.explanation = `You tend to press the same direction several times in a row (average run of ${avgRun.toFixed(1)} presses). A larger ${value.toFixed(2)} step reaches your target speed in fewer taps.`;
      const est = Math.max(1, Math.round(avgRun - avgRun * (cur / value)));
      result.benefit = `Estimated ~${est} fewer press(es) each time you change speed.`;
    } else {
      result.explanation = `Your current ${cur.toFixed(2)} step already matches your habits well — you rarely overshoot or grind through many presses. No change recommended.`;
      result.benefit = `You're adjusting efficiently; keeping ${cur.toFixed(2)} is optimal.`;
    }

    value = round2(value);
    result.value = value;
    result.changed = Math.abs(value - cur) > 0.001;
    result.confidence = manual.length >= 30 ? 'high' : manual.length >= 15 ? 'medium' : 'low';
    return result;
  }

  function nearestStep(v, steps) {
    return steps.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), steps[0]);
  }

  // ---- level-up threshold recommendation (issue #5) -----------------------
  //
  // If the user frequently drops speed soon after a level-up, progression is too
  // aggressive → recommend a longer interval. If they cruise without dropping,
  // they can progress faster → recommend a shorter interval.

  const THRESHOLDS = [300, 600, 900, 1800];

  function recommendThreshold(dropHistory, currentThreshold, stats) {
    const drops = Array.isArray(dropHistory) ? dropHistory : [];
    const cur = currentThreshold || 600;
    const result = {
      value: cur,
      current: cur,
      changed: false,
      confidence: 'low',
      dropCount: drops.length,
      explanation: '',
      benefit: ''
    };

    const watchedHours = (stats?.totalReal || 0) / 3600;
    if (watchedHours < 0.25) {
      result.explanation = `Watch a bit more (about ${Math.max(1, Math.ceil((0.25 - watchedHours) * 60))} more min) and we'll tune how often you level up.`;
      return result;
    }

    // Drops per hour of watching is our proxy for "progression too fast".
    const dropsPerHour = drops.length / Math.max(0.25, watchedHours);
    const idx = THRESHOLDS.indexOf(nearestThreshold(cur));
    let value = cur;
    if (dropsPerHour > 1.5) {
      value = THRESHOLDS[Math.min(THRESHOLDS.length - 1, idx + 1)];
      result.explanation = `You slow down fairly often (~${dropsPerHour.toFixed(1)} drops/hour), a sign speed is climbing faster than comfortable. Leveling up every ${Math.round(value / 60)} min instead of ${Math.round(cur / 60)} lets each speed settle before the next bump.`;
      result.benefit = `Smoother progression with fewer moments where a video feels too fast.`;
    } else if (dropsPerHour < 0.4 && watchedHours > 0.5) {
      value = THRESHOLDS[Math.max(0, idx - 1)];
      result.explanation = `You rarely need to slow down (~${dropsPerHour.toFixed(1)} drops/hour), so you can safely progress quicker. Leveling up every ${Math.round(value / 60)} min gets you to higher speeds sooner.`;
      result.benefit = `Reach higher speeds — and bigger time savings — faster.`;
    } else {
      result.explanation = `Your level-up interval of ${Math.round(cur / 60)} min fits your comfort level — you neither stall nor slow down too often.`;
      result.benefit = `Balanced progression; keeping ${Math.round(cur / 60)} min is optimal.`;
    }

    result.value = value;
    result.changed = value !== cur;
    result.confidence = watchedHours >= 2 ? 'high' : watchedHours >= 0.75 ? 'medium' : 'low';
    return result;
  }

  function nearestThreshold(v) {
    return THRESHOLDS.reduce((best, t) => (Math.abs(t - v) < Math.abs(best - v) ? t : best), THRESHOLDS[0]);
  }

  // A combined "one-click" optimization scenario (issues #5.6, #5.9, #5.11).
  function combinedOptimization(speedChangeLog, dropHistory, stats, currentStep, currentThreshold) {
    const step = recommendStepSize(speedChangeLog, currentStep);
    const threshold = recommendThreshold(dropHistory, currentThreshold, stats);
    const bothConfident = step.confidence !== 'low' && threshold.confidence !== 'low';
    return {
      step,
      threshold,
      confidence: bothConfident ? 'high' : (step.confidence !== 'low' || threshold.confidence !== 'low' ? 'medium' : 'low'),
      summary: `Recommended setup: ${step.value.toFixed(2)} step, level up every ${Math.round(threshold.value / 60)} min. ` +
        `Together these aim to cut manual adjustments while keeping progression comfortable.`,
      benefit: [step.benefit, threshold.benefit].filter(Boolean).join(' ')
    };
  }

  // ---- achievements & gamification (issue #6) ------------------------------
  //
  // Every achievement's progress is computed from real viewing telemetry, so a
  // user cannot unlock anything by mashing the speed button. `hidden` ones keep
  // their requirement secret until earned.

  function achievementDefs() {
    return [
      // Speed milestones — require real content watched AT or above the speed.
      { id: 'speed_1_5x', cat: 'speed', icon: '🚗', title: 'Warming Up', desc: 'Watch 10 min of content at 1.5× or faster', goal: 600, get: (s) => contentAtOrAbove(s, 1.5) },
      { id: 'speed_2x', cat: 'speed', icon: '🏎️', title: 'Double Time', desc: 'Watch 20 min of content at 2× or faster', goal: 1200, get: (s) => contentAtOrAbove(s, 2.0) },
      { id: 'speed_2_5x', cat: 'speed', icon: '✈️', title: 'Cruising', desc: 'Watch 20 min of content at 2.5× or faster', goal: 1200, get: (s) => contentAtOrAbove(s, 2.5) },
      { id: 'speed_3x', cat: 'speed', icon: '🚀', title: 'Triple Threat', desc: 'Watch 30 min of content at 3× or faster', goal: 1800, get: (s) => contentAtOrAbove(s, 3.0) },
      { id: 'speed_3_5x', cat: 'speed', icon: '🛰️', title: 'Escape Velocity', desc: 'Watch 20 min of content at 3.5× or faster', goal: 1200, get: (s) => contentAtOrAbove(s, 3.5) },
      { id: 'speed_4x', cat: 'speed', icon: '⚡', title: 'Ludicrous Speed', desc: 'Watch 15 min of content at 4×', goal: 900, get: (s) => contentAtOrAbove(s, 4.0) },

      // Time-saved milestones.
      { id: 'saved_10m', cat: 'saved', icon: '⏱️', title: 'Time Nibbler', desc: 'Save 10 minutes overall', goal: 600, get: (s) => timeSaved(s) },
      { id: 'saved_1h', cat: 'saved', icon: '⏳', title: 'Hour Reclaimed', desc: 'Save 1 hour overall', goal: 3600, get: (s) => timeSaved(s) },
      { id: 'saved_5h', cat: 'saved', icon: '🕰️', title: 'Time Bandit', desc: 'Save 5 hours overall', goal: 18000, get: (s) => timeSaved(s) },
      { id: 'saved_24h', cat: 'saved', icon: '📅', title: 'A Day Saved', desc: 'Save a full 24 hours overall', goal: 86400, get: (s) => timeSaved(s) },

      // Total watch time.
      { id: 'watch_1h', cat: 'watch', icon: '🌱', title: 'Getting Started', desc: 'Watch 1 hour with the trainer', goal: 3600, get: (s) => s.totalReal || 0 },
      { id: 'watch_10h', cat: 'watch', icon: '🌿', title: 'Regular', desc: 'Watch 10 hours with the trainer', goal: 36000, get: (s) => s.totalReal || 0 },
      { id: 'watch_50h', cat: 'watch', icon: '🌳', title: 'Devotee', desc: 'Watch 50 hours with the trainer', goal: 180000, get: (s) => s.totalReal || 0 },

      // Streaks (progress supplied via streak.current, injected below).
      { id: 'streak_3', cat: 'streak', icon: '🔥', title: 'On a Roll', desc: 'Use the trainer 3 days in a row', goal: 3, streak: true },
      { id: 'streak_7', cat: 'streak', icon: '🔥', title: 'Week Warrior', desc: 'Use the trainer 7 days in a row', goal: 7, streak: true },
      { id: 'streak_30', cat: 'streak', icon: '🏆', title: 'Unstoppable', desc: 'Use the trainer 30 days in a row', goal: 30, streak: true },

      // Hidden / mystery achievements (requirement withheld until earned).
      { id: 'secret_marathon', cat: 'secret', icon: '🎬', title: 'Marathoner', desc: 'Watch 2 hours of content in a single day', hidden: true, goal: 7200, get: (s) => dailyMaxContent(s) },
      { id: 'secret_maxed', cat: 'secret', icon: '👑', title: 'Maxed Out', desc: 'Spend 5 minutes at the maximum 4× speed', hidden: true, goal: 300, get: (s) => (s.timeAtSpeed?.['4.00'] || 0) }
    ];
  }

  function dailyMaxContent(stats) {
    let max = 0;
    for (const d of Object.values(stats.daily || {})) max = Math.max(max, Number(d.content) || 0);
    return max;
  }

  // Evaluate all achievements against stats + streak. Returns an array with
  // progress info; `unlocked` merges in the persisted unlock map (id -> ts).
  function evaluateAchievements(stats, streak, unlockedMap) {
    const map = unlockedMap && typeof unlockedMap === 'object' ? unlockedMap : {};
    const streakCur = streak?.current || 0;
    return achievementDefs().map((def) => {
      const current = def.streak ? streakCur : def.get(stats);
      const pct = Math.min(100, Math.round((current / def.goal) * 100));
      const done = current >= def.goal;
      const wasUnlocked = map[def.id] != null;
      return {
        id: def.id,
        cat: def.cat,
        icon: def.icon,
        title: def.title,
        desc: def.desc,
        hidden: !!def.hidden,
        goal: def.goal,
        current: Math.round(current),
        pct,
        unlocked: done || wasUnlocked,
        unlockedAt: map[def.id] || null,
        // A "newly earned" flag the caller can use to fire a notification.
        newlyUnlocked: done && !wasUnlocked
      };
    });
  }

  // Derive a rank/role from how many achievements are unlocked (issue #6.10).
  function rankFromAchievements(achievements) {
    const n = achievements.filter((a) => a.unlocked).length;
    const ranks = [
      { min: 0, title: 'Rookie', icon: '🐣' },
      { min: 2, title: 'Apprentice', icon: '📀' },
      { min: 5, title: 'Accelerator', icon: '🎯' },
      { min: 8, title: 'Speedster', icon: '⚡' },
      { min: 12, title: 'Velocity Master', icon: '🚀' },
      { min: 16, title: 'Time Lord', icon: '👑' }
    ];
    let rank = ranks[0];
    for (const r of ranks) if (n >= r.min) rank = r;
    const next = ranks.find((r) => r.min > n) || null;
    return { title: rank.title, icon: rank.icon, unlocked: n, total: achievements.length, next };
  }

  // ---- streak maintenance --------------------------------------------------
  // Given the current streak object and today's key, decide the new streak.
  // A day "counts" once the caller has confirmed meaningful watch time.
  function bumpStreak(streak, today, yesterday) {
    const s = streak && typeof streak === 'object' ? { ...streak } : { current: 0, longest: 0, lastDay: null };
    if (s.lastDay === today) return s; // already counted today
    if (s.lastDay === yesterday) s.current = (s.current || 0) + 1;
    else s.current = 1;
    s.lastDay = today;
    s.longest = Math.max(s.longest || 0, s.current);
    return s;
  }

  // ---- exports -------------------------------------------------------------

  globalThis.STA = {
    MIN_SPEED, MAX_SPEED,
    round2, clampSpeed, speedKey, dayKey, monthKey,
    formatDuration, formatClock,
    emptyStats, mergeStats,
    timeSaved, averageSpeed, personalAverageSpeed, timeSavedSinceBaseline,
    naturalSpeedRange, contentAtOrAbove,
    dailySeries, monthlySeries, linearFit,
    forecastGoal,
    recommendStepSize, recommendThreshold, combinedOptimization,
    achievementDefs, evaluateAchievements, rankFromAchievements,
    bumpStreak, THRESHOLDS
  };
})();
