// YouTube Speed Trainer - Popup Script
// Supports custom increments and time-based progression

const DEFAULTS = {
  currentSpeed: 1.0,
  increment: 0.05,
  minSpeed: 0.5,
  maxSpeed: 4.0,
  timeThreshold: 600,      // 10 minutes in seconds
  watchedTime: 0           // Cumulative watch time in seconds
};

const PRESET_INCREMENTS = [0.05, 0.1, 0.2];

let currentState = {
  speed: DEFAULTS.currentSpeed,
  increment: DEFAULTS.increment,
  timeThreshold: DEFAULTS.timeThreshold,
  watchedTime: DEFAULTS.watchedTime,
  speedDrops: [],
  isOnYouTube: false,
  tabId: null
};

// Format seconds as M:SS or H:MM:SS
function formatTime(seconds) {
  seconds = Math.floor(seconds);
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  } else {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

// Update speed display
function updateSpeedDisplay(speed) {
  const speedInt = document.getElementById('speed-int');
  const speedDec = document.getElementById('speed-dec');
  
  const intPart = Math.floor(speed);
  const decPart = Math.round((speed - intPart) * 100);
  
  speedInt.textContent = intPart;
  speedDec.textContent = decPart.toString().padStart(2, '0');
}

// Update increment buttons (including custom input)
function updateIncrementUI(activeIncrement) {
  const customInput = document.getElementById('custom-increment');
  const isPreset = PRESET_INCREMENTS.some(p => Math.abs(p - activeIncrement) < 0.001);
  
  // Update preset buttons
  document.querySelectorAll('.increment-btn').forEach(btn => {
    const value = parseFloat(btn.dataset.value);
    btn.classList.toggle('active', Math.abs(value - activeIncrement) < 0.001);
  });
  
  // Update custom input
  if (!isPreset) {
    customInput.value = activeIncrement.toFixed(2).replace(/^0\./, '.');
    customInput.classList.add('active');
  } else {
    customInput.value = '';
    customInput.classList.remove('active');
  }
}

// Update time threshold buttons
function updateTimeThresholdUI(activeThreshold) {
  document.querySelectorAll('.time-btn').forEach(btn => {
    const value = parseInt(btn.dataset.value);
    btn.classList.toggle('active', value === activeThreshold);
  });
}

// Update progress bar and time display
function updateProgressUI(watchedTime, threshold) {
  const progressBar = document.getElementById('progress-bar');
  const progressTime = document.getElementById('progress-time');
  const progressHint = document.getElementById('progress-hint');
  
  const progress = Math.min(100, (watchedTime / threshold) * 100);
  const remaining = Math.max(0, threshold - watchedTime);
  
  progressBar.style.width = `${progress}%`;
  progressTime.textContent = `${formatTime(watchedTime)} / ${formatTime(threshold)}`;
  
  if (progress >= 100) {
    progressHint.textContent = '🎉 Level up! Speed will increase on next video';
  } else if (progress >= 75) {
    progressHint.textContent = `Almost there! ${formatTime(remaining)} to go`;
  } else if (progress >= 50) {
    progressHint.textContent = `Halfway! Keep watching`;
  } else {
    progressHint.textContent = `Watch videos to fill the bar and level up`;
  }
}

// Render the list of biggest manual speed drops
function renderSpeedDrops(drops) {
  const list = document.getElementById('drops-list');
  if (!list) return;

  if (!Array.isArray(drops) || drops.length === 0) {
    list.innerHTML = '<li class="list-group-item bg-transparent border-0 text-secondary text-center px-0 py-1" style="font-size:10px;">No speed drops yet — they appear when you manually slow down</li>';
    return;
  }

  list.innerHTML = drops.map((d, i) => `
    <li class="list-group-item drop-row d-flex align-items-center justify-content-between px-2 py-1 mb-1 rounded-2">
      <span class="d-flex align-items-center gap-2 text-truncate">
        <span class="badge rounded-pill text-bg-dark" style="font-size:9px;">#${i + 1}</span>
        <span class="font-monospace small text-light text-truncate">${d.from.toFixed(2)}×<span class="text-secondary mx-1">→</span>${d.to.toFixed(2)}×</span>
      </span>
      <span class="font-monospace fw-semibold flex-shrink-0 ms-2" style="color:#ff5252;">−${d.delta.toFixed(2)}</span>
    </li>
  `).join('');
}

// Merge finalized drops with an in-progress drop, biggest first (storage fallback)
function topDropsFromStorage(speedDrops, currentDrop) {
  const all = Array.isArray(speedDrops) ? speedDrops.slice() : [];
  if (currentDrop) {
    const delta = Math.round((currentDrop.from - currentDrop.to) * 100) / 100;
    if (delta > 0) all.push({ ...currentDrop, delta });
  }
  all.sort((a, b) => b.delta - a.delta);
  return all.slice(0, 5);
}

// Update status indicator
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

// Check if URL is a YouTube page
function isYouTubeUrl(url) {
  if (!url) return false;
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

// Inject content script if needed
async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    await new Promise(r => setTimeout(r, 100));
    return true;
  } catch (e) {
    console.log('Could not inject content script:', e.message);
    return false;
  }
}

