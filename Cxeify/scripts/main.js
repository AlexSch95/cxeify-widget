/**
 * Cxeify - Spotify Controller for Xeneon Edge
 * 
 * Communicates directly with the Spotify Web API (no companion server needed).
 * Uses PKCE OAuth tokens stored in iCUE settings.
 */

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
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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
let lastApiError = null;

async function spotifyApi(endpoint, method = 'GET', body = null) {
  const token = await getValidToken();
  if (!token) {
    lastApiError = 'not_authenticated';
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
        const retryResp = await fetch(`https://api.spotify.com/v1${endpoint}`, options);
        lastApiError = null;
        return retryResp;
      }
      lastApiError = 'token_expired';
      return null;
    }

    lastApiError = null;
    return response;
  } catch (e) {
    console.warn('[Cxeify] API error:', e.message);
    lastApiError = 'network_error';
    return null;
  }
}

async function fetchStatus() {
  const response = await spotifyApi('/me/player');
  if (!response) return { active: false, auth: false, error: lastApiError, data: null };
  
  if (response.status === 204) {
    return { active: false, auth: true, error: 'no_active_device', data: null };
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
          album: data.item.album.name,
          album_id: data.item.album.id,
          duration_ms: data.item.duration_ms,
          album_art: data.item.album.images?.[0]?.url || null,
          album_art_small: data.item.album.images?.[1]?.url || null,
        } : null,
        device: data.device ? {
          id: data.device.id,
          name: data.device.name,
          type: data.device.type,
          volume_percent: data.device.volume_percent,
        } : null,
        shuffle_state: data.shuffle_state,
        repeat_state: data.repeat_state,
      },
    };
  } catch (e) {
    return { active: false, auth: true, error: 'parse_error', data: null };
  }
}

async function sendControl(endpoint, method = 'PUT', body = null) {
  await spotifyApi(endpoint, method, body);
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
  // Check if credentials are configured
  if (!state.clientId || !state.refreshToken) {
    console.log('[Cxeify] → Not configured (no clientId or refreshToken)');
    showState('noauth');
    return;
  }

  const result = await fetchStatus();
  
  console.log('[Cxeify] Poll result:', JSON.stringify(result));
  
  if (!result) {
    console.log('[Cxeify] → Network error');
    showState('offline');
    return;
  }
  
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
    
    // Album art
    const artUrl = data.item.album_art || data.item.album_art_small;
    if (artUrl) {
      dom.albumImg.src = artUrl;
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
  if (currentPlayback?.is_playing) {
    await sendControl('/me/player/pause', 'PUT');
  } else {
    await sendControl('/me/player/play', 'PUT');
  }
});

dom.btnNext.addEventListener('click', async () => {
  await sendControl('/me/player/next', 'POST');
});

dom.btnPrev.addEventListener('click', async () => {
  await sendControl('/me/player/previous', 'POST');
});

dom.btnShuffle.addEventListener('click', async () => {
  const newState = dom.btnShuffle.dataset.active !== 'true';
  await sendControl(`/me/player/shuffle?state=${newState}`, 'PUT');
  dom.btnShuffle.dataset.active = newState ? 'true' : 'false';
});

dom.btnRepeat.addEventListener('click', async () => {
  const current = dom.btnRepeat.dataset.active === 'true' 
    ? (dom.repeatIndicator.hidden ? 'context' : 'track') 
    : 'off';
  const next = current === 'off' ? 'context' : current === 'context' ? 'track' : 'off';
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

function seekEnd(e) {
  document.removeEventListener('pointermove', seekMove);
  document.removeEventListener('pointerup', seekEnd);
  isSeeking = false;
  
  if (seekPending != null && currentPlayback?.item?.duration_ms) {
    const pos = Math.round(seekPending * currentPlayback.item.duration_ms);
    sendControl(`/me/player/seek?position_ms=${pos}`, 'PUT');
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
    sendControl(`/me/player/volume?volume_percent=${volumePending}`, 'PUT');
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