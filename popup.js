// YouTube Speed Trainer - Popup Script
// Tabs: Trainer (speed + settings + auto-progression), Insights (analytics,
// recommendations, speed drops, resets), Awards (rank, streak, achievements).

const DEFAULTS = {
  currentSpeed: 1.0,
  increment: 0.05,
  minSpeed: 0.5,
  maxSpeed: 4.0,
  timeThreshold: 600,
  watchedTime: 0
};

const DEFAULT_STEP_SIZES = [0.05, 0.1, 0.2];
const MAX_STEP_SIZES = 7;
const SHARE_URL = 'https://chrome.google.com/webstore'; // generic link for social intents

let currentState = {
  speed: DEFAULTS.currentSpeed,
  increment: DEFAULTS.increment,
  timeThreshold: DEFAULTS.timeThreshold,
  watchedTime: DEFAULTS.watchedTime,
  autoProgressionEnabled: true,
  customStepSizes: DEFAULT_STEP_SIZES.slice(),
  speedDrops: [],
  analytics: null,
  isOnYouTube: false,
  tabId: null
};

// ---------- formatting helpers ----------

function formatTime(seconds) {
  seconds = Math.floor(seconds);
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function fmtDur(s) { return globalThis.STA ? STA.formatDuration(s) : `${Math.round(s)}s`; }

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ---------- speed / progress display ----------

function updateSpeedDisplay(speed) {
  const intPart = Math.floor(speed);
  const decPart = Math.round((speed - intPart) * 100);
  document.getElementById('speed-int').textContent = intPart;
  document.getElementById('speed-dec').textContent = decPart.toString().padStart(2, '0');
}

function updateProgressUI(watchedTime, threshold) {
  const progressBar = document.getElementById('progress-bar');
  const progressTime = document.getElementById('progress-time');
  const progressHint = document.getElementById('progress-hint');

  const progress = Math.min(100, (watchedTime / threshold) * 100);
  const remaining = Math.max(0, threshold - watchedTime);

  progressBar.style.width = `${progress}%`;
  progressTime.textContent = `${formatTime(watchedTime)} / ${formatTime(threshold)}`;

  if (!currentState.autoProgressionEnabled) {
    progressHint.textContent = '⏸ Auto-progression is off — speed stays put';
  } else if (progress >= 100) {
    progressHint.textContent = '🎉 Level up! Speed will increase shortly';
  } else if (progress >= 75) {
    progressHint.textContent = `Almost there! ${formatTime(remaining)} to go`;
  } else if (progress >= 50) {
    progressHint.textContent = 'Halfway! Keep watching';
  } else {
    progressHint.textContent = 'Watch videos to fill the bar and level up';
  }
}

// ---------- step sizes (issue #4: multiple custom step sizes) ----------

function renderStepChips() {
  const container = document.getElementById('step-chips');
  const sizes = currentState.customStepSizes.slice().sort((a, b) => a - b);
  container.innerHTML = '';
  sizes.forEach((value) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (Math.abs(value - currentState.increment) < 0.001 ? ' active' : '');
    chip.textContent = value.toFixed(2);
    chip.title = `Use a ${value.toFixed(2)} step`;
    chip.addEventListener('click', () => setIncrement(value));
    // Removable when more than one remains.
    if (sizes.length > 1) {
      const rm = document.createElement('span');
      rm.className = 'remove';
      rm.textContent = '×';
      rm.title = 'Remove this step size';
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeStepSize(value); });
      chip.appendChild(rm);
    }
    container.appendChild(chip);
  });
}

function persistStepSizes() {
  chrome.storage.local.set({ customStepSizes: currentState.customStepSizes });
}

function addStepSize(value) {
  value = Math.round(value * 100) / 100;
  if (currentState.customStepSizes.some((v) => Math.abs(v - value) < 0.001)) {
    setIncrement(value);
    return;
  }
  if (currentState.customStepSizes.length >= MAX_STEP_SIZES) {
    // Drop the oldest non-active to make room.
    currentState.customStepSizes = currentState.customStepSizes.filter((v) => Math.abs(v - currentState.increment) < 0.001).concat(
      currentState.customStepSizes.filter((v) => Math.abs(v - currentState.increment) >= 0.001).slice(1)
    );
  }
  currentState.customStepSizes.push(value);
  persistStepSizes();
  setIncrement(value);
}

