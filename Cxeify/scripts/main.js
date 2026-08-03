/**
 * Cxeify - Spotify Controller for Xeneon Edge
 * 
 * Communicates directly with the Spotify Web API (no companion server needed).
 * Uses PKCE OAuth tokens stored in iCUE settings.
 */

// ── Dev Mode ─────────────────────────────────────────────────────────
// Set to true to preview the player UI without needing Spotify credentials.
// Shows a simulated player with random dummy data (ideal for visual editors).
var DEV_MODE = false;

// ── State ─────────────────────────────────────────────────────────
const state = {
  clientId: '',
  refreshToken: '',
  pollingInterval: 2000,
  textColor: '#ffffff',
  accentColor: '#1DB954',
  backgroundColor: '#121212',
  transparency: 60,
  songInfoColor: '#ffffff',
  playBtnColor: '#1DB954',
  prevNextColor: '#ffffff',
  activeBtnColor: '#1DB954',
  barFillColor: '#1DB954',
};

let pollTimer = null;
let isSeeking = false;
let isDraggingVolume = false;
let currentPlayback = null;
let cachedAccessToken = null;
let tokenExpiresAt = 0;

// ── Adaptive Polling ────────────────────────────────────────────────
let currentInterval = 2000;       // actual interval used right now
let consecutiveErrors = 0;        // 429 or network errors
let lastActiveTime = 0;           // timestamp of last valid playback
let isPaused = false;             // whether we know playback is paused
let isSessionAlive = false;       // whether we have a known active device
let pollTimeout = null;           // setTimeout handle for adaptive polling

// ── DOM References ────────────────────────────────────────────────
const dom = {
  loading: document.getElementById('state-loading'),
  offline: document.getElementById('state-offline'),
  nodevice: document.getElementById('state-nodevice'),
  noauth: document.getElementById('state-noauth'),
  player: document.getElementById('player'),
  albumBg: document.getElementById('album-bg'),
  trackName: document.getElementById('track-name'),
  trackArtist: document.getElementById('track-artist'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  progressThumb: document.getElementById('progress-thumb'),
  timeCurrent: document.getElementById('time-current'),
  timeTotal: document.getElementById('time-total'),
  playIcon: document.getElementById('play-icon'),
  pauseIcon: document.getElementById('pause-icon'),
  btnPlay: document.getElementById('btn-play'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnShuffle: document.getElementById('btn-shuffle'),
  btnRepeat: document.getElementById('btn-repeat'),
  repeatIndicator: document.getElementById('repeat-indicator'),
  volumeBar: document.getElementById('volume-bar'),
  volumeFill: document.getElementById('volume-fill'),
  volumeThumb: document.getElementById('volume-thumb'),
};

// ── Settings (from iCUE) ──────────────────────────────────────────
function getIcueProperty(name, defaultValue) {
  try {
    if (typeof window !== 'undefined' && name in window) {
      const val = window[name];
      if (val !== undefined && val !== null && val !== '') return val;
    }
    const val = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
    if (val !== undefined && val !== null && val !== '') return val;
  } catch (e) { /* ignore */ }
  return defaultValue;
}

function applySettings(settings = {}) {
  // In dev mode, don't start real polling
  if (DEV_MODE) return;
  Object.assign(state, settings);
  state.backgroundColor = getIcueProperty('backgroundColor', state.backgroundColor);
  state.transparency = getIcueProperty('transparency', state.transparency);
  state.clientId = getIcueProperty('clientId', state.clientId);
  state.refreshToken = getIcueProperty('refreshToken', state.refreshToken);
  state.pollingInterval = getIcueProperty('pollingInterval', state.pollingInterval);
  state.songInfoColor = getIcueProperty('songInfoColor', state.songInfoColor);
  state.playBtnColor = getIcueProperty('playBtnColor', state.playBtnColor);
  state.prevNextColor = getIcueProperty('prevNextColor', state.prevNextColor);
  state.activeBtnColor = getIcueProperty('activeBtnColor', state.activeBtnColor);
  state.barFillColor = getIcueProperty('barFillColor', state.barFillColor);
  
  // Apply CSS variables
  document.documentElement.style.setProperty('--text-color', state.textColor);
  document.documentElement.style.setProperty('--accent-color', state.accentColor);
  document.documentElement.style.setProperty('--background-color', state.backgroundColor);
  document.documentElement.style.setProperty('--transparency', state.transparency + '%');
  document.documentElement.style.setProperty('--song-info-color', state.songInfoColor);
  document.documentElement.style.setProperty('--play-btn-color', state.playBtnColor);
  document.documentElement.style.setProperty('--prev-next-color', state.prevNextColor);
  document.documentElement.style.setProperty('--active-btn-color', state.activeBtnColor);
  document.documentElement.style.setProperty('--bar-fill-color', state.barFillColor);

  // Dynamic play button icon color (black on bright bg, white on dark bg)
  const hex = state.playBtnColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const iconColor = luminance > 0.5 ? '#000000' : '#ffffff';
  document.documentElement.style.setProperty('--play-btn-icon-color', iconColor);

  console.log('[Cxeify] Settings applied:', JSON.stringify(state));

  // Restart polling with new interval if changed
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  pollTimer = null;
  startPolling();
}

// ── Spotify Token Management ──────────────────────────────────────
async function refreshAccessToken() {
  if (!state.clientId || !state.refreshToken) {
    console.log('[Cxeify] No client ID or refresh token configured');
    return null;
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: state.refreshToken,
        client_id: state.clientId,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.warn('[Cxeify] Token refresh failed:', response.status, err);
      return null;
    }

    const data = await response.json();
    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return cachedAccessToken;
  } catch (e) {
    console.warn('[Cxeify] Token refresh error:', e.message);
    return null;
  }
}

async function getValidToken() {
  // If we have a cached token that's still valid, use it
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }
  // Otherwise refresh
  return await refreshAccessToken();
}

