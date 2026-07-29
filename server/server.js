const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const TOKEN_FILE = path.join(__dirname, 'tokens.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Store for PKCE verifier + state between auth steps
let pkceState = {};

// ── Middleware ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── File Persistence ───────────────────────────────────────────────
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveTokens(tokens) {
  console.log('[Cxeify] Tokens saved successfully');
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { clientId: '' };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getClientId() {
  const config = loadConfig();
  if (config.clientId && config.clientId !== 'cxeify-custom') {
    return config.clientId;
  }
  return 'cxeify-custom';
}

// ── PKCE Helpers ────────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Spotify API Helpers ─────────────────────────────────────────────
async function fetchSpotifyToken(body) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token error: ${response.status} ${err}`);
  }
  return response.json();
}

async function refreshAccessToken(refreshToken) {
  const clientId = getClientId();
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  };
  console.log('[Cxeify] Refreshing access token...');
  const data = await fetchSpotifyToken(body);
  const tokens = loadTokens() || {};
  tokens.access_token = data.access_token;
  if (data.refresh_token) tokens.refresh_token = data.refresh_token;
  tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  saveTokens(tokens);
  return tokens.access_token;
}

async function getValidToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) return null;
  if (Date.now() >= (tokens.expires_at || 0)) {
    if (tokens.refresh_token) {
      return await refreshAccessToken(tokens.refresh_token);
    }
    return null;
  }
  return tokens.access_token;
}

let _spotifyApiError = null;

async function spotifyApi(endpoint, method = 'GET', body = null) {
  let token;
  try {
    token = await getValidToken();
  } catch (e) {
    _spotifyApiError = 'token_error';
    throw new Error(`Token error: ${e.message}`);
  }
  if (!token) {
    _spotifyApiError = 'not_authenticated';
    throw new Error('Not authenticated');
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, options);

  if (response.status === 401) {
    const tokens = loadTokens();
    if (tokens && tokens.refresh_token) {
      token = await refreshAccessToken(tokens.refresh_token);
      options.headers['Authorization'] = `Bearer ${token}`;
      const retryResp = await fetch(`https://api.spotify.com/v1${endpoint}`, options);
      _spotifyApiError = null;
      return retryResp;
    }
    _spotifyApiError = 'token_expired';
    throw new Error('Token expired and no refresh token available');
  }

  _spotifyApiError = null;
  return response;
}

// ── Routes ──────────────────────────────────────────────────────────

// Configure client ID
app.post('/api/configure', (req, res) => {
  const { clientId } = req.body;
  if (!clientId || clientId.trim() === '') {
    return res.status(400).json({ error: 'clientId is required' });
  }
  console.log('[Cxeify] Client ID configured:', clientId.trim());
  saveConfig({ clientId: clientId.trim() });
  // Clear old tokens when client ID changes
  if (fs.existsSync(TOKEN_FILE)) {
    fs.unlinkSync(TOKEN_FILE);
    console.log('[Cxeify] Old tokens cleared');
  }
  res.json({ success: true });
});

// Get auth status
app.get('/api/auth-status', (req, res) => {
  const tokens = loadTokens();
  const config = loadConfig();
  const hasRealClientId = !!config.clientId && config.clientId !== 'cxeify-custom';
  res.json({
    authenticated: !!tokens && !!tokens.access_token,
    configured: hasRealClientId,
    hasClientId: hasRealClientId,
  });
});

// Get Spotify auth URL
app.get('/api/auth-url', (req, res) => {
  const clientId = getClientId();
  if (!clientId || clientId === 'cxeify-custom') {
    return res.status(400).json({ error: 'No valid client ID configured. Save your Spotify Client ID first.' });
  }
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  pkceState[state] = { verifier, timestamp: Date.now() };
  console.log('[Cxeify] Generated auth URL with client ID:', clientId.substring(0, 8) + '...');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: [
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'playlist-read-private',
      'playlist-read-collaborative',
    ].join(' '),
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: state,
  });

  res.json({
    url: `https://accounts.spotify.com/authorize?${params.toString()}`,
  });
});