function removeStepSize(value) {
  currentState.customStepSizes = currentState.customStepSizes.filter((v) => Math.abs(v - value) >= 0.001);
  if (currentState.customStepSizes.length === 0) currentState.customStepSizes = [DEFAULTS.increment];
  // If we removed the active one, fall back to the nearest remaining.
  if (Math.abs(value - currentState.increment) < 0.001) {
    setIncrement(currentState.customStepSizes[0]);
  }
  persistStepSizes();
  renderStepChips();
}

function updateTimeThresholdUI(activeThreshold) {
  document.querySelectorAll('.time-btn').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.value) === activeThreshold);
  });
}

// Parse a custom step value: ".05", "0.05", or "5" (→ 0.05).
function parseCustomIncrement(value) {
  let parsed = parseFloat(value);
  if (isNaN(parsed)) return null;
  if (parsed >= 1 && !String(value).includes('.')) parsed = parsed / 100;
  return parsed;
}

// ---------- analytics rendering (issue #3) ----------

function renderAnalytics(data) {
  if (!data) return;
  currentState.analytics = data;
  const stats = STA.mergeStats(data.stats);

  // Stat tiles
  const saved = STA.timeSaved(stats);
  document.getElementById('stat-saved').textContent = fmtDur(saved);
  const savedSinceBaseline = STA.timeSavedSinceBaseline(stats);
  document.getElementById('stat-saved-sub').textContent =
    stats.baselineResetAt ? `${fmtDur(savedSinceBaseline)} since baseline` : 'vs watching at 1×';

  document.getElementById('stat-personal').textContent = STA.personalAverageSpeed(stats).toFixed(2) + '×';
  document.getElementById('stat-personal-sub').textContent =
    stats.baselineResetAt ? `since ${new Date(stats.baselineResetAt).toLocaleDateString()}` : 'all time';

  document.getElementById('stat-watch').textContent = fmtDur(stats.totalReal || 0);

  const range = STA.naturalSpeedRange(stats);
  if (range.total > 0) {
    document.getElementById('stat-range').textContent =
      (Math.abs(range.min - range.max) < 0.001) ? `${range.mode.toFixed(2)}×` : `${range.min.toFixed(2)}–${range.max.toFixed(2)}×`;
    document.getElementById('stat-range-sub').textContent = `mostly ${range.mode.toFixed(2)}×`;
  } else {
    document.getElementById('stat-range').textContent = '—';
    document.getElementById('stat-range-sub').textContent = 'where you watch';
  }

  renderRecommendations(data, stats);
  renderSpeedDrops(data.speedDrops || []);
  renderAwards(data, stats);
}

// ---------- recommendations (issues #4 & #5) ----------

function confBadge(conf) {
  return `<span class="reco-conf ${conf}">${conf}</span>`;
}

function renderRecommendations(data, stats) {
  const container = document.getElementById('reco-container');
  const log = data.speedChangeLog || [];
  const drops = data.dropHistory || [];

  const step = STA.recommendStepSize(log, currentState.increment);
  const thr = STA.recommendThreshold(drops, currentState.timeThreshold, stats);

  container.innerHTML = '';

  // Step-size recommendation
  container.appendChild(recoCard({
    name: '📐 Step size',
    conf: step.confidence,
    body: step.explanation,
    benefit: step.benefit,
    valueLabel: step.changed ? `${currentState.increment.toFixed(2)} → ${step.value.toFixed(2)}` : `${step.value.toFixed(2)} (keep)`,
    canApply: step.changed,
    onApply: () => { addStepSize(step.value); flashReco(); }
  }));

  // Level-up recommendation
  const thrMin = Math.round(thr.value / 60);
  container.appendChild(recoCard({
    name: '⏱ Level-up interval',
    conf: thr.confidence,
    body: thr.explanation,
    benefit: thr.benefit,
    valueLabel: thr.changed ? `${Math.round(currentState.timeThreshold / 60)}m → ${thrMin}m` : `${thrMin}m (keep)`,
    canApply: thr.changed,
    onApply: () => { setTimeThreshold(thr.value); flashReco(); }
  }));

  // Stash for the "optimize both" button.
  currentState._reco = { step, thr };
}