// ── Spotify API Calls ─────────────────────────────────────────────
async function spotifyApi(endpoint, method = 'GET', body = null) {
  const token = await getValidToken();
  if (!token) {
    return null;
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(`https://api.spotify.com/v1${endpoint}`, options);

    if (response.status === 401) {
      // Token expired, try refreshing once
      const newToken = await refreshAccessToken();
      if (newToken) {
        options.headers['Authorization'] = `Bearer ${newToken}`;
        return await fetch(`https://api.spotify.com/v1${endpoint}`, options);
      }
      return null;
    }

    if (response.status === 429) {
      // Rate limited — apply exponential backoff
      const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
      handleRateLimit(retryAfter);
      return null;
    }

    return response;
  } catch (e) {
    console.warn('[Cxeify] API error:', e.message);
    consecutiveErrors++;
    return null;
  }
}

async function fetchStatus() {
  const response = await spotifyApi('/me/player');
  // response === null means API unavailable (network error, rate limit, etc.)
  if (!response) return { active: false, auth: null, data: null };
  
  if (response.status === 204) {
    return { active: false, auth: true, data: null };
  }

  try {
    const data = await response.json();
    return {
      active: true,
      auth: true,
      data: {
        is_playing: data.is_playing,
        progress_ms: data.progress_ms,
        item: data.item ? {
          id: data.item.id,
          name: data.item.name,
          artists: data.item.artists.map(a => a.name),
          duration_ms: data.item.duration_ms,
          album_art: data.item.album.images?.[0]?.url || null,
        } : null,
        device: data.device ? {
          volume_percent: data.device.volume_percent,
        } : null,
        shuffle_state: data.shuffle_state,
        repeat_state: data.repeat_state,
      },
    };
  } catch (e) {
    return { active: false, auth: true, data: null };
  }
}