// Send message to content script with retry
async function sendToContent(message, retries = 3) {
  if (!currentState.tabId) return null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(currentState.tabId, message);
      return response;
    } catch (e) {
      if (attempt === 0 && currentState.isOnYouTube) {
        await ensureContentScriptInjected(currentState.tabId);
      } else if (attempt < retries) {
        await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  }
  return null;
}

// Load state from storage and content script
async function loadState() {
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (e) {
    console.error('Failed to query tabs:', e);
    updateStatus(false, false, 'Extension error');
    loadFromStorage();
    return;
  }
  
  if (!tab) {
    updateStatus(false, false, 'No active tab');
    loadFromStorage();
    return;
  }
  
  currentState.tabId = tab.id;
  const url = tab.url || '';
  const onYouTube = isYouTubeUrl(url);
  currentState.isOnYouTube = onYouTube;
  
  if (!onYouTube) {
    updateStatus(false, false);
    loadFromStorage();
    return;
  }
  
  updateStatus(true, false, 'Connecting...');
  const contentState = await sendToContent({ type: 'GET_STATE' });
  
  if (contentState) {
    currentState.speed = contentState.currentSpeed;
    currentState.increment = contentState.increment;
    currentState.timeThreshold = contentState.timeThreshold;
    currentState.watchedTime = contentState.watchedTime;
    currentState.speedDrops = contentState.speedDrops || [];

    updateSpeedDisplay(currentState.speed);
    updateIncrementUI(currentState.increment);
    updateTimeThresholdUI(currentState.timeThreshold);
    updateProgressUI(currentState.watchedTime, currentState.timeThreshold);
    renderSpeedDrops(currentState.speedDrops);
    updateStatus(true, contentState.isPlaying,
      contentState.hasVideo ? (contentState.isPlaying ? 'Playing' : 'Ready') : 'No video');
  } else {
    loadFromStorage();
    updateStatus(true, false, 'Refresh page to activate');
  }
}

// Load from storage (fallback)
function loadFromStorage() {
  chrome.storage.local.get(['currentSpeed', 'increment', 'timeThreshold', 'watchedTime', 'speedDrops', 'currentDrop'], (result) => {
    currentState.speed = result.currentSpeed ?? DEFAULTS.currentSpeed;
    currentState.increment = result.increment ?? DEFAULTS.increment;
    currentState.timeThreshold = result.timeThreshold ?? DEFAULTS.timeThreshold;
    currentState.watchedTime = result.watchedTime ?? DEFAULTS.watchedTime;
    currentState.speedDrops = topDropsFromStorage(result.speedDrops, result.currentDrop);

    updateSpeedDisplay(currentState.speed);
    updateIncrementUI(currentState.increment);
    updateTimeThresholdUI(currentState.timeThreshold);
    updateProgressUI(currentState.watchedTime, currentState.timeThreshold);
    renderSpeedDrops(currentState.speedDrops);
  });
}