function recoCard({ name, conf, body, benefit, valueLabel, canApply, onApply }) {
  const div = document.createElement('div');
  div.className = 'reco';
  div.innerHTML = `
    <div class="reco-head">
      <span class="reco-name">${name}</span>
      ${confBadge(conf)}
    </div>
    <div class="reco-body">${escapeHtml(body || '')}</div>
    ${benefit ? `<div class="reco-benefit">💡 ${escapeHtml(benefit)}</div>` : ''}
    <div class="reco-actions">
      <span class="reco-value">${escapeHtml(valueLabel)}</span>
      <button class="reco-apply" ${canApply ? '' : 'disabled'}>Apply</button>
    </div>`;
  const btn = div.querySelector('.reco-apply');
  if (canApply) btn.addEventListener('click', onApply);
  return div;
}

function flashReco() {
  // Re-fetch analytics so recommendations & highlights update after applying.
  setTimeout(refreshAnalytics, 150);
}

// Combined optimization (issues #5.6, #5.9, #5.11)
function optimizeBoth() {
  const r = currentState._reco;
  if (!r) return;
  const parts = [];
  if (r.step.changed) { addStepSize(r.step.value); parts.push(`step → ${r.step.value.toFixed(2)}`); }
  if (r.thr.changed) { setTimeThreshold(r.thr.value); parts.push(`level-up → ${Math.round(r.thr.value / 60)}m`); }
  const status = document.getElementById('status-text');
  if (parts.length) {
    status.textContent = `Optimized: ${parts.join(', ')}`;
  } else {
    status.textContent = 'Already optimal — nothing to change';
  }
  flashReco();
}

// ---------- speed drops with metadata (issue #3) ----------