async function sendControl(endpoint, method = 'PUT', body = null) {
  await spotifyApi(endpoint, method, body);
}

// ── Polling ───────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) return;
  if (DEV_MODE) return;          // never poll in dev mode
  pollTimer = true;
  currentInterval = state.pollingInterval;
  scheduleNextPoll(0);
}

function scheduleNextPoll(delay) {
  if (pollTimeout) clearTimeout(pollTimeout);
  pollTimeout = setTimeout(runPoll, delay);
}

// Compute the current adaptive interval based on state
function getAdaptiveInterval() {
  const base = Math.max(state.pollingInterval, 1000);

  // If we're in error backoff, keep the current (already increased) interval
  if (consecutiveErrors > 0) {
    return currentInterval;
  }

  // No known session → slowest
  if (!isSessionAlive) return Math.min(base * 10, 30000);
  // Paused → medium
  if (isPaused) return Math.min(base * 5, 10000);
  // Playing → base interval
  return base;
}

// Jitter to avoid thundering-herd sync with other clients
function jitter(ms) {
  return ms + Math.floor(Math.random() * 500);
}

async function runPoll() {
  // Check if credentials are configured
  if (!state.clientId || !state.refreshToken) {
    showState('noauth');
    scheduleNextPoll(jitter(currentInterval));
    return;
  }

  const result = await fetchStatus();

  // result.auth === null means API unavailable (network / rate limit)
  if (result.auth === null) {
    consecutiveErrors++;
    if (consecutiveErrors >= 3) {
      // Back off aggressively
      currentInterval = Math.min(currentInterval * 2, 60000);
    }
    showState('offline');
    scheduleNextPoll(jitter(currentInterval));
    return;
  }

  if (result.auth === false) {
    showState('noauth');
    scheduleNextPoll(jitter(currentInterval));
    return;
  }

  // Successful request — reset error counter
  consecutiveErrors = 0;

  if (!result.active || !result.data) {
    // No active playback/device
    isSessionAlive = false;
    isPaused = false;
    showState('nodevice');

    // Keep the session fresh by pinging devices occasionally
    if (Date.now() - lastActiveTime > 5 * 60 * 1000) {
      keepSessionAlive();
    }
    currentInterval = getAdaptiveInterval();
    scheduleNextPoll(jitter(currentInterval));
    return;
  }

  // Active playback
  isSessionAlive = true;
  lastActiveTime = Date.now();
  isPaused = !result.data.is_playing;

  updatePlayback(result.data);
  showState('player');

  // Use adaptive interval
  currentInterval = getAdaptiveInterval();
  scheduleNextPoll(jitter(currentInterval));
}

// Trigger a lightweight API call to keep the Spotify session alive
async function keepSessionAlive() {
  try {
    console.log('[Cxeify] Keeping session alive...');
    const response = await spotifyApi('/me/player/devices');
    if (response && response.ok) {
      const data = await response.json();
      const hasDevices = data.devices && data.devices.length > 0;
      if (hasDevices) {
        isSessionAlive = true;
      }
    }
  } catch (e) {
    console.warn('[Cxeify] Session keep-alive failed:', e.message);
  }
}

// Handle 429 rate-limit responses with exponential backoff
function handleRateLimit(retryAfterMs) {
  consecutiveErrors++;
  // If Spotify told us how long to wait, use that (or at least 10s)
  const backoffMs = Math.max(retryAfterMs * 1000 || 0, 10000);
  currentInterval = Math.min(Math.max(currentInterval * 2, backoffMs), 60000);
  console.warn('[Cxeify] Rate limited. Backing off to', currentInterval, 'ms');
}

// ── UI State Management ───────────────────────────────────────────
function showState(name) {
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
}

