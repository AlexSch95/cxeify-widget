/**
 * Cxeify - Spotify Controller for Xeneon Edge
 * 
 * Communicates with the companion server via HTTP REST API.
 * Handles playback state polling, user controls, and settings.
 */

// ── State ─────────────────────────────────────────────────────────
const state = {
  serverUrl: 'http://127.0.0.1:3000',
  pollingInterval: 2000,
  textColor: '#ffffff',
  accentColor: '#1DB954',
  backgroundColor: '#121212',
  transparency: 0,
};

let pollTimer = null;
let isSeeking = false;
let isDraggingVolume = false;
let currentPlayback = null;

// ── DOM References ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const dom = {
  loading: $('state-loading'),
  offline: $('state-offline'),
  nodevice: $('state-nodevice'),
  noauth: $('state-noauth'),
  player: $('player'),
  albumBg: $('album-bg'),
  albumImg: $('album-art-img'),
  trackName: $('track-name'),
  trackArtist: $('track-artist'),
  trackAlbum: $('track-album'),
  progressBar: $('progress-bar'),
  progressFill: $('progress-fill'),
  progressThumb: $('progress-thumb'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  playIcon: $('play-icon'),
  pauseIcon: $('pause-icon'),
  btnPlay: $('btn-play'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  btnShuffle: $('btn-shuffle'),
  btnRepeat: $('btn-repeat'),
  repeatIndicator: $('repeat-indicator'),
  volumeBar: $('volume-bar'),
  volumeFill: $('volume-fill'),
  volumeThumb: $('volume-thumb'),
  volIcon: $('vol-icon'),
};

// ── Settings (from iCUE) ──────────────────────────────────────────
// Helper: read a global iCUE property variable safely
function getIcueProperty(name, defaultValue) {
  try {
    if (typeof window !== 'undefined' && name in window) {
      const val = window[name];
      if (val !== undefined && val !== null && val !== '') return val;
    }
    // Fallback: try via Function constructor (catches bare globals too)
    const val = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
    if (val !== undefined && val !== null && val !== '') return val;
  } catch (e) { /* ignore */ }
  return defaultValue;
}

function applySettings(settings = {}) {
  // Merge settings object, then override with global iCUE variables if available
  Object.assign(state, settings);
  state.textColor = getIcueProperty('textColor', state.textColor);
  state.accentColor = getIcueProperty('accentColor', state.accentColor);
  state.backgroundColor = getIcueProperty('backgroundColor', state.backgroundColor);
  state.transparency = getIcueProperty('transparency', state.transparency);
  state.serverUrl = getIcueProperty('serverUrl', state.serverUrl);
  state.pollingInterval = getIcueProperty('pollingInterval', state.pollingInterval);
  
  // Apply CSS variables
  document.documentElement.style.setProperty('--text-color', state.textColor);
  document.documentElement.style.setProperty('--accent-color', state.accentColor);
  document.documentElement.style.setProperty('--background-color', state.backgroundColor);
  document.documentElement.style.setProperty('--transparency', state.transparency + '%');

  console.log('[Cxeify] Settings applied:', JSON.stringify(state));

  // Restart polling with new interval if changed
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  startPolling();
}

// ── API Communication ─────────────────────────────────────────────
// Auto-detect if we're loaded from the server itself (same origin)
function getApiBaseUrl() {
  // If loaded from the widget route on the server, use relative URLs
  if (window.location.port === '3000' || window.location.hostname === '127.0.0.1') {
    return '';
  }
  // Otherwise use the configured server URL
  return state.serverUrl.replace(/\/+$/, '');
}

async function apiFetch(path, options = {}) {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${path}`;
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`API error ${response.status}: ${text}`);
      return null;
    }
    return await response.json();
  } catch (e) {
    // Connection refused = server offline
    console.warn(`API fetch failed: ${e.message}`);
    return null;
  }
}

async function fetchStatus() {
  return await apiFetch('/api/status');
}

async function sendControl(action, body = {}) {
  return await apiFetch(`/api/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── Polling ───────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, state.pollingInterval);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  const result = await fetchStatus();
  
  console.log('[Cxeify] Poll result:', JSON.stringify(result));
  
  if (!result) {
    console.log('[Cxeify] → Server offline (no response)');
    showState('offline');
    return;
  }
  
  // Check auth status from server
  if (result.auth === false) {
    console.log('[Cxeify] → Not authenticated');
    showState('noauth');
    return;
  }
  
  if (!result.active || !result.data) {
    console.log('[Cxeify] → No active device');
    showState('nodevice');
    return;
  }
  
  console.log('[Cxeify] → Player active, updating UI');
  updatePlayback(result.data);
  showState('player');
}

// ── UI State Management ───────────────────────────────────────────
function showState(name) {
  // Use a CSS class approach instead of hidden attribute to avoid CSS specificity issues
  const states = ['loading', 'offline', 'nodevice', 'noauth', 'player'];
  states.forEach(s => {
    const el = dom[s];
    if (el) {
      if (s === name) {
        el.classList.remove('state-hidden');
        el.removeAttribute('hidden');
      } else {
        el.classList.add('state-hidden');
        el.setAttribute('hidden', '');
      }
    }
  });
  console.log('[Cxeify] showState:', name);
}