function renderSpeedDrops(drops) {
  const list = document.getElementById('drops-list');
  if (!Array.isArray(drops) || drops.length === 0) {
    list.innerHTML = '<div class="drops-empty">No speed drops yet — they appear when you manually slow down</div>';
    return;
  }
  list.innerHTML = drops.map((d) => {
    const when = d.time ? new Date(d.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const vid = d.title ? escapeHtml(d.title) : (d.videoId ? `video ${d.videoId}` : '');
    const meta = [when, vid].filter(Boolean).join(' · ');
    return `
      <div class="drop-row">
        <div class="drop-main">
          <div class="drop-transition">${d.from.toFixed(2)}×<span class="arrow">→</span>${d.to.toFixed(2)}×</div>
          ${meta ? `<div class="drop-meta" title="${vid}">${meta}</div>` : ''}
        </div>
        <span class="drop-delta">−${d.delta.toFixed(2)}</span>
      </div>`;
  }).join('');
}

// ---------- awards / gamification (issue #6) ----------

function renderAwards(data, stats) {
  const achievements = data.achievements || STA.evaluateAchievements(stats, data.streak, {});
  const rank = data.rank || STA.rankFromAchievements(achievements);

  // Header + awards rank
  document.getElementById('rank-icon').textContent = rank.icon;
  document.getElementById('rank-name').textContent = rank.title;
  document.getElementById('award-rank-emoji').textContent = rank.icon;
  document.getElementById('award-rank-name').textContent = rank.title;
  const nextTxt = rank.next ? ` · next: ${rank.next.title} at ${rank.next.min}` : ' · max rank!';
  document.getElementById('award-rank-sub').textContent = `${rank.unlocked} of ${rank.total} achievements${nextTxt}`;

  const streak = data.streak || { current: 0 };
  document.getElementById('streak-num').textContent = streak.current || 0;

  // Achievement list — unlocked first, then closest to completion.
  const sorted = achievements.slice().sort((a, b) => {
    if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
    return b.pct - a.pct;
  });

  const grid = document.getElementById('ach-grid');
  grid.innerHTML = '';
  sorted.forEach((a) => {
    // Hidden & still-locked achievements keep their requirement a mystery (#6.9).
    const mystery = a.hidden && !a.unlocked;
    const title = mystery ? '??? Hidden achievement' : a.title;
    const desc = mystery ? 'Keep using the trainer to discover this one' : a.desc;
    const icon = mystery ? '❓' : a.icon;

    const el = document.createElement('div');
    el.className = 'ach' + (a.unlocked ? ' unlocked' : '');
    el.innerHTML = `
      <div class="ach-icon">${icon}</div>
      <div class="ach-body">
        <div class="ach-name">${escapeHtml(title)}</div>
        <div class="ach-desc">${escapeHtml(desc)}${a.unlocked && a.unlockedAt ? ' · ' + timeAgo(a.unlockedAt) : ''}</div>
        ${a.unlocked ? '' : `<div class="ach-bar"><div class="ach-bar-fill" style="width:${a.pct}%"></div></div>`}
      </div>
      ${a.unlocked ? '<div class="ach-check">✓</div>' : `<div style="font-size:9px;color:#777;font-family:monospace;">${a.pct}%</div>`}`;
    // Clicking an unlocked achievement opens the shareable card (#6.13, #6.14).
    if (a.unlocked && !mystery) {
      el.addEventListener('click', () => openShareCard(a, rank, stats));
    }
    grid.appendChild(el);
  });
}

// ---------- shareable achievement card (issue #6.13, #6.14) ----------

let shareCardDataUrl = null;
let shareCardText = '';

function openShareCard(ach, rank, stats) {
  const panel = document.getElementById('share-panel');
  panel.hidden = false;
  document.getElementById('share-title').textContent = ach.title;
  drawShareCard(ach, rank, stats);
  shareCardText = `I just unlocked "${ach.title}" ${ach.icon} on YouTube Speed Trainer — rank ${rank.title}, ${fmtDur(STA.timeSaved(stats))} saved so far! ⚡`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function drawShareCard(ach, rank, stats) {
  const canvas = document.getElementById('share-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Background gradient
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0f0f1a'); g.addColorStop(0.5, '#16213e'); g.addColorStop(1, '#0f0f1a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // Accent glow
  const rg = ctx.createRadialGradient(W * 0.8, H * 0.2, 10, W * 0.8, H * 0.2, 320);
  rg.addColorStop(0, 'rgba(0,212,170,0.25)'); rg.addColorStop(1, 'rgba(0,212,170,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

  // Border
  ctx.strokeStyle = 'rgba(0,212,170,0.5)'; ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, W - 20, H - 20);

  // Brand
  ctx.fillStyle = '#00d4aa';
  ctx.font = '600 22px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('⚡ YouTube Speed Trainer', 40, 55);

  // Achievement icon
  ctx.font = '90px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(ach.icon, W / 2, 165);

  // "Achievement unlocked"
  ctx.fillStyle = '#7fdfce';
  ctx.font = '600 15px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('ACHIEVEMENT UNLOCKED', W / 2, 200);

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 34px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(ach.title, W / 2, 240);

  // Footer stats
  ctx.fillStyle = '#9fb0c0';
  ctx.font = '500 16px "JetBrains Mono", monospace';
  ctx.fillText(`${rank.icon} ${rank.title}   ·   ${fmtDur(STA.timeSaved(stats))} saved   ·   ${STA.averageSpeed(stats).toFixed(2)}× avg`, W / 2, 285);
  ctx.textAlign = 'left';

  try { shareCardDataUrl = canvas.toDataURL('image/png'); } catch (e) { shareCardDataUrl = null; }
}

function handleShare(kind) {
  const enc = encodeURIComponent(shareCardText);
  const url = encodeURIComponent(SHARE_URL);
  let target = null;
  switch (kind) {
    case 'close': document.getElementById('share-panel').hidden = true; return;
    case 'download':
      if (shareCardDataUrl) {
        const a = document.createElement('a');
        a.href = shareCardDataUrl;
        a.download = 'speed-trainer-achievement.png';
        a.click();
      }
      return;
    case 'copy':
      copyShareCard();
      return;
    case 'whatsapp': target = `https://wa.me/?text=${enc}`; break;
    case 'telegram': target = `https://t.me/share/url?url=${url}&text=${enc}`; break;
    case 'twitter': target = `https://twitter.com/intent/tweet?text=${enc}&url=${url}`; break;
    case 'facebook': target = `https://www.facebook.com/sharer/sharer.php?u=${url}&quote=${enc}`; break;
    case 'linkedin': target = `https://www.linkedin.com/sharing/share-offsite/?url=${url}`; break;
  }
  if (target) chrome.tabs.create({ url: target });
}

async function copyShareCard() {
  const status = document.getElementById('status-text');
  // Try to copy the image; fall back to copying the text.
  try {
    if (shareCardDataUrl && navigator.clipboard && window.ClipboardItem) {
      const blob = await (await fetch(shareCardDataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status.textContent = 'Card image copied ✓';
      return;
    }
  } catch (e) { /* fall through to text */ }
  try {
    await navigator.clipboard.writeText(shareCardText);
    status.textContent = 'Achievement text copied ✓';
  } catch (e) {
    status.textContent = 'Copy not available';
  }
}

// ---------- status ----------

function updateStatus(isOnYouTube, isPlaying, statusMessage) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (isOnYouTube) {
    dot.classList.add('active');
    text.textContent = statusMessage || (isPlaying ? 'Playing' : 'Ready');
  } else {
    dot.classList.remove('active');
    text.textContent = statusMessage || 'Not on YouTube';
  }
}

function isYouTubeUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'youtube.com' || h.endsWith('.youtube.com');
  } catch { return false; }
}

// ---------- messaging ----------

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['analytics.js', 'content.js'] });
    await new Promise((r) => setTimeout(r, 100));
    return true;
  } catch (e) { return false; }
}