// OAuth callback
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.log('[Cxeify] OAuth error:', error);
    return res.send(`<h2>Authorization failed: ${error}</h2><p>Close this window and try again.</p>`);
  }

  if (!code || !state || !pkceState[state]) {
    console.log('[Cxeify] Invalid state in callback');
    return res.send(`<h2>Invalid state parameter. Please try again.</h2>`);
  }

  const { verifier } = pkceState[state];
  delete pkceState[state];

  try {
    const clientId = getClientId();
    console.log('[Cxeify] Exchanging auth code for tokens...');
    const data = await fetchSpotifyToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });

    const tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };
    saveTokens(tokens);

    console.log('[Cxeify] Authorization successful!');

    // Return a page that sends a message to the opener window and closes
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authorization</title></head>
      <body style="background:#121212;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <h2 style="color:#1DB954;">✅ Authorization successful!</h2>
          <p style="color:#b3b3b3;">You can close this window.</p>
        </div>
        <script>
          // Notify the opener window (setup page) that auth is complete
          if (window.opener) {
            window.opener.postMessage('spotify-auth-success', '*');
          }
          setTimeout(function() { window.close(); }, 500);
        </script>
      </body>
      </html>
    `);
  } catch (e) {
    console.log('[Cxeify] Token exchange failed:', e.message);
    res.send(`<h2>❌ Error: ${e.message}</h2><p>Make sure your Spotify Client ID is correct and the Redirect URI is set to: <code>${REDIRECT_URI}</code> in the Spotify Developer Dashboard.</p><p>Close this window and try again.</p>`);
  }
});

// Get current playback status
app.get('/api/status', async (req, res) => {
  try {
    // First check if we have tokens at all
    const tokens = loadTokens();
    if (!tokens || !tokens.access_token) {
      return res.json({
        active: false,
        auth: false,
        error: 'not_authenticated',
        data: null,
      });
    }

    const response = await spotifyApi('/me/player');

    if (response.status === 204) {
      return res.json({ 
        active: false, 
        auth: true,
        error: 'no_active_device',
        data: null 
      });
    }

    const data = await response.json();

    res.json({
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
    });
  } catch (e) {
    const errorType = _spotifyApiError || 'unknown';
    res.json({ 
      active: false, 
      auth: errorType === 'not_authenticated' ? false : true,
      error: errorType,
      data: null 
    });
  }
});

// Playback controls
app.post('/api/play', async (req, res) => {
  try {
    await spotifyApi('/me/player/play', 'PUT');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pause', async (req, res) => {
  try {
    await spotifyApi('/me/player/pause', 'PUT');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/next', async (req, res) => {
  try {
    await spotifyApi('/me/player/next', 'POST');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/previous', async (req, res) => {
  try {
    await spotifyApi('/me/player/previous', 'POST');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/seek', async (req, res) => {
  const { position_ms } = req.body;
  if (position_ms === undefined) {
    return res.status(400).json({ error: 'position_ms is required' });
  }
  try {
    await spotifyApi(`/me/player/seek?position_ms=${position_ms}`, 'PUT');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/volume', async (req, res) => {
  const { volume_percent } = req.body;
  if (volume_percent === undefined) {
    return res.status(400).json({ error: 'volume_percent is required' });
  }
  try {
    await spotifyApi(`/me/player/volume?volume_percent=${volume_percent}`, 'PUT');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shuffle', async (req, res) => {
  const { state } = req.body;
  if (state === undefined) {
    return res.status(400).json({ error: 'state is required' });
  }
  try {
    await spotifyApi(`/me/player/shuffle?state=${state}`, 'PUT');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repeat', async (req, res) => {
  const { state } = req.body;
  if (!state || !['off', 'context', 'track'].includes(state)) {
    return res.status(400).json({ error: 'state must be off, context, or track' });
  }
  try {
    await spotifyApi(`/me/player/repeat?state=${state}`, 'PUT');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve setup page
app.get('/', (req, res) => {
  const tokens = loadTokens();
  const config = loadConfig();
  const isAuth = !!tokens && !!tokens.access_token;
  const hasClientId = !!config.clientId && config.clientId !== 'cxeify-custom';
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Cxeify Server</title>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1e1e1e; padding: 40px; border-radius: 16px; text-align: center; max-width: 480px; width: 100%; }
    h1 { color: #1DB954; margin: 0 0 4px; font-size: 28px; }
    .subtitle { color: #b3b3b3; margin: 0 0 24px; font-size: 14px; }
    .status-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-size: 13px; margin: 8px 0 20px; font-weight: 500; }
    .status-badge.ok { background: #1DB95422; color: #1DB954; border: 1px solid #1DB95444; }
    .status-badge.no { background: #ff444422; color: #ff6666; border: 1px solid #ff444444; }
    .status-badge.warn { background: #ffaa0022; color: #ffaa00; border: 1px solid #ffaa0044; }
    .step { background: #2a2a2a; border-radius: 12px; padding: 20px; margin-bottom: 16px; text-align: left; }
    .step h3 { font-size: 14px; color: #1DB954; margin-bottom: 8px; }
    .step p { font-size: 13px; color: #b3b3b3; margin-bottom: 8px; line-height: 1.5; }
    label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; }
    input { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid #444; background: #1e1e1e; color: #fff; font-size: 14px; outline: none; box-sizing: border-box; }
    input:focus { border-color: #1DB954; }
    input::placeholder { color: #555; }
    button { display: inline-block; padding: 10px 24px; background: #1DB954; color: #000; border: none; border-radius: 24px; font-weight: 600; font-size: 14px; cursor: pointer; margin-top: 8px; }
    button:hover { background: #1ed760; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .hint { font-size: 11px; color: #666; margin-top: 20px; }
    .msg { font-size: 13px; margin-top: 8px; min-height: 20px; }
    .msg.success { color: #1DB954; }
    .msg.error { color: #ff6666; }
    .msg.info { color: #ffaa00; }
    .hidden { display: none; }
    code { background: #333; padding: 1px 4px; border-radius: 3px; font-size: 12px; color: #ddd; }
    a { color: #1DB954; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🎵 Cxeify</h1>
    <p class="subtitle">Spotify Companion Server</p>
    <div id="authBadge" class="status-badge ${isAuth ? 'ok' : (hasClientId ? 'warn' : 'no')}">
      ${isAuth ? '✅ Authorized with Spotify' : (hasClientId ? '⚠️ Configured, not authorized' : '❌ Not configured')}
    </div>

    <!-- Step 1: Configure Spotify Client ID -->
    <div class="step">
      <h3>Step 1: Spotify Client ID</h3>
      <p>Create a Spotify App at <a href="https://developer.spotify.com/dashboard" target="_blank">developer.spotify.com/dashboard</a></p>
      <p>In your app settings, add this Redirect URI: <code>${REDIRECT_URI}</code></p>
      <label for="clientId">Enter your Spotify Client ID:</label>
      <input type="text" id="clientId" placeholder="e.g. 123abc..." value="${config.clientId || ''}" />
      <button onclick="saveClientId()">Save Client ID</button>
      <div id="configMsg" class="msg"></div>
    </div>

    <!-- Step 2: Authorize -->
    <div class="step" id="step2">
      <h3>Step 2: Authorize Spotify</h3>
      <p>Grant access to control your Spotify playback.</p>
      <button id="authBtn" onclick="authorizeSpotify()" ${isAuth ? 'disabled' : ''}>
        ${isAuth ? '✅ Authorized' : 'Authorize with Spotify'}
      </button>
      <div id="authMsg" class="msg"></div>
    </div>

    <p class="hint">Server running on port ${PORT} &mdash; Keep this window open. The widget will connect automatically.</p>
  </div>

  <script>
    // Listen for postMessage from the callback popup
    window.addEventListener('message', function(event) {
      if (event.data === 'spotify-auth-success') {
        console.log('[Cxeify] Auth success message received from popup');
        checkAuthStatus();
      }
    });

    // Poll auth status to detect when auth completes
    async function checkAuthStatus() {
      try {
        const res = await fetch('/api/auth-status');
        const data = await res.json();
        const badge = document.getElementById('authBadge');
        const authBtn = document.getElementById('authBtn');
        const authMsg = document.getElementById('authMsg');

        if (data.authenticated) {
          badge.className = 'status-badge ok';
          badge.textContent = '✅ Authorized with Spotify';
          authBtn.disabled = true;
          authBtn.textContent = '✅ Authorized';
          authMsg.className = 'msg success';
          authMsg.textContent = '✅ Authorization complete! The widget on your Xeneon Edge will connect automatically.';
        } else if (data.configured) {
          badge.className = 'status-badge warn';
          badge.textContent = '⚠️ Configured, not authorized';
        } else {
          badge.className = 'status-badge no';
          badge.textContent = '❌ Not configured';
        }
      } catch (e) {
        // Server not reachable - ignore
      }
    }

    // Check every 2 seconds for auth status updates
    setInterval(checkAuthStatus, 2000);

    async function saveClientId() {
      const clientId = document.getElementById('clientId').value.trim();
      if (!clientId) return;
      const el = document.getElementById('configMsg');
      el.className = 'msg info';
      el.textContent = '⏳ Saving...';
      try {
        const res = await fetch('/api/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId }),
        });
        const data = await res.json();
        if (data.success) {
          el.className = 'msg success';
          el.textContent = '✅ Client ID saved! Now go to Step 2.';
          checkAuthStatus();
        } else {
          el.className = 'msg error';
          el.textContent = '❌ ' + (data.error || 'Failed to save');
        }
      } catch (e) {
        el.className = 'msg error';
        el.textContent = '❌ Server not reachable';
      }
    }

    async function authorizeSpotify() {
      const authMsg = document.getElementById('authMsg');
      authMsg.className = 'msg info';
      authMsg.textContent = '⏳ Opening Spotify authorization page...';
      try {
        const res = await fetch('/api/auth-url');
        const data = await res.json();
        if (data.error) {
          authMsg.className = 'msg error';
          authMsg.textContent = '❌ ' + data.error;
          return;
        }
        if (data.url) {
          window.open(data.url, 'spotify-auth', 'width=600,height=700');
          authMsg.className = 'msg info';
          authMsg.textContent = '⏳ Waiting for authorization... (check the popup)';
        }
      } catch (e) {
        authMsg.className = 'msg error';
        authMsg.textContent = '❌ Server not reachable';
      }
    }
  </script>
</body>
</html>
  `);
});

// Cleanup old PKCE states every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of Object.entries(pkceState)) {
    if (now - value.timestamp > 600000) {
      delete pkceState[key];
    }
  }
}, 600000);

// Start server
app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║              🎵 Cxeify Server                ║');
  console.log('  ║                                              ║');
  console.log(`  ║  Server running on http://127.0.0.1:${PORT}        ║`);
  console.log('  ║                                              ║');
  console.log('  ║  1. Open http://127.0.0.1:3000 in your     ║');
  console.log('  ║     browser to start setup                  ║');
  console.log('  ║  2. Enter your Spotify Client ID            ║');
  console.log('  ║  3. Authorize with Spotify                  ║');
  console.log('  ║  4. Widget connects automatically           ║');
  console.log('  ║                                              ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});