// Change speed - applies instantly
async function changeSpeed(delta) {
  const newSpeed = Math.max(
    DEFAULTS.minSpeed,
    Math.min(DEFAULTS.maxSpeed, currentState.speed + delta)
  );
  
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

// Set increment (preset or custom)
async function setIncrement(value) {
  // Validate and clamp
  value = Math.max(0.01, Math.min(1.0, value));
  value = Math.round(value * 100) / 100;
  
  currentState.increment = value;
  updateIncrementUI(value);
  chrome.storage.local.set({ increment: value });
  
  if (currentState.isOnYouTube && currentState.tabId) {
    await sendToContent({ type: 'SET_INCREMENT', increment: value });
  }
}

// Set time threshold
async function setTimeThreshold(seconds) {
  currentState.timeThreshold = seconds;
  updateTimeThresholdUI(seconds);
  updateProgressUI(currentState.watchedTime, seconds);
  chrome.storage.local.set({ timeThreshold: seconds });
  
  if (currentState.isOnYouTube && currentState.tabId) {
    await sendToContent({ type: 'SET_TIME_THRESHOLD', timeThreshold: seconds });
  }
}

// Reset all to defaults
async function reset() {
  currentState.speed = DEFAULTS.currentSpeed;
  currentState.increment = DEFAULTS.increment;
  currentState.timeThreshold = DEFAULTS.timeThreshold;
  currentState.watchedTime = DEFAULTS.watchedTime;
  currentState.speedDrops = [];

  updateSpeedDisplay(DEFAULTS.currentSpeed);
  updateIncrementUI(DEFAULTS.increment);
  updateTimeThresholdUI(DEFAULTS.timeThreshold);
  updateProgressUI(0, DEFAULTS.timeThreshold);
  renderSpeedDrops([]);

  chrome.storage.local.set({
    currentSpeed: DEFAULTS.currentSpeed,
    increment: DEFAULTS.increment,
    timeThreshold: DEFAULTS.timeThreshold,
    watchedTime: 0,
    speedDrops: [],
    currentDrop: null
  });
  
  if (currentState.isOnYouTube && currentState.tabId) {
    await sendToContent({ type: 'RESET' });
  }
}

// Parse custom increment value
function parseCustomIncrement(value) {
  // Handle values like ".05", "0.05", "5" (interpreted as 0.05)
  let parsed = parseFloat(value);
  if (isNaN(parsed)) return null;
  
  // If user typed just a number like "5" or "10", interpret as hundredths
  if (parsed >= 1 && !value.includes('.')) {
    parsed = parsed / 100;
  }
  
  return parsed;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  
  // Speed buttons
  document.getElementById('btn-decrease').addEventListener('click', () => {
    changeSpeed(-currentState.increment);
  });
  
  document.getElementById('btn-increase').addEventListener('click', () => {
    changeSpeed(currentState.increment);
  });
  
  // Preset increment buttons
  document.querySelectorAll('.increment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = parseFloat(btn.dataset.value);
      setIncrement(value);
    });
  });
  
  // Custom increment input
  const customInput = document.getElementById('custom-increment');
  
  customInput.addEventListener('focus', () => {
    // Deactivate preset buttons when focusing custom input
    document.querySelectorAll('.increment-btn').forEach(btn => {
      btn.classList.remove('active');
    });
  });
  
  customInput.addEventListener('blur', () => {
    const parsed = parseCustomIncrement(customInput.value);
    if (parsed !== null && parsed >= 0.01 && parsed <= 1.0) {
      setIncrement(parsed);
    } else if (customInput.value.trim() !== '') {
      // Invalid input - revert to current state
      updateIncrementUI(currentState.increment);
    }
  });
  
  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      customInput.blur();
    }
  });
  
  // Time threshold buttons
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = parseInt(btn.dataset.value);
      setTimeThreshold(value);
    });
  });
  
  // Reset button
  document.getElementById('btn-reset').addEventListener('click', reset);

  // Customize shortcuts link — chrome:// URLs require chrome.tabs.create
  document.getElementById('customize-shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  
  // Periodic progress update while popup is open
  setInterval(async () => {
    if (currentState.isOnYouTube && currentState.tabId) {
      const state = await sendToContent({ type: 'GET_STATE' });
      if (state) {
        currentState.watchedTime = state.watchedTime;
        currentState.speed = state.currentSpeed;
        currentState.speedDrops = state.speedDrops || [];
        updateProgressUI(state.watchedTime, currentState.timeThreshold);
        updateSpeedDisplay(state.currentSpeed);
        renderSpeedDrops(currentState.speedDrops);
      }
    }
  }, 1000);
});