async function sendToContent(message, retries = 3) {
  if (!currentState.tabId) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.tabs.sendMessage(currentState.tabId, message);
    } catch (e) {
      if (attempt === 0 && currentState.isOnYouTube) await ensureContentScriptInjected(currentState.tabId);
      else if (attempt < retries) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  return null;
}

// ---------- load ----------

async function loadState() {
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (e) {
    updateStatus(false, false, 'Extension error');
    return loadFromStorage();
  }
  if (!tab) { updateStatus(false, false, 'No active tab'); return loadFromStorage(); }

  currentState.tabId = tab.id;
  currentState.isOnYouTube = isYouTubeUrl(tab.url || '');

  if (!currentState.isOnYouTube) { updateStatus(false, false); return loadFromStorage(); }

  updateStatus(true, false, 'Connecting...');
  const contentState = await sendToContent({ type: 'GET_STATE' });
  if (contentState) {
    applyLiveState(contentState);
    updateStatus(true, contentState.isPlaying,
      contentState.hasVideo ? (contentState.isPlaying ? 'Playing' : 'Ready') : 'No video');
    const analytics = await sendToContent({ type: 'GET_ANALYTICS' });
    // customStepSizes live in storage, not the content payload.
    chrome.storage.local.get(['customStepSizes'], (r) => {
      currentState.customStepSizes = normalizeStepSizes(r.customStepSizes, currentState.increment);
      renderStepChips();
    });
    if (analytics) renderAnalytics(analytics);
    else loadAnalyticsFromStorage();
  } else {
    updateStatus(true, false, 'Refresh page to activate');
    loadFromStorage();
  }
}