// ── Playback Update ───────────────────────────────────────────────
function updatePlayback(data) {
  currentPlayback = data;
  
  // Track info
  if (data.item) {
    dom.trackName.textContent = data.item.name || '-';
    dom.trackArtist.textContent = data.item.artists ? data.item.artists.join(', ') : '-';
    dom.trackAlbum.textContent = data.item.album || '-';
    
    // Album art
    const artUrl = data.item.album_art || data.item.album_art_small;
    if (artUrl) {
      dom.albumImg.src = artUrl;
      dom.albumBg.style.backgroundImage = `url('${artUrl}')`;
    }
  }
  
  // Play/Pause button
  if (data.is_playing) {
    dom.playIcon.hidden = true;
    dom.pauseIcon.hidden = false;
  } else {
    dom.playIcon.hidden = false;
    dom.pauseIcon.hidden = true;
  }
  
  // Progress (only if not seeking)
  if (!isSeeking && data.progress_ms != null && data.item?.duration_ms) {
    const pct = (data.progress_ms / data.item.duration_ms) * 100;
    dom.progressFill.style.width = pct + '%';
    dom.progressThumb.style.left = pct + '%';
    dom.timeCurrent.textContent = formatTime(data.progress_ms);
    dom.timeTotal.textContent = formatTime(data.item.duration_ms);
  }
  
  // Shuffle
  dom.btnShuffle.dataset.active = data.shuffle_state ? 'true' : 'false';
  
  // Repeat
  dom.btnRepeat.dataset.active = data.repeat_state !== 'off' ? 'true' : 'false';
  dom.repeatIndicator.hidden = data.repeat_state !== 'track';
  dom.repeatIndicator.textContent = '1';
  
  // Volume
  if (data.device && data.device.volume_percent != null && !isDraggingVolume) {
    const vol = data.device.volume_percent;
    dom.volumeFill.style.width = vol + '%';
    dom.volumeThumb.style.left = vol + '%';
  }
}

// ── Controls ──────────────────────────────────────────────────────
// Play/Pause
dom.btnPlay.addEventListener('click', async () => {
  if (currentPlayback?.is_playing) {
    await sendControl('pause');
  } else {
    await sendControl('play');
  }
});

// Next
dom.btnNext.addEventListener('click', async () => {
  await sendControl('next');
});

// Previous
dom.btnPrev.addEventListener('click', async () => {
  await sendControl('previous');
});

// Shuffle
dom.btnShuffle.addEventListener('click', async () => {
  const newState = dom.btnShuffle.dataset.active !== 'true';
  await sendControl('shuffle', { state: newState });
  dom.btnShuffle.dataset.active = newState ? 'true' : 'false';
});

// Repeat
dom.btnRepeat.addEventListener('click', async () => {
  const cycle = { 'false': 'context', 'context': 'track', 'track': 'off' };
  const current = dom.btnRepeat.dataset.active === 'true' 
    ? (dom.repeatIndicator.hidden ? 'context' : 'track')
    : 'off';
  const next = cycle[current] || 'off';
  await sendControl('repeat', { state: next });
  dom.btnRepeat.dataset.active = next !== 'off' ? 'true' : 'false';
  dom.repeatIndicator.hidden = next !== 'track';
});

// ── Seek ──────────────────────────────────────────────────────────
let seekPending = null;

dom.progressBar.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  isSeeking = true;
  seekMove(e);
  document.addEventListener('pointermove', seekMove);
  document.addEventListener('pointerup', seekEnd);
});

function seekMove(e) {
  const rect = dom.progressBar.getBoundingClientRect();
  let x = (e.clientX - rect.left) / rect.width;
  x = Math.max(0, Math.min(1, x));
  dom.progressFill.style.width = (x * 100) + '%';
  dom.progressThumb.style.left = (x * 100) + '%';
  
  if (currentPlayback?.item?.duration_ms) {
    dom.timeCurrent.textContent = formatTime(x * currentPlayback.item.duration_ms);
  }
  
  seekPending = x;
}

function seekEnd(e) {
  document.removeEventListener('pointermove', seekMove);
  document.removeEventListener('pointerup', seekEnd);
  isSeeking = false;
  
  if (seekPending != null && currentPlayback?.item?.duration_ms) {
    const pos = Math.round(seekPending * currentPlayback.item.duration_ms);
    sendControl('seek', { position_ms: pos });
    seekPending = null;
  }
}

// ── Volume ────────────────────────────────────────────────────────
let volumePending = null;

dom.volumeBar.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  isDraggingVolume = true;
  volumeMove(e);
  document.addEventListener('pointermove', volumeMove);
  document.addEventListener('pointerup', volumeEnd);
});

function volumeMove(e) {
  const rect = dom.volumeBar.getBoundingClientRect();
  let x = (e.clientX - rect.left) / rect.width;
  x = Math.max(0, Math.min(1, x));
  dom.volumeFill.style.width = (x * 100) + '%';
  dom.volumeThumb.style.left = (x * 100) + '%';
  volumePending = Math.round(x * 100);
}

function volumeEnd(e) {
  document.removeEventListener('pointermove', volumeMove);
  document.removeEventListener('pointerup', volumeEnd);
  isDraggingVolume = false;
  
  if (volumePending != null) {
    sendControl('volume', { volume_percent: volumePending });
    volumePending = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────
function formatTime(ms) {
  if (!ms && ms !== 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ── Init ──────────────────────────────────────────────────────────
// Show loading immediately
showState('loading');

// Start after a short delay to let iCUE settings apply
setTimeout(() => {
  startPolling();
}, 300);