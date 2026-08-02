// ── State ─────────────────────────────────────────────────────────
const serverUrlEl = document.getElementById('serverUrl');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const btnOpen = document.getElementById('btnOpen');
const btnHide = document.getElementById('btnHide');
const btnQuit = document.getElementById('btnQuit');
const chkAutostart = document.getElementById('chkAutostart');
const errorMsg = document.getElementById('errorMsg');

// ── Load Initial State ────────────────────────────────────────────
async function init() {
  // Get server URL
  const url = await window.cxeify.getServerUrl();
  serverUrlEl.textContent = url;

  // Check autostart
  const autostart = await window.cxeify.getAutostart();
  chkAutostart.checked = autostart;

  // Check server status
  const status = await window.cxeify.getServerStatus();
  updateStatus(status.running);
}

function updateStatus(running) {
  if (running) {
    statusDot.className = 'status-dot running';
    statusLabel.className = 'status-label running';
    statusLabel.textContent = 'Running';
  } else {
    statusDot.className = 'status-dot stopped';
    statusLabel.className = 'status-label stopped';
    statusLabel.textContent = 'Stopped';
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = msg ? 'block' : 'none';
}

// ── Event Listeners ───────────────────────────────────────────────
btnOpen.addEventListener('click', () => {
  window.cxeify.openBrowser();
});

btnHide.addEventListener('click', () => {
  window.cxeify.minimizeWindow();
});

btnQuit.addEventListener('click', () => {
  window.cxeify.quitApp();
});

chkAutostart.addEventListener('change', () => {
  window.cxeify.setAutostart(chkAutostart.checked);
});

// ── IPC Events from Main ──────────────────────────────────────────
window.cxeify.onServerStarted(() => {
  updateStatus(true);
  showError('');
});

window.cxeify.onServerError((msg) => {
  updateStatus(false);
  showError('Server error: ' + msg);
});

// ── Init ──────────────────────────────────────────────────────────
init();