function applyLiveState(s) {
  currentState.speed = s.currentSpeed;
  currentState.increment = s.increment;
  currentState.timeThreshold = s.timeThreshold;
  currentState.watchedTime = s.watchedTime;
  currentState.autoProgressionEnabled = s.autoProgressionEnabled ?? true;
  currentState.speedDrops = s.speedDrops || [];

  updateSpeedDisplay(currentState.speed);
  updateTimeThresholdUI(currentState.timeThreshold);
  updateAutoToggle(currentState.autoProgressionEnabled);
  updateProgressUI(currentState.watchedTime, currentState.timeThreshold);
}

function normalizeStepSizes(arr, activeIncrement) {
  let sizes = Array.isArray(arr) && arr.length ? arr.map((v) => Math.round(v * 100) / 100) : DEFAULT_STEP_SIZES.slice();
  sizes = [...new Set(sizes)].filter((v) => v >= 0.01 && v <= 1.0);
  if (!sizes.length) sizes = DEFAULT_STEP_SIZES.slice();
  // Ensure the currently-active step is always present as a chip.
  if (activeIncrement && !sizes.some((v) => Math.abs(v - activeIncrement) < 0.001)) sizes.push(Math.round(activeIncrement * 100) / 100);
  return sizes;
}

function loadFromStorage() {
  chrome.storage.local.get(null, (result) => {
    currentState.speed = result.currentSpeed ?? DEFAULTS.currentSpeed;
    currentState.increment = result.increment ?? DEFAULTS.increment;
    currentState.timeThreshold = result.timeThreshold ?? DEFAULTS.timeThreshold;
    currentState.watchedTime = result.watchedTime ?? DEFAULTS.watchedTime;
    currentState.autoProgressionEnabled = result.autoProgressionEnabled ?? true;
    currentState.customStepSizes = normalizeStepSizes(result.customStepSizes, currentState.increment);

    updateSpeedDisplay(currentState.speed);
    renderStepChips();
    updateTimeThresholdUI(currentState.timeThreshold);
    updateAutoToggle(currentState.autoProgressionEnabled);
    updateProgressUI(currentState.watchedTime, currentState.timeThreshold);

    renderAnalytics(buildAnalyticsFromStorage(result));
  });
}

function loadAnalyticsFromStorage() {
  chrome.storage.local.get(null, (result) => renderAnalytics(buildAnalyticsFromStorage(result)));
}

// Assemble the analytics payload shape from raw storage (used off-YouTube).
function buildAnalyticsFromStorage(result) {
  const stats = STA.mergeStats(result.stats);
  const streak = result.streak || { current: 0, longest: 0, lastDay: null };
  const achievements = STA.evaluateAchievements(stats, streak, result.achievementsUnlocked || {});
  return {
    stats,
    streak,
    dropHistory: result.dropHistory || [],
    speedDrops: topDropsFromStorage(result.speedDrops, result.currentDrop),
    speedChangeLog: result.speedChangeLog || [],
    videoStats: result.videoStats || {},
    achievements,
    rank: STA.rankFromAchievements(achievements)
  };
}

function topDropsFromStorage(speedDrops, currentDrop) {
  const all = Array.isArray(speedDrops) ? speedDrops.slice() : [];
  if (currentDrop) {
    const delta = Math.round((currentDrop.from - currentDrop.to) * 100) / 100;
    if (delta > 0) all.push({ ...currentDrop, delta });
  }
  all.sort((a, b) => b.delta - a.delta);
  return all.slice(0, 5);
}

async function refreshAnalytics() {
  if (currentState.isOnYouTube && currentState.tabId) {
    const analytics = await sendToContent({ type: 'GET_ANALYTICS' });
    if (analytics) { renderAnalytics(analytics); renderStepChips(); return; }
  }
  loadAnalyticsFromStorage();
  renderStepChips();
}

// ---------- mutations ----------

