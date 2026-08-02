const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Express Server bootstrap ──────────────────────────────────────
let server = null;
let mainWindow = null;
let tray = null;
let serverPort = 3000;

// Data directory for tokens/config (in user's appData folder)
const userDataPath = app.getPath('userData');
const tokensFile = path.join(userDataPath, 'tokens.json');
const configFile = path.join(userDataPath, 'config.json');

// Autostart
const autostartRegKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const autostartName = 'CxeifyCompanionServer';

function startServer(port) {
  return new Promise((resolve, reject) => {
    const usePort = port || 3000;
    const serverUrl = `http://127.0.0.1:${usePort}`;
    
    try {
      // Path to the widget files
      const widgetPath = app.isPackaged
        ? path.join(process.resourcesPath, 'widget', 'Cxeify')
        : path.join(__dirname, '..', 'Cxeify');

      const express = require('express');
      const cors = require('cors');
      const crypto = require('crypto');

      const expressApp = express();
      
      expressApp.use(cors());
      expressApp.use(express.json());

      // Serve widget files
      expressApp.use('/widget', express.static(widgetPath));
      expressApp.use('/widget', (req, res, next) => {
        if (!req.path.includes('.')) {
          res.sendFile(path.join(widgetPath, 'index.html'));
        } else {
          next();
        }
      });

      // File Persistence
      function loadTokens() {
        try { if (fs.existsSync(tokensFile)) return JSON.parse(fs.readFileSync(tokensFile, 'utf-8')); } catch (e) { /* ignore */ }
        return null;
      }
      function saveTokens(tokens) {
        fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
      }
      function loadConfig() {
        try { if (fs.existsSync(configFile)) return JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch (e) { /* ignore */ }
        return { clientId: '' };
      }
      function saveConfig(config) {
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      }
      function getClientId() {
        const c = loadConfig();
        return (c.clientId && c.clientId !== 'cxeify-custom') ? c.clientId : 'cxeify-custom';
      }
      const REDIRECT_URI = `http://127.0.0.1:${usePort}/callback`;

      // PKCE Helpers
      let pkceState = {};
      function generateCodeVerifier() { return crypto.randomBytes(32).toString('base64url'); }
      function generateCodeChallenge(verifier) { return crypto.createHash('sha256').update(verifier).digest('base64url'); }
      function generateState() { return crypto.randomBytes(16).toString('hex'); }

      // Spotify API
      async function fetchSpotifyToken(body) {
        const response = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body),
        });
        if (!response.ok) throw new Error(`Token error: ${response.status} ${await response.text()}`);
        return response.json();
      }

      async function refreshAccessToken(refreshToken) {
        const clientId = getClientId();
        const data = await fetchSpotifyToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
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
        if (Date.now() >= (tokens.expires_at || 0)) return tokens.refresh_token ? await refreshAccessToken(tokens.refresh_token) : null;
        return tokens.access_token;
      }

      let _spotifyApiError = null;
      async function spotifyApi(endpoint, method = 'GET', body = null) {
        let token;
        try { token = await getValidToken(); } catch (e) { _spotifyApiError = 'token_error'; throw new Error(`Token error: ${e.message}`); }
        if (!token) { _spotifyApiError = 'not_authenticated'; throw new Error('Not authenticated'); }
        const options = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
        if (body) options.body = JSON.stringify(body);
        const response = await fetch(`https://api.spotify.com/v1${endpoint}`, options);
        if (response.status === 401) {
          const t = loadTokens();
          if (t && t.refresh_token) {
            token = await refreshAccessToken(t.refresh_token);
            options.headers['Authorization'] = `Bearer ${token}`;
            _spotifyApiError = null;
            return await fetch(`https://api.spotify.com/v1${endpoint}`, options);
          }
          _spotifyApiError = 'token_expired'; throw new Error('Token expired');
        }
        _spotifyApiError = null;
        return response;
      }

      // Routes
      expressApp.post('/api/configure', (req, res) => {
        const { clientId } = req.body;
        if (!clientId || clientId.trim() === '') return res.status(400).json({ error: 'clientId is required' });
        saveConfig({ clientId: clientId.trim() });
        if (fs.existsSync(tokensFile)) fs.unlinkSync(tokensFile);
        res.json({ success: true });
      });

      expressApp.get('/api/auth-status', (req, res) => {
        const tokens = loadTokens();
        const config = loadConfig();
        const hasRealClientId = !!config.clientId && config.clientId !== 'cxeify-custom';
        res.json({ authenticated: !!tokens && !!tokens.access_token, configured: hasRealClientId, hasClientId: hasRealClientId });
      });

      expressApp.get('/api/auth-url', (req, res) => {
        const clientId = getClientId();
        if (!clientId || clientId === 'cxeify-custom') return res.status(400).json({ error: 'No valid client ID configured' });
        const state = generateState();
        const verifier = generateCodeVerifier();
        const challenge = generateCodeChallenge(verifier);
        pkceState[state] = { verifier, timestamp: Date.now() };
        const params = new URLSearchParams({
          response_type: 'code', client_id: clientId,
          scope: 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative',
          redirect_uri: REDIRECT_URI, code_challenge_method: 'S256', code_challenge: challenge, state,
        });
        res.json({ url: `https://accounts.spotify.com/authorize?${params.toString()}` });
      });

      expressApp.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        if (error) return res.send(`<h2>Authorization failed: ${error}</h2>`);
        if (!code || !state || !pkceState[state]) return res.send(`<h2>Invalid state parameter</h2>`);
        const { verifier } = pkceState[state];
        delete pkceState[state];
        try {
          const clientId = getClientId();
          const data = await fetchSpotifyToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier });
          const tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
          saveTokens(tokens);
          res.send(`<script>if(window.opener)window.opener.postMessage('spotify-auth-success','*');window.close()</script><p>✅ Authorized! You can close this window.</p>`);
        } catch (e) {
          res.send(`<h2>Error: ${e.message}</h2>`);
        }
      });

      expressApp.get('/api/status', async (req, res) => {
        try {
          const tokens = loadTokens();
          if (!tokens || !tokens.access_token) return res.json({ active: false, auth: false, error: 'not_authenticated', data: null });
          const response = await spotifyApi('/me/player');
          if (response.status === 204) return res.json({ active: false, auth: true, error: 'no_active_device', data: null });
          const data = await response.json();
          res.json({
            active: true, auth: true, data: {
              is_playing: data.is_playing, progress_ms: data.progress_ms,
              item: data.item ? { id: data.item.id, name: data.item.name, artists: data.item.artists.map(a => a.name), album: data.item.album.name, album_id: data.item.album.id, duration_ms: data.item.duration_ms, album_art: data.item.album.images?.[0]?.url || null, album_art_small: data.item.album.images?.[1]?.url || null } : null,
              device: data.device ? { id: data.device.id, name: data.device.name, type: data.device.type, volume_percent: data.device.volume_percent } : null,
              shuffle_state: data.shuffle_state, repeat_state: data.repeat_state,
            }
          });
        } catch (e) { res.json({ active: false, auth: _spotifyApiError !== 'not_authenticated' ? false : true, error: _spotifyApiError || 'unknown', data: null }); }
      });

      expressApp.post('/api/play', async (req, res) => { try { await spotifyApi('/me/player/play', 'PUT'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
      expressApp.post('/api/pause', async (req, res) => { try { await spotifyApi('/me/player/pause', 'PUT'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
      expressApp.post('/api/next', async (req, res) => { try { await spotifyApi('/me/player/next', 'POST'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
      expressApp.post('/api/previous', async (req, res) => { try { await spotifyApi('/me/player/previous', 'POST'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
      expressApp.post('/api/seek', async (req, res) => { const { position_ms } = req.body; if (position_ms === undefined) return res.status(400).json({ error: 'position_ms is required' }); try { await spotifyApi(`/me/player/seek?position_ms=${position_ms}`, 'PUT'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
      expressApp.post('/api/volume', async (req, res) => { const { volume_percent } = req.body; if (volume_percent === undefined) return res.status(400).json({ error: 'volume_percent is required' }); try { await spotifyApi(`/me/player/volume?volume_percent=${volume_percent}`, 'PUT'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
      expressApp.post('/api/shuffle', async (req, res) => { const { state } = req.body; if (state === undefined) return res.status(400).json({ error: 'state is required' }); try { await spotifyApi(`/me/player/shuffle?state=${state}`, 'PUT'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
      expressApp.post('/api/repeat', async (req, res) => { const { state } = req.body; if (!state || !['off','context','track'].includes(state)) return res.status(400).json({ error: 'state must be off, context, or track' }); try { await spotifyApi(`/me/player/repeat?state=${state}`, 'PUT'); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

      // Cleanup old PKCE states
      setInterval(() => {
        const now = Date.now();
        for (const [key, value] of Object.entries(pkceState)) { if (now - value.timestamp > 600000) delete pkceState[key]; }
      }, 600000);

      // Serve setup page
      expressApp.get('/', (req, res) => {
        const tokens = loadTokens();
        const config = loadConfig();
        const isAuth = !!tokens && !!tokens.access_token;
        const hasClientId = !!config.clientId && config.clientId !== 'cxeify-custom';
        res.send(`
<!DOCTYPE html>
<html>
<head><title>Cxeify Server</title>
<style>*{box-sizing:border-box;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#121212;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}.card{background:#1e1e1e;padding:40px;border-radius:16px;text-align:center;max-width:480px;width:100%}h1{color:#1DB954;margin:0 0 4px;font-size:28px}.subtitle{color:#b3b3b3;margin:0 0 24px;font-size:14px}.status-badge{display:inline-block;padding:6px 16px;border-radius:20px;font-size:13px;margin:8px 0 20px;font-weight:500}.status-badge.ok{background:#1DB95422;color:#1DB954;border:1px solid #1DB95444}.status-badge.no{background:#ff444422;color:#ff6666;border:1px solid #ff444444}.status-badge.warn{background:#ffaa0022;color:#ffaa00;border:1px solid #ffaa0044}.step{background:#2a2a2a;border-radius:12px;padding:20px;margin-bottom:16px;text-align:left}.step h3{font-size:14px;color:#1DB954;margin-bottom:8px}.step p{font-size:13px;color:#b3b3b3;margin-bottom:8px;line-height:1.5}label{display:block;font-size:12px;color:#888;margin-bottom:4px}input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid #444;background:#1e1e1e;color:#fff;font-size:14px;outline:none;box-sizing:border-box}input:focus{border-color:#1DB954}button{display:inline-block;padding:10px 24px;background:#1DB954;color:#000;border:none;border-radius:24px;font-weight:600;font-size:14px;cursor:pointer;margin-top:8px}button:hover{background:#1ed760}button:disabled{opacity:.5;cursor:not-allowed}.hint{font-size:11px;color:#666;margin-top:20px}.msg{font-size:13px;margin-top:8px;min-height:20px}.msg.success{color:#1DB954}.msg.error{color:#ff6666}.msg.info{color:#ffaa00}code{background:#333;padding:1px 4px;border-radius:3px;font-size:12px;color:#ddd}a{color:#1DB954}</style></head>
<body><div class="card"><h1>🎵 Cxeify</h1><p class="subtitle">Spotify Companion Server</p>
<div id="authBadge" class="status-badge ${isAuth?'ok':(hasClientId?'warn':'no')}">${isAuth?'✅ Authorized':(hasClientId?'⚠️ Configured, not authorized':'❌ Not configured')}</div>
<div class="step"><h3>Step 1: Spotify Client ID</h3><p>Create a Spotify App at <a href="https://developer.spotify.com/dashboard" target="_blank">developer.spotify.com/dashboard</a></p><p>Add Redirect URI: <code>${REDIRECT_URI}</code></p>
<label for="clientId">Enter your Spotify Client ID:</label><input type="text" id="clientId" placeholder="e.g. 123abc..." value="${config.clientId||''}" />
<button onclick="saveClientId()">Save Client ID</button><div id="configMsg" class="msg"></div></div>
<div class="step"><h3>Step 2: Authorize Spotify</h3><p>Grant access to control your Spotify playback.</p>
<button id="authBtn" onclick="authorizeSpotify()" ${isAuth?'disabled':''}>${isAuth?'✅ Authorized':'Authorize with Spotify'}</button><div id="authMsg" class="msg"></div></div>
<p class="hint">Widget connects with http://127.0.0.1:${usePort}</p></div>
<script>
window.addEventListener('message',function(e){if(e.data==='spotify-auth-success')checkAuthStatus()});
async function checkAuthStatus(){try{const r=await fetch('/api/auth-status');const d=await r.json();const badge=document.getElementById('authBadge');const btn=document.getElementById('authBtn');const msg=document.getElementById('authMsg');if(d.authenticated){badge.className='status-badge ok';badge.textContent='✅ Authorized with Spotify';btn.disabled=true;btn.textContent='✅ Authorized';msg.className='msg success';msg.textContent='✅ Authorization complete!'}else if(d.configured){badge.className='status-badge warn';badge.textContent='⚠️ Configured, not authorized'}else{badge.className='status-badge no';badge.textContent='❌ Not configured'}}catch(e){}}
setInterval(checkAuthStatus,2000);
async function saveClientId(){const c=document.getElementById('clientId').value.trim();if(!c)return;const el=document.getElementById('configMsg');el.className='msg info';el.textContent='⏳ Saving...';try{const r=await fetch('/api/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:c})});const d=await r.json();if(d.success){el.className='msg success';el.textContent='✅ Client ID saved!';checkAuthStatus()}else{el.className='msg error';el.textContent='❌ '+(d.error||'Failed')}}catch(e){el.className='msg error';el.textContent='❌ Server unreachable'}}
async function authorizeSpotify(){const m=document.getElementById('authMsg');m.className='msg info';m.textContent='⏳ Opening Spotify...';try{const r=await fetch('/api/auth-url');const d=await r.json();if(d.error){m.className='msg error';m.textContent='❌ '+d.error;return}if(d.url)window.open(d.url,'spotify-auth','width=600,height=700')}catch(e){m.className='msg error';m.textContent='❌ Server unreachable'}}
</script></body></html>
        `);
      });

      server = expressApp.listen(usePort, '127.0.0.1', () => {
        console.log(`[Cxeify] Server running on http://127.0.0.1:${usePort}`);
        serverPort = usePort;
        resolve(usePort);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[Cxeify] Port ${usePort} in use, trying ${usePort + 1}...`);
          startServer(usePort + 1).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

    } catch (e) {
      reject(e);
    }
  });
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}

// ── Autostart ─────────────────────────────────────────────────────
function setAutostart(enabled) {
  const { execSync } = require('child_process');
  try {
    if (enabled) {
      const exePath = app.isPackaged ? app.getPath('exe') : process.execPath;
      execSync(`REG ADD "${autostartRegKey}" /V "${autostartName}" /T REG_SZ /F /D "${exePath}"`);
    } else {
      execSync(`REG DELETE "${autostartRegKey}" /V "${autostartName}" /F 2>nul`);
    }
  } catch (e) { /* ignore */ }
}

function isAutostartEnabled() {
  const { execSync } = require('child_process');
  try {
    execSync(`REG QUERY "${autostartRegKey}" /V "${autostartName}" 2>nul`);
    return true;
  } catch (e) {
    return false;
  }
}

// ── Tray Icon ─────────────────────────────────────────────────────
function createTray() {
  // Create a simple 16x16 icon using nativeImage
  const iconSize = 16;
  const canvas = Buffer.alloc(iconSize * iconSize * 4);
  for (let y = 0; y < iconSize; y++) {
    for (let x = 0; x < iconSize; x++) {
      const idx = (y * iconSize + x) * 4;
      // Simple green circle
      const cx = iconSize / 2, cy = iconSize / 2, r = 6;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        canvas[idx] = 0x1D;     // R
        canvas[idx + 1] = 0xB9; // G
        canvas[idx + 2] = 0x54; // B
        canvas[idx + 3] = 255;  // A
      } else {
        canvas[idx + 3] = 0; // Transparent
      }
    }
  }
  const icon = nativeImage.createFromBuffer(canvas, { width: iconSize, height: iconSize });
  
  tray = new Tray(icon);
  tray.setToolTip('Cxeify Companion Server');

  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Show Cxeify', 
      click: () => { 
        if (mainWindow && !mainWindow.isDestroyed()) { 
          mainWindow.show(); 
          mainWindow.focus(); 
        } else {
          createWindow();
        }
      } 
    },
    { label: 'Open Setup in Browser', click: () => { require('electron').shell.openExternal(`http://127.0.0.1:${serverPort}`); } },
    { type: 'separator' },
    {
      label: 'Autostart with Windows',
      type: 'checkbox',
      checked: isAutostartEnabled(),
      click: (menuItem) => { setAutostart(menuItem.checked); }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { 
    if (mainWindow && !mainWindow.isDestroyed()) { 
      mainWindow.show(); 
      mainWindow.focus(); 
    } else {
      createWindow();
    }
  });
}

// ── Main Window ───────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 380,
    resizable: false,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0a',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────
ipcMain.handle('get-server-url', () => `http://127.0.0.1:${serverPort}`);
ipcMain.handle('get-server-status', () => ({ running: server !== null, port: serverPort }));
ipcMain.handle('get-autostart', () => isAutostartEnabled());
ipcMain.handle('set-autostart', (event, enabled) => { setAutostart(enabled); return true; });
ipcMain.handle('open-browser', () => { require('electron').shell.openExternal(`http://127.0.0.1:${serverPort}`); });
ipcMain.handle('minimize-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); });
ipcMain.handle('quit-app', () => { app.isQuitting = true; app.quit(); });

// ── App Lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  createTray();
  createWindow();
  
  try {
    await startServer();
    if (mainWindow) mainWindow.webContents.send('server-started');
  } catch (e) {
    console.error('[Cxeify] Failed to start server:', e);
    if (mainWindow) mainWindow.webContents.send('server-error', e.message);
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopServer();
});