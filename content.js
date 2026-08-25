// YouTube Speed Trainer - Content Script
// Supports time-based progression and custom increments

(function() {
  'use strict';

  const DEFAULTS = {
    currentSpeed: 1.0,
    increment: 0.05,
    minSpeed: 0.5,
    maxSpeed: 4.0,
    timeThreshold: 600,    // 10 minutes in seconds
    watchedTime: 0,        // Cumulative watch time
    autoProgressionEnabled: true
  };

  // Default in-page keyboard bindings (issue #7). These mirror the manifest's
  // chrome.commands defaults; the customizer page overwrites this map. Each
  // binding is { code, alt, ctrl, shift, meta }.
  const DEFAULT_SHORTCUTS = {
    'increase-speed': { code: 'ArrowUp', alt: true, ctrl: false, shift: true, meta: false },
    'decrease-speed': { code: 'ArrowDown', alt: true, ctrl: false, shift: true, meta: false },
    'reset-speed': { code: 'KeyR', alt: true, ctrl: false, shift: true, meta: false },
    'toggle-auto': null
  };

  // How many of the biggest speed drops we keep around for display
  const MAX_DROPS = 5;
  // How much rolling history we retain for analytics / charts
  const MAX_DROP_HISTORY = 100;
  const MAX_SPEED_CHANGES = 500;
  const MAX_VIDEO_STATS = 200;

  let state = {
    currentSpeed: DEFAULTS.currentSpeed,
    increment: DEFAULTS.increment,
    timeThreshold: DEFAULTS.timeThreshold,
    watchedTime: DEFAULTS.watchedTime,
    autoProgressionEnabled: DEFAULTS.autoProgressionEnabled,
    speedDrops: [],        // finalized biggest drops: {from, to, delta, time, videoId, day, title}
    currentDrop: null,     // drop episode in progress: {from, to, time, videoId, title}
    dropHistory: [],       // rolling record of every finalized drop (for charts)
    speedChangeLog: [],    // manual adjustments: {t, from, to, dir, videoId} (for step-size optimization)
    videoStats: {},        // videoId -> {real, content, saved, lastSpeed, title, firstSeen, lastSeen}
    stats: null,           // analytics telemetry (see STA.emptyStats)
    streak: { current: 0, longest: 0, lastDay: null },
    achievementsUnlocked: {}, // id -> unlock timestamp
    customShortcuts: { ...DEFAULT_SHORTCUTS },
    lastActionAt: {},         // action -> timestamp, for debounce dedup
    videoId: null,
    videoTitle: null,
    lastAppliedSpeed: null,
    lastTimeUpdate: null,
    isTracking: false,
    statsDirty: false
  };

  // Round to 2 decimals (speeds are always at hundredth granularity)
  const round2 = (n) => Math.round(n * 100) / 100;

  // Get current video ID from URL
  function getVideoId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }

  // Best-effort current video title from the tab title.
  function getVideoTitle() {
    const t = (document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
    return t || null;
  }

  // Load settings from storage
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([
        'currentSpeed',
        'increment',
        'timeThreshold',
        'watchedTime',
        'autoProgressionEnabled',
        'speedDrops',
        'currentDrop',
        'dropHistory',
        'speedChangeLog',
        'videoStats',
        'stats',
        'streak',
        'achievementsUnlocked',
        'customShortcuts'
      ], (result) => {
        state.currentSpeed = result.currentSpeed ?? DEFAULTS.currentSpeed;
        state.increment = result.increment ?? DEFAULTS.increment;
        state.timeThreshold = result.timeThreshold ?? DEFAULTS.timeThreshold;
        state.watchedTime = result.watchedTime ?? DEFAULTS.watchedTime;
        state.autoProgressionEnabled = result.autoProgressionEnabled ?? DEFAULTS.autoProgressionEnabled;
        state.speedDrops = Array.isArray(result.speedDrops) ? result.speedDrops : [];
        state.currentDrop = result.currentDrop ?? null;
        state.dropHistory = Array.isArray(result.dropHistory) ? result.dropHistory : [];
        state.speedChangeLog = Array.isArray(result.speedChangeLog) ? result.speedChangeLog : [];
        state.videoStats = (result.videoStats && typeof result.videoStats === 'object') ? result.videoStats : {};
        state.stats = STA.mergeStats(result.stats);
        state.streak = (result.streak && typeof result.streak === 'object')
          ? result.streak : { current: 0, longest: 0, lastDay: null };
        state.achievementsUnlocked = (result.achievementsUnlocked && typeof result.achievementsUnlocked === 'object')
          ? result.achievementsUnlocked : {};
        state.customShortcuts = (result.customShortcuts && typeof result.customShortcuts === 'object')
          ? { ...DEFAULT_SHORTCUTS, ...result.customShortcuts } : { ...DEFAULT_SHORTCUTS };
        resolve();
      });
    });
  }

  // Save state to storage
  function saveState() {
    chrome.storage.local.set({
      currentSpeed: state.currentSpeed,
      watchedTime: state.watchedTime,
      speedDrops: state.speedDrops,
      currentDrop: state.currentDrop
    });
  }

  // Persist the analytics telemetry (called on a throttle from the watch loop).
  function saveStats() {
    chrome.storage.local.set({
      stats: state.stats,
      videoStats: state.videoStats,
      streak: state.streak,
      achievementsUnlocked: state.achievementsUnlocked
    });
    state.statsDirty = false;
  }

  // ---- Speed drop tracking -------------------------------------------------
  // A "speed drop" is a downward episode: one or more consecutive manual
  // decreases. We record the peak speed it started from and the lowest speed
  // it reached. The episode closes as soon as the speed goes back up (manually
  // or via auto level-up). We keep the MAX_DROPS biggest drops by magnitude.

  function saveDrops() {
    chrome.storage.local.set({
      speedDrops: state.speedDrops,
      currentDrop: state.currentDrop,
      dropHistory: state.dropHistory
    });
  }

  // ---- manual-adjustment logging (issue #4: step-size optimization) --------
  // Record every *manual* speed change so the recommender can study how the
  // user tends to reach their preferred speed. Auto level-ups are excluded.
  function logSpeedChange(from, to) {
    const dir = to > from ? 'up' : to < from ? 'down' : null;
    if (!dir) return;
    state.speedChangeLog.push({
      t: Date.now(),
      from: round2(from),
      to: round2(to),
      dir,
      videoId: state.videoId
    });
    if (state.speedChangeLog.length > MAX_SPEED_CHANGES) {
      state.speedChangeLog = state.speedChangeLog.slice(-MAX_SPEED_CHANGES);
    }
    chrome.storage.local.set({ speedChangeLog: state.speedChangeLog });
  }

  // ---- analytics telemetry (issues #3, #6, #8) -----------------------------
  // Fold `elapsed` real seconds watched at `speed` into every rollup we keep.
  function accumulateStats(elapsed, speed, videoId) {
    if (!(elapsed > 0)) return;
    const s = state.stats;
    const key = STA.speedKey(speed);
    const content = elapsed * speed;

    s.timeAtSpeed[key] = (s.timeAtSpeed[key] || 0) + elapsed;
    s.totalReal += elapsed;
    s.totalContent += content;

    const today = STA.dayKey(new Date());
    const d = s.daily[today] || (s.daily[today] = { real: 0, content: 0, maxSpeed: 0 });
    d.real += elapsed;
    d.content += content;
    d.maxSpeed = Math.max(d.maxSpeed, round2(state.currentSpeed));

    if (videoId) {
      const v = state.videoStats[videoId] || (state.videoStats[videoId] = {
        real: 0, content: 0, saved: 0, lastSpeed: speed,
        title: state.videoTitle || null, firstSeen: Date.now(), lastSeen: Date.now()
      });
      v.real += elapsed;
      v.content += content;
      v.saved = Math.max(0, v.content - v.real);
      v.lastSpeed = round2(speed);
      v.lastSeen = Date.now();
      if (!v.title && state.videoTitle) v.title = state.videoTitle;
      pruneVideoStats();
    }

    maybeBumpStreak(today, d.real);
    state.statsDirty = true;
  }

  // Keep only the most recently seen videos so storage stays bounded.
  function pruneVideoStats() {
    const ids = Object.keys(state.videoStats);
    if (ids.length <= MAX_VIDEO_STATS) return;
    ids.sort((a, b) => (state.videoStats[a].lastSeen || 0) - (state.videoStats[b].lastSeen || 0));
    for (const id of ids.slice(0, ids.length - MAX_VIDEO_STATS)) delete state.videoStats[id];
  }

  // A day counts toward the streak once ~1 minute has been watched on it.
  function maybeBumpStreak(today, todaysReal) {
    if (state.streak.lastDay === today || todaysReal < 60) return;
    const yesterday = STA.dayKey(new Date(Date.now() - 86400000));
    state.streak = STA.bumpStreak(state.streak, today, yesterday);
  }

  // Fire a one-shot notification + persist when an achievement is newly earned.
  function checkAchievements() {
    const list = STA.evaluateAchievements(state.stats, state.streak, state.achievementsUnlocked);
    let changed = false;
    for (const a of list) {
      if (a.newlyUnlocked) {
        state.achievementsUnlocked[a.id] = Date.now();
        changed = true;
        showNotification(
          `${a.icon} Achievement unlocked!<br><span style="font-size:13px;font-weight:600;">${a.title}</span>`,
          'levelup'
        );
      }
    }
    if (changed) chrome.storage.local.set({ achievementsUnlocked: state.achievementsUnlocked });
  }

  // Assemble the full analytics payload the popup/report surfaces read.
  function buildAnalyticsPayload() {
    const stats = state.stats;
    const achievements = STA.evaluateAchievements(stats, state.streak, state.achievementsUnlocked);
    return {
      stats,
      streak: state.streak,
      dropHistory: state.dropHistory,
      speedDrops: getTopDrops(),
      speedChangeLog: state.speedChangeLog,
      videoStats: state.videoStats,
      achievements,
      rank: STA.rankFromAchievements(achievements),
      settings: {
        increment: state.increment,
        timeThreshold: state.timeThreshold,
        autoProgressionEnabled: state.autoProgressionEnabled,
        currentSpeed: state.currentSpeed
      }
    };
  }

  // Merge the finalized drops with the in-progress episode, biggest first.
  function getTopDrops() {
    const all = state.speedDrops.slice();
    if (state.currentDrop) {
      const delta = round2(state.currentDrop.from - state.currentDrop.to);
      if (delta > 0) all.push({ ...state.currentDrop, delta });
    }
    all.sort((a, b) => b.delta - a.delta);
    return all.slice(0, MAX_DROPS);
  }

  // Close the open drop episode and file it among the biggest drops.
  function finalizeDrop() {
    const ep = state.currentDrop;
    if (!ep) return;
    state.currentDrop = null;

    const delta = round2(ep.from - ep.to);
    if (delta > 0) {
      const record = {
        from: ep.from,
        to: ep.to,
        delta,
        time: ep.time,
        videoId: ep.videoId,
        title: ep.title || null
      };
      // Top-N biggest drops (for the popup's compact list).
      state.speedDrops.push(record);
      state.speedDrops.sort((a, b) => b.delta - a.delta);
      if (state.speedDrops.length > MAX_DROPS) {
        state.speedDrops = state.speedDrops.slice(0, MAX_DROPS);
      }
      // Full rolling history (for the chart & analytics).
      state.dropHistory.push(record);
      if (state.dropHistory.length > MAX_DROP_HISTORY) {
        state.dropHistory = state.dropHistory.slice(-MAX_DROP_HISTORY);
      }
    }
    saveDrops();
  }

  // Feed every speed change through here so drops are tracked centrally.
  function trackSpeedChange(oldSpeed, newSpeed) {
    const from = round2(oldSpeed);
    const to = round2(newSpeed);

    if (to < from) {
      // Going down: open a new episode or extend the current trough lower.
      if (!state.currentDrop) {
        state.currentDrop = { from, to, time: Date.now(), videoId: state.videoId, title: state.videoTitle };
      } else {
        state.currentDrop.to = to;
      }
      saveDrops();
    } else if (to > from) {
      // Going up: the drop episode is over.
      finalizeDrop();
    }
  }

  // Get the video element
  function getVideo() {
    return document.querySelector('video.html5-main-video') 
        || document.querySelector('video.video-stream')
        || document.querySelector('#movie_player video')
        || document.querySelector('video');
  }

  // Check if video is ready to accept playbackRate changes
  function isVideoReady(video) {
    if (!video) return false;
    
    // Video must have metadata loaded (readyState >= 1)
    // AND have a valid duration (not NaN, not 0, not Infinity)
    // AND not be in an error state
    return video.readyState >= 1 && 
           video.duration > 0 && 
           isFinite(video.duration) &&
           !video.error;
  }

  // Apply speed to video (only when safe)
  function applySpeed(video, speed) {
    if (!video) return false;
    
    // CRITICAL: Don't set playbackRate before video is ready
    // This prevents the black screen / initialization bug
    if (!isVideoReady(video)) {
      return false;
    }
    
    const targetSpeed = Math.max(DEFAULTS.minSpeed, Math.min(DEFAULTS.maxSpeed, speed ?? state.currentSpeed));
    
    // Only update if different (avoid unnecessary writes)
    if (Math.abs(video.playbackRate - targetSpeed) > 0.001) {
      video.playbackRate = targetSpeed;
      state.lastAppliedSpeed = targetSpeed;
      console.log(`[Speed Trainer] Speed set to ${targetSpeed.toFixed(2)}x`);
      return true;
    }
    return false;
  }

  // Safely apply speed (used by popup commands)
  // Waits for video to be ready if necessary
  function safeApplySpeed(video, speed, callback) {
    if (!video) {
      callback?.(false, null);
      return;
    }
    
    // If already ready, apply immediately
    if (isVideoReady(video)) {
      video.playbackRate = speed;
      state.lastAppliedSpeed = speed;
      callback?.(true, video.playbackRate);
      return;
    }
    
    // Otherwise, wait for loadedmetadata event
    const handler = () => {
      video.removeEventListener('loadedmetadata', handler);
      // Small delay to ensure YouTube's player is also ready
      setTimeout(() => {
        if (isVideoReady(video)) {
          video.playbackRate = speed;
          state.lastAppliedSpeed = speed;
          callback?.(true, video.playbackRate);
        } else {
          callback?.(false, null);
        }
      }, 100);
    };
    
    video.addEventListener('loadedmetadata', handler);
    
    // Timeout fallback - don't wait forever
    setTimeout(() => {
      video.removeEventListener('loadedmetadata', handler);
      if (isVideoReady(video)) {
        video.playbackRate = speed;
        callback?.(true, video.playbackRate);
      } else {
        callback?.(false, null);
      }
    }, 3000);
  }

  // Format time for display
  function formatTime(seconds) {
    seconds = Math.floor(seconds);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Show notification
  function showNotification(message, type = 'info') {
    const existing = document.getElementById('speed-trainer-notification');
    if (existing) existing.remove();

    const colors = {
      info: { bg: 'rgba(0, 212, 170, 0.15)', border: 'rgba(0, 212, 170, 0.3)', text: '#00d4aa' },
      success: { bg: 'rgba(0, 212, 170, 0.2)', border: 'rgba(0, 212, 170, 0.5)', text: '#00d4aa' },
      levelup: { bg: 'linear-gradient(135deg, rgba(0, 212, 170, 0.3) 0%, rgba(0, 160, 128, 0.2) 100%)', border: 'rgba(0, 212, 170, 0.6)', text: '#00d4aa' },
      speed: { bg: 'rgba(0, 0, 0, 0.85)', border: 'rgba(0, 212, 170, 0.5)', text: '#00d4aa' }
    };
    
    const style = colors[type] || colors.info;

    const notification = document.createElement('div');
    notification.id = 'speed-trainer-notification';
    notification.innerHTML = message;
    notification.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: ${style.bg};
      color: ${style.text};
      padding: 14px 20px;
      border-radius: 10px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 14px;
      font-weight: 600;
      z-index: 999999;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      border: 1px solid ${style.border};
      animation: slideIn 0.3s ease-out;
      backdrop-filter: blur(10px);
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    `;
    document.head.appendChild(styleEl);
    document.body.appendChild(notification);

    // Shorter duration for speed notifications
    const duration = type === 'speed' ? 1500 : 3500;

    setTimeout(() => {
      notification.style.animation = 'slideIn 0.3s ease-out reverse';
      setTimeout(() => notification.remove(), 300);
    }, duration);
  }

  // Show speed overlay (centered, large, brief)
  function showSpeedOverlay(speed, direction) {
    const existing = document.getElementById('speed-trainer-overlay');
    if (existing) existing.remove();

    const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '';
    const color = direction === 'up' ? '#00d4aa' : direction === 'down' ? '#ff6b6b' : '#00d4aa';

    const overlay = document.createElement('div');
    overlay.id = 'speed-trainer-overlay';
    overlay.innerHTML = `
      <div style="font-size: 14px; opacity: 0.7; margin-bottom: 4px;">Speed</div>
      <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
        ${arrow ? `<span style="color: ${color}; font-size: 24px;">${arrow}</span>` : ''}
        <span style="font-size: 48px; font-weight: 700;">${speed.toFixed(2)}×</span>
      </div>
    `;
    overlay.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.8);
      background: rgba(0, 0, 0, 0.9);
      color: #fff;
      padding: 24px 40px;
      border-radius: 16px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      text-align: center;
      z-index: 9999999;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      border: 2px solid ${color};
      animation: speedPop 0.2s ease-out forwards;
      pointer-events: none;
    `;

    // Add animation
    const styleEl = document.createElement('style');
    styleEl.id = 'speed-trainer-overlay-style';
    styleEl.textContent = `
      @keyframes speedPop {
        0% { transform: translate(-50%, -50%) scale(0.8); opacity: 0; }
        100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      }
      @keyframes speedFade {
        0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(0.9); opacity: 0; }
      }
    `;
    
    // Remove old style if exists
    const oldStyle = document.getElementById('speed-trainer-overlay-style');
    if (oldStyle) oldStyle.remove();
    
    document.head.appendChild(styleEl);
    document.body.appendChild(overlay);

    // Fade out after 800ms
    setTimeout(() => {
      overlay.style.animation = 'speedFade 0.3s ease-out forwards';
      setTimeout(() => overlay.remove(), 300);
    }, 800);
  }

  // Change speed by increment (used by keyboard shortcuts)
  function changeSpeedByIncrement(direction) {
    const video = getVideo();
    const delta = direction === 'up' ? state.increment : -state.increment;
    const newSpeed = Math.max(DEFAULTS.minSpeed, Math.min(DEFAULTS.maxSpeed, state.currentSpeed + delta));
    const roundedSpeed = Math.round(newSpeed * 100) / 100;
    
    if (roundedSpeed === state.currentSpeed) {
      // At limit, show current speed anyway
      showSpeedOverlay(roundedSpeed, null);
      return { success: false, speed: roundedSpeed, reason: 'at_limit' };
    }

    trackSpeedChange(state.currentSpeed, roundedSpeed);
    logSpeedChange(state.currentSpeed, roundedSpeed);
    state.currentSpeed = roundedSpeed;
    chrome.storage.local.set({ currentSpeed: roundedSpeed });

    // Apply if video is ready
    if (video && isVideoReady(video)) {
      video.playbackRate = roundedSpeed;
      state.lastAppliedSpeed = roundedSpeed;
    }
    
    // Show overlay
    showSpeedOverlay(roundedSpeed, direction);
    
    console.log(`[Speed Trainer] Keyboard: Speed ${direction} to ${roundedSpeed.toFixed(2)}x`);
    return { success: true, speed: roundedSpeed };
  }

  // Reset speed to default (used by keyboard shortcut)
  function resetSpeedToDefault() {
    const video = getVideo();
    // Resetting to baseline ends any drop episode in progress (we don't treat
    // the reset itself as a drop — it's a deliberate "start over", not a struggle).
    finalizeDrop();
    state.currentSpeed = DEFAULTS.currentSpeed;

    chrome.storage.local.set({ currentSpeed: DEFAULTS.currentSpeed });
    
    if (video && isVideoReady(video)) {
      video.playbackRate = DEFAULTS.currentSpeed;
      state.lastAppliedSpeed = DEFAULTS.currentSpeed;
    }
    
    showSpeedOverlay(DEFAULTS.currentSpeed, null);
    console.log(`[Speed Trainer] Keyboard: Speed reset to ${DEFAULTS.currentSpeed}x`);
    return { success: true, speed: DEFAULTS.currentSpeed };
  }

  // Toggle auto-progression (an "Activate Extension" style shortcut, issue #7).
  function toggleAutoProgression() {
    state.autoProgressionEnabled = !state.autoProgressionEnabled;
    chrome.storage.local.set({ autoProgressionEnabled: state.autoProgressionEnabled });
    showNotification(
      `Auto-progression ${state.autoProgressionEnabled ? 'ON ▶' : 'OFF ⏸'}`,
      state.autoProgressionEnabled ? 'success' : 'info'
    );
    return { success: true, autoProgressionEnabled: state.autoProgressionEnabled };
  }

  // ---- shortcut dispatch (issue #7) ---------------------------------------
  // Both chrome.commands (background) and the in-page keydown listener funnel
  // through here. A short per-action debounce means a binding that matches BOTH
  // paths (e.g. the shared defaults) only fires once.
  function runAction(action) {
    const now = Date.now();
    if (state.lastActionAt[action] && now - state.lastActionAt[action] < 250) {
      return { success: false, reason: 'debounced' };
    }
    state.lastActionAt[action] = now;
    switch (action) {
      case 'increase-speed': return changeSpeedByIncrement('up');
      case 'decrease-speed': return changeSpeedByIncrement('down');
      case 'reset-speed': return resetSpeedToDefault();
      case 'toggle-auto': return toggleAutoProgression();
      default: return { success: false, reason: 'unknown_action' };
    }
  }

  // Does a keyboard event match a stored binding?
  function eventMatchesBinding(e, binding) {
    if (!binding || !binding.code) return false;
    return e.code === binding.code &&
      e.altKey === !!binding.alt &&
      e.ctrlKey === !!binding.ctrl &&
      e.shiftKey === !!binding.shift &&
      e.metaKey === !!binding.meta;
  }

  // Ignore shortcuts while the user is typing (search box, comments, etc.).
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function handleShortcutKeydown(e) {
    if (isTypingTarget(e.target)) return;
    for (const [action, binding] of Object.entries(state.customShortcuts)) {
      if (eventMatchesBinding(e, binding)) {
        e.preventDefault();
        e.stopPropagation();
        runAction(action);
        return;
      }
    }
  }

  // Check if threshold reached and level up
  function checkAndLevelUp() {
    // Issue #2: auto-progression can be switched off; time still accrues but we
    // don't bump the speed.
    if (!state.autoProgressionEnabled) return;
    if (state.watchedTime >= state.timeThreshold) {
      const newSpeed = Math.min(DEFAULTS.maxSpeed, state.currentSpeed + state.increment);
      const roundedSpeed = Math.round(newSpeed * 100) / 100;
      
      if (roundedSpeed !== state.currentSpeed) {
        // Speed is going up — close any drop episode that was still open.
        finalizeDrop();
        state.currentSpeed = roundedSpeed;
        state.watchedTime = 0; // Reset for next level
        
        saveState();
        
        // Apply new speed immediately
        const video = getVideo();
        if (video) {
          applySpeed(video, roundedSpeed);
        }
        
        showNotification(
          `⚡ Level Up! <span style="font-size: 18px; margin-left: 8px;">${roundedSpeed.toFixed(2)}×</span>`,
          'levelup'
        );
        
        console.log(`[Speed Trainer] 🎉 Level up! New speed: ${roundedSpeed.toFixed(2)}x`);
      } else {
        // Already at max speed
        state.watchedTime = 0;
        saveState();
        showNotification('Maximum speed reached! 🏆', 'success');
      }
    }
  }

  // Track watch time
  function trackWatchTime(video) {
    // Don't track if video isn't ready or isn't playing
    if (!video || !isVideoReady(video) || video.paused || video.ended) {
      state.isTracking = false;
      return;
    }

    const now = Date.now();
    
    if (state.isTracking && state.lastTimeUpdate) {
      // Calculate time elapsed since last update
      const elapsed = (now - state.lastTimeUpdate) / 1000;
      
      // Only count if elapsed time is reasonable (< 2 seconds between updates)
      // This prevents counting time when tab was in background
      if (elapsed > 0 && elapsed < 2) {
        state.watchedTime += elapsed;

        // Fold this slice into the analytics rollups (real vs content time,
        // per-video, daily, streak) at the speed actually playing.
        const playingSpeed = STA.round2(video.playbackRate || state.currentSpeed);
        accumulateStats(elapsed, playingSpeed, state.videoId);

        // Check for level up
        checkAndLevelUp();

        // Save periodically (every ~5 seconds to reduce writes)
        if (Math.floor(state.watchedTime) % 5 === 0) {
          chrome.storage.local.set({ watchedTime: state.watchedTime });
        }
        // Persist analytics + evaluate achievements on the same cadence.
        if (state.statsDirty && Math.floor(state.stats.totalReal) % 5 === 0) {
          checkAchievements();
          saveStats();
        }
      }
    }
    
    state.lastTimeUpdate = now;
    state.isTracking = true;
  }

  // Handle video change
  function handleVideoChange() {
    const newVideoId = getVideoId();
    
    if (newVideoId && newVideoId !== state.videoId) {
      state.videoId = newVideoId;
      state.videoTitle = getVideoTitle();
      state.isTracking = false;
      state.lastTimeUpdate = null;
      console.log(`[Speed Trainer] New video: ${newVideoId}`);
    } else if (newVideoId && !state.videoTitle) {
      // Title often loads a beat after the id — pick it up when it appears.
      state.videoTitle = getVideoTitle();
    }
  }

  // Main update loop
  function update() {
    handleVideoChange();
    
    const video = getVideo();
    if (video) {
      applySpeed(video, state.currentSpeed);
      trackWatchTime(video);

      // 👉 NEU: Speed an Background senden
    chrome.runtime.sendMessage({
      type: "UPDATE_BADGE",
      speed: video.playbackRate
    });
    }
  }

  // Message listener for popup and keyboard commands
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Speed Trainer] Message:', message.type);
    
    const video = getVideo();
    
    switch (message.type) {
      case 'GET_STATE':
        sendResponse({
          currentSpeed: state.currentSpeed,
          increment: state.increment,
          timeThreshold: state.timeThreshold,
          watchedTime: state.watchedTime,
          autoProgressionEnabled: state.autoProgressionEnabled,
          speedDrops: getTopDrops(),
          actualSpeed: video ? video.playbackRate : null,
          isPlaying: video ? !video.paused : false,
          hasVideo: !!video,
          videoId: state.videoId
        });
        break;

      // Live analytics snapshot (freshest data, before the periodic save).
      case 'GET_ANALYTICS':
        checkAchievements();
        saveStats();
        sendResponse(buildAnalyticsPayload());
        break;

      case 'SET_SPEED':
        const newSpeed = Math.max(DEFAULTS.minSpeed, Math.min(DEFAULTS.maxSpeed, message.speed));
        trackSpeedChange(state.currentSpeed, newSpeed);
        logSpeedChange(state.currentSpeed, newSpeed);
        state.currentSpeed = newSpeed;
        chrome.storage.local.set({ currentSpeed: newSpeed });
        
        // Use safe apply - only set if video is ready
        if (video && isVideoReady(video)) {
          video.playbackRate = newSpeed;
          state.lastAppliedSpeed = newSpeed;
          sendResponse({ 
            success: true, 
            currentSpeed: newSpeed, 
            actualSpeed: video.playbackRate 
          });
        } else {
          // Speed saved, will apply when video is ready (via update loop)
          sendResponse({ 
            success: true, 
            currentSpeed: newSpeed, 
            actualSpeed: null,
            pending: true 
          });
        }
        break;
        
      case 'SET_INCREMENT':
        state.increment = message.increment;
        chrome.storage.local.set({ increment: message.increment });
        sendResponse({ success: true });
        break;
        
      case 'SET_TIME_THRESHOLD':
        state.timeThreshold = message.timeThreshold;
        chrome.storage.local.set({ timeThreshold: message.timeThreshold });
        sendResponse({ success: true });
        break;

      case 'SET_AUTO_PROGRESSION':
        state.autoProgressionEnabled = !!message.enabled;
        chrome.storage.local.set({ autoProgressionEnabled: state.autoProgressionEnabled });
        sendResponse({ success: true, autoProgressionEnabled: state.autoProgressionEnabled });
        break;

      // Issue #3: reset the *personal average* baseline only — analytics history
      // (drops, time saved, per-video data) is preserved.
      case 'RESET_PERSONAL_AVERAGE':
        state.stats.baselineReal = state.stats.totalReal;
        state.stats.baselineContent = state.stats.totalContent;
        state.stats.baselineResetAt = Date.now();
        saveStats();
        sendResponse({ success: true });
        break;

      // Issue #3: full analytics wipe (kept separate from settings reset so the
      // popup can require an explicit confirmation).
      case 'RESET_HISTORY':
        state.speedDrops = [];
        state.currentDrop = null;
        state.dropHistory = [];
        state.speedChangeLog = [];
        state.videoStats = {};
        state.stats = STA.emptyStats();
        state.streak = { current: 0, longest: 0, lastDay: null };
        state.achievementsUnlocked = {};
        chrome.storage.local.set({
          speedDrops: [], currentDrop: null, dropHistory: [], speedChangeLog: [],
          videoStats: {}, stats: state.stats, streak: state.streak, achievementsUnlocked: {}
        });
        sendResponse({ success: true });
        break;

      case 'RESET':
        state.currentSpeed = DEFAULTS.currentSpeed;
        state.increment = DEFAULTS.increment;
        state.timeThreshold = DEFAULTS.timeThreshold;
        state.watchedTime = 0;
        state.autoProgressionEnabled = DEFAULTS.autoProgressionEnabled;
        state.speedDrops = [];
        state.currentDrop = null;
        state.dropHistory = [];
        state.speedChangeLog = [];
        state.videoStats = {};
        state.stats = STA.emptyStats();
        state.streak = { current: 0, longest: 0, lastDay: null };
        state.achievementsUnlocked = {};

        chrome.storage.local.set({
          currentSpeed: DEFAULTS.currentSpeed,
          increment: DEFAULTS.increment,
          timeThreshold: DEFAULTS.timeThreshold,
          watchedTime: 0,
          autoProgressionEnabled: DEFAULTS.autoProgressionEnabled,
          speedDrops: [],
          currentDrop: null,
          dropHistory: [],
          speedChangeLog: [],
          videoStats: {},
          stats: state.stats,
          streak: state.streak,
          achievementsUnlocked: {}
        });
        
        // Only apply if video is ready
        if (video && isVideoReady(video)) {
          video.playbackRate = DEFAULTS.currentSpeed;
          state.lastAppliedSpeed = DEFAULTS.currentSpeed;
        }
        
        sendResponse({ success: true });
        break;
        
      case 'PING':
        sendResponse({ alive: true, hasVideo: !!video });
        break;
      
      // Keyboard command handling (from chrome.commands via background.js)
      case 'KEYBOARD_COMMAND':
        sendResponse(runAction(message.command));
        break;

      // The customizer saved new bindings — apply them live (issue #7.15).
      case 'SHORTCUTS_UPDATED':
        state.customShortcuts = { ...DEFAULT_SHORTCUTS, ...(message.shortcuts || {}) };
        sendResponse({ success: true });
        break;
    }
    
    return true;
  });

  // Initialize
  async function init() {
    await loadSettings();
    console.log(`[Speed Trainer] Initialized at ${state.currentSpeed.toFixed(2)}x`);
    console.log(`[Speed Trainer] Time threshold: ${formatTime(state.timeThreshold)}, Watched: ${formatTime(state.watchedTime)}`);
    
    // Run update loop (500ms for smooth tracking)
    setInterval(update, 500);
    
    // Watch for URL changes
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        handleVideoChange();
      }
    }).observe(document.body, { subtree: true, childList: true });
    
    // In-page custom keyboard shortcuts (issue #7). Capture phase so we can beat
    // YouTube's own handlers for the chosen combos.
    window.addEventListener('keydown', handleShortcutKeydown, true);

    // Keep custom shortcuts in sync if changed from the customizer page while a
    // YouTube tab is already open.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.customShortcuts) {
        state.customShortcuts = { ...DEFAULT_SHORTCUTS, ...(changes.customShortcuts.newValue || {}) };
      }
      if (area === 'local' && changes.autoProgressionEnabled) {
        state.autoProgressionEnabled = changes.autoProgressionEnabled.newValue ?? DEFAULTS.autoProgressionEnabled;
      }
    });

    // Save state before page unload
    window.addEventListener('beforeunload', () => { saveState(); saveStats(); });
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