async function changeSpeed(delta) {
  const newSpeed = Math.max(DEFAULTS.minSpeed, Math.min(DEFAULTS.maxSpeed, currentState.speed + delta));
  const roundedSpeed = Math.round(newSpeed * 100) / 100;
  if (roundedSpeed === currentState.speed) return;

  currentState.speed = roundedSpeed;
  updateSpeedDisplay(roundedSpeed);
  chrome.storage.local.set({ currentSpeed: roundedSpeed });

  if (currentState.isOnYouTube && currentState.tabId) {
    const response = await sendToContent({ type: 'SET_SPEED', speed: roundedSpeed });
    if (response?.success) {
      updateStatus(true, true, `Speed: ${roundedSpeed.toFixed(2)}×`);
      setTimeout(() => updateStatus(true, true, 'Playing'), 1000);
    } else {
      updateStatus(true, false, 'Speed saved (refresh to apply)');
    }
  }
}

async function setIncrement(value) {
  value = Math.max(0.01, Math.min(1.0, value));
  value = Math.round(value * 100) / 100;
  currentState.increment = value;
  if (!currentState.customStepSizes.some((v) => Math.abs(v - value) < 0.001)) {
    currentState.customStepSizes.push(value);
    persistStepSizes();
  }
  renderStepChips();
  chrome.storage.local.set({ increment: value });
  if (currentState.isOnYouTube && currentState.tabId) await sendToContent({ type: 'SET_INCREMENT', increment: value });
}

async function setTimeThreshold(seconds) {
  currentState.timeThreshold = seconds;
  updateTimeThresholdUI(seconds);
  updateProgressUI(currentState.watchedTime, seconds);
  chrome.storage.local.set({ timeThreshold: seconds });
  if (currentState.isOnYouTube && currentState.tabId) await sendToContent({ type: 'SET_TIME_THRESHOLD', timeThreshold: seconds });
}

function updateAutoToggle(enabled) {
  const el = document.getElementById('auto-toggle');
  el.classList.toggle('active', !!enabled);
  el.setAttribute('aria-checked', enabled ? 'true' : 'false');
}

async function setAutoProgression(enabled) {
  currentState.autoProgressionEnabled = enabled;
  updateAutoToggle(enabled);
  updateProgressUI(currentState.watchedTime, currentState.timeThreshold);
  chrome.storage.local.set({ autoProgressionEnabled: enabled });
  if (currentState.isOnYouTube && currentState.tabId) await sendToContent({ type: 'SET_AUTO_PROGRESSION', enabled });
}

// ---------- resets (issue #3: granular, clearly labeled) ----------

async function resetPersonalAverage() {
  if (currentState.isOnYouTube && currentState.tabId) await sendToContent({ type: 'RESET_PERSONAL_AVERAGE' });
  else {
    // Off-YouTube: snapshot the baseline directly in storage.
    chrome.storage.local.get(['stats'], (r) => {
      const stats = STA.mergeStats(r.stats);
      stats.baselineReal = stats.totalReal;
      stats.baselineContent = stats.totalContent;
      stats.baselineResetAt = Date.now();
      chrome.storage.local.set({ stats }, refreshAnalytics);
    });
  }
  document.getElementById('status-text').textContent = 'Personal average reset (history kept)';
  setTimeout(refreshAnalytics, 150);
}

async function resetHistory() {
  if (!confirm('Delete ALL analytics and history?\n\nThis permanently removes your time saved, speed drops, per-video data, streak and achievements. Your settings and current speed are kept.\n\nThis cannot be undone.')) return;
  if (currentState.isOnYouTube && currentState.tabId) await sendToContent({ type: 'RESET_HISTORY' });
  else {
    chrome.storage.local.set({
      speedDrops: [], currentDrop: null, dropHistory: [], speedChangeLog: [],
      videoStats: {}, stats: STA.emptyStats(), streak: { current: 0, longest: 0, lastDay: null }, achievementsUnlocked: {}
    });
  }
  document.getElementById('status-text').textContent = 'History deleted';
  document.getElementById('share-panel').hidden = true;
  setTimeout(refreshAnalytics, 150);
}