// ── Playback Update ───────────────────────────────────────────────
function updatePlayback(data) {
  currentPlayback = data;
  
  // Track info
  if (data.item) {
    dom.trackName.textContent = data.item.name || '-';
    dom.trackArtist.textContent = data.item.artists ? data.item.artists.join(', ') : '-';
    
    // Album art background
    const artUrl = data.item.album_art;
    if (artUrl) {
      dom.albumBg.style.backgroundImage = `url('${artUrl}')`;
    }
  }
  
  // Play/Pause button
  if (data.is_playing) {
    dom.playIcon.classList.add('state-hidden');
    dom.pauseIcon.classList.remove('state-hidden');
  } else {
    dom.playIcon.classList.remove('state-hidden');
    dom.pauseIcon.classList.add('state-hidden');
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
dom.btnPlay.addEventListener('click', async () => {
  if (DEV_MODE) {
    // In dev mode, just toggle local state
    if (currentPlayback) {
      currentPlayback.is_playing = !currentPlayback.is_playing;
      updatePlayback(currentPlayback);
    }
    return;
  }
  if (currentPlayback?.is_playing) {
    await sendControl('/me/player/pause', 'PUT');
  } else {
    await sendControl('/me/player/play', 'PUT');
  }
});

dom.btnNext.addEventListener('click', async () => {
  if (DEV_MODE) {
    // In dev mode, cycle to next mock track
    mockNextTrack();
    return;
  }
  await sendControl('/me/player/next', 'POST');
});

dom.btnPrev.addEventListener('click', async () => {
  if (DEV_MODE) {
    // In dev mode, cycle to previous mock track
    mockPrevTrack();
    return;
  }
  await sendControl('/me/player/previous', 'POST');
});

dom.btnShuffle.addEventListener('click', async () => {
  const newState = dom.btnShuffle.dataset.active !== 'true';
  if (DEV_MODE) {
    dom.btnShuffle.dataset.active = newState ? 'true' : 'false';
    return;
  }
  await sendControl(`/me/player/shuffle?state=${newState}`, 'PUT');
  dom.btnShuffle.dataset.active = newState ? 'true' : 'false';
});

dom.btnRepeat.addEventListener('click', async () => {
  const current = dom.btnRepeat.dataset.active === 'true' 
    ? (dom.repeatIndicator.hidden ? 'context' : 'track') 
    : 'off';
  const next = current === 'off' ? 'context' : current === 'context' ? 'track' : 'off';
  if (DEV_MODE) {
    dom.btnRepeat.dataset.active = next !== 'off' ? 'true' : 'false';
    dom.repeatIndicator.hidden = next !== 'track';
    return;
  }
  await sendControl(`/me/player/repeat?state=${next}`, 'PUT');
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

function seekEnd() {
  document.removeEventListener('pointermove', seekMove);
  document.removeEventListener('pointerup', seekEnd);
  isSeeking = false;
  
  if (seekPending != null && currentPlayback?.item?.duration_ms) {
    const pos = Math.round(seekPending * currentPlayback.item.duration_ms);
    if (DEV_MODE) {
      // In dev mode, just update local state
      if (currentPlayback) {
        currentPlayback.progress_ms = pos;
        updatePlayback(currentPlayback);
      }
    } else {
      sendControl(`/me/player/seek?position_ms=${pos}`, 'PUT');
    }
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

function volumeEnd() {
  document.removeEventListener('pointermove', volumeMove);
  document.removeEventListener('pointerup', volumeEnd);
  isDraggingVolume = false;
  
  if (volumePending != null) {
    if (DEV_MODE) {
      // In dev mode, just update local state
      if (currentPlayback) {
        currentPlayback.device.volume_percent = volumePending;
        updatePlayback(currentPlayback);
      }
    } else {
      sendControl(`/me/player/volume?volume_percent=${volumePending}`, 'PUT');
    }
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

// ── Dev Mode: Mock Data ───────────────────────────────────────────
// Only used when DEV_MODE = true. Provides realistic dummy playback
// data so the player UI can be previewed in visual editors.

const MOCK_TRACKS = [
  { name: 'Blinding Lights', artist: 'The Weeknd', duration: 200000 },
  { name: 'Shape of You', artist: 'Ed Sheeran', duration: 233000 },
  { name: 'Bohemian Rhapsody', artist: 'Queen', duration: 354000 },
  { name: 'Stairway to Heaven', artist: 'Led Zeppelin', duration: 482000 },
  { name: 'Hotel California', artist: 'Eagles', duration: 391000 },
  { name: 'Smells Like Teen Spirit', artist: 'Nirvana', duration: 301000 },
  { name: 'Billie Jean', artist: 'Michael Jackson', duration: 294000 },
  { name: 'Sweet Child O\' Mine', artist: 'Guns N\' Roses', duration: 356000 },
  { name: 'Imagine', artist: 'John Lennon', duration: 187000 },
  { name: 'Purple Rain', artist: 'Prince', duration: 521000 },
];

const MOCK_COLORS = [
  '#1e3a5f', '#5a2d3a', '#2d5a3a', '#5a4a2d', '#3a2d5a',
  '#2d5a5a', '#5a3a2d', '#3a5a2d', '#4a2d5a', '#2d3a5a',
];

let mockTrackIndex = 0;
let mockTimer = null;

function generateMockData() {
  const track = MOCK_TRACKS[mockTrackIndex];
  const color = MOCK_COLORS[mockTrackIndex];
  const progress = Math.floor(Math.random() * track.duration * 0.8);
  const isPlaying = isPaused ? false : true;

  return {
    is_playing: isPlaying,
    progress_ms: progress,
    item: {
      id: 'mock-' + mockTrackIndex,
      name: track.name,
      artists: [track.artist],
      duration_ms: track.duration,
      album_art: `https://placehold.co/640x640/${color.replace('#', '')}/ffffff?text=${track.name.charAt(0)}`,
    },
    device: {
      volume_percent: 70,
    },
    shuffle_state: dom.btnShuffle.dataset.active === 'true',
    repeat_state: dom.btnRepeat.dataset.active === 'true' 
      ? (dom.repeatIndicator.hidden ? 'context' : 'track')
      : 'off',
  };
}

function mockNextTrack() {
  mockTrackIndex = (mockTrackIndex + 1) % MOCK_TRACKS.length;
  const data = { ...generateMockData(), is_playing: true };
  isPaused = false;
  updatePlayback({ active: true, auth: true, data });
  showState('player');
}

function mockPrevTrack() {
  mockTrackIndex = (mockTrackIndex - 1 + MOCK_TRACKS.length) % MOCK_TRACKS.length;
  const data = { ...generateMockData(), is_playing: true };
  isPaused = false;
  updatePlayback({ active: true, auth: true, data });
  showState('player');
}

function startMockMode() {
  console.log('[Cxeify] DEV_MODE active — showing simulated player');
  
  // Prevent any polling from starting
  pollTimer = true;
  
  // Hide loading, show player immediately
  showState('player');
  
  // Generate initial mock data and apply it
  const mock = generateMockData();
  updatePlayback(mock);
  
  // Update mock data periodically to simulate live playback
  mockTimer = setInterval(() => {
    const mock = generateMockData();
    updatePlayback(mock);
    
    // Occasionally toggle play/pause for visual variety
    if (Math.random() < 0.05) {
      isPaused = !isPaused;
      if (currentPlayback) {
        currentPlayback.is_playing = !isPaused;
        updatePlayback(currentPlayback);
      }
    }
  }, 2000);
}

// ── Init ──────────────────────────────────────────────────────────
if (DEV_MODE) {
  // Add dev-mode class to <html> so CSS overrides hide overlays
  document.documentElement.classList.add('dev-mode');
  startMockMode();
} else {
  // Show loading immediately
  showState('loading');

  // Start after a short delay to let iCUE settings apply
  setTimeout(() => {
    startPolling();
  }, 300);
}