async function resetAll() {
  if (!confirm('Reset EVERYTHING to defaults?\n\nThis resets your speed, step size, level-up interval AND deletes all history and achievements.')) return;
  currentState.speed = DEFAULTS.currentSpeed;
  currentState.increment = DEFAULTS.increment;
  currentState.timeThreshold = DEFAULTS.timeThreshold;
  currentState.watchedTime = DEFAULTS.watchedTime;
  currentState.autoProgressionEnabled = true;
  currentState.customStepSizes = DEFAULT_STEP_SIZES.slice();

  updateSpeedDisplay(DEFAULTS.currentSpeed);
  renderStepChips();
  updateTimeThresholdUI(DEFAULTS.timeThreshold);
  updateAutoToggle(true);
  updateProgressUI(0, DEFAULTS.timeThreshold);

  chrome.storage.local.set({
    currentSpeed: DEFAULTS.currentSpeed, increment: DEFAULTS.increment,
    timeThreshold: DEFAULTS.timeThreshold, watchedTime: 0, autoProgressionEnabled: true,
    customStepSizes: DEFAULT_STEP_SIZES.slice()
  });
  if (currentState.isOnYouTube && currentState.tabId) await sendToContent({ type: 'RESET' });
  document.getElementById('share-panel').hidden = true;
  setTimeout(refreshAnalytics, 150);
}

// ---------- tabs ----------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

// ---------- misc ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openPage(page) {
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });
}

// ---------- init ----------

document.addEventListener('DOMContentLoaded', () => {
  loadState();

  document.getElementById('btn-decrease').addEventListener('click', () => changeSpeed(-currentState.increment));
  document.getElementById('btn-increase').addEventListener('click', () => changeSpeed(currentState.increment));

  // Custom step-size input (add on Enter/blur) — validates numeric range (#4.1)
  const customInput = document.getElementById('custom-increment');
  const stepError = document.getElementById('step-error');
  function commitCustom() {
    const raw = customInput.value.trim();
    if (raw === '') { stepError.textContent = ''; return; }
    const parsed = parseCustomIncrement(raw);
    if (parsed === null || isNaN(parsed)) { stepError.textContent = 'Enter a number'; return; }
    if (parsed < 0.01 || parsed > 1.0) { stepError.textContent = 'Must be 0.01–1.00'; return; }
    stepError.textContent = '';
    addStepSize(parsed);
    customInput.value = '';
  }
  customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitCustom(); });
  customInput.addEventListener('blur', commitCustom);
  customInput.addEventListener('input', () => { stepError.textContent = ''; });

  document.querySelectorAll('.time-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTimeThreshold(parseInt(btn.dataset.value)));
  });

  document.getElementById('auto-toggle').addEventListener('click', () => {
    setAutoProgression(!currentState.autoProgressionEnabled);
  });

  document.getElementById('btn-optimize').addEventListener('click', optimizeBoth);
  document.getElementById('btn-reset-personal').addEventListener('click', resetPersonalAverage);
  document.getElementById('btn-reset-history').addEventListener('click', resetHistory);

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.getElementById('rank-badge').addEventListener('click', () => switchTab('awards'));

  document.querySelectorAll('.share-btn').forEach((b) => b.addEventListener('click', () => handleShare(b.dataset.share)));

  document.getElementById('link-report').addEventListener('click', (e) => { e.preventDefault(); openPage('reports.html'); });
  document.getElementById('link-shortcuts').addEventListener('click', (e) => { e.preventDefault(); openPage('shortcuts.html'); });
  document.getElementById('link-reset-all').addEventListener('click', (e) => { e.preventDefault(); resetAll(); });

  // Live refresh while the popup is open.
  setInterval(async () => {
    if (currentState.isOnYouTube && currentState.tabId) {
      const s = await sendToContent({ type: 'GET_STATE' });
      if (s) {
        currentState.watchedTime = s.watchedTime;
        currentState.speed = s.currentSpeed;
        currentState.autoProgressionEnabled = s.autoProgressionEnabled ?? currentState.autoProgressionEnabled;
        updateProgressUI(s.watchedTime, currentState.timeThreshold);
        updateSpeedDisplay(s.currentSpeed);
        renderSpeedDrops(s.speedDrops || []);
      }
    }
  }, 1500);
});
