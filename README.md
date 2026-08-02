# Cxeify

A Spotify controller widget for **Corsair Xeneon Edge** displays.

## Overview

Cxeify turns your Xeneon Edge into a Spotify remote control. It consists of two parts:

1. **Widget** (`Cxeify/`) – The iCUE HTML widget that runs on your Xeneon Edge display
2. **Setup Page** (`docs/`) – A browser-based OAuth setup that generates your Spotify credentials

No companion server or desktop app is required. The widget communicates directly with the Spotify Web API using PKCE OAuth.

## Features

- Real-time playback control: Play, pause, skip, seek
- Volume control directly from your Xeneon Edge
- Shuffle & Repeat mode toggles
- Album art display with blurred background
- Automatically detects active Spotify device
- Touch-optimized for Xeneon Edge displays
- Customizable accent color, text color, background & transparency
- **No companion server required** – direct Spotify API communication
- All data stays local – no external services other than Spotify's API

## Setup

### Prerequisites

- **Corsair iCUE** (v5.45 or newer) with a Xeneon Edge device
- **Spotify Premium** account
- A modern web browser (Chrome, Edge, Firefox)

### Step 1: OAuth Setup

1. Open **`docs/index.html`** in your browser (double-click the file)
2. Read the privacy notice and click **"I Understand"**
3. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in
4. Click **"Create App"**:
   - App name: `Cxeify`
   - App description: `iCUE Widget for Xeneon Edge`
   - APIs used: ✅ **Web API**
5. Click **"Save"**, then click **"Settings"** in your app's dashboard
6. Under **"Redirect URIs"**, add the URL shown on the setup page (use the **Copy** button) and click **"Add"**, then **"Save"**
7. Copy your **Client ID** from the app dashboard and paste it into the setup page
8. Click **"Authorize with Spotify"** and log in – you will be redirected back with your credentials
9. Copy the generated **Client ID** and **Refresh Token**

### Step 2: Install the Widget

1. Copy the entire `Cxeify/` folder to your iCUE widgets directory:
   - `%APPDATA%/Corsair/CUE5/widgets/widgets/` (Windows)
2. Open iCUE and navigate to your Xeneon Edge settings
3. Select the **Cxeify** widget from the widget picker

### Step 3: Configure in iCUE

Open the widget settings (gear icon) and enter the credentials from Step 1:

| Setting | Description |
|---------|-------------|
| Spotify Client ID | Your Spotify app's Client ID |
| Spotify Refresh Token | The token generated during setup |
| Update Interval | How often to refresh playback status (default: 2000ms) |

Under **Widget Personalization** you can adjust colors and transparency:

| Setting | Default | Description |
|---------|---------|-------------|
| Text Color | `#ffffff` | Color of text |
| Accent Color | `#1DB954` | Spotify green accent |
| Background Color | `#121212` | Background color |
| Albumcover Backdrop Transparency | 0% | Transparency of the blurred album art backdrop |

The widget will connect automatically once configured.

## Project Structure

```
├── Cxeify/                   # iCUE HTML Widget
│   ├── index.html            # Main widget HTML + meta properties
│   ├── manifest.json         # Widget manifest
│   ├── translation.json      # UI labels
│   ├── scripts/
│   │   └── main.js           # Widget logic: polling, controls, settings
│   ├── styles/
│   │   └── main.css          # Responsive styling for Xeneon Edge sizes
│   └── resources/
│       └── icon.svg          # Widget icon
├── docs/                     # OAuth Setup Page
│   ├── index.html            # Setup wizard (open in browser)
│   ├── callback.html         # OAuth callback handler
│   └── icon.ico              # Page icon
└── README.md
```

## Technical Details

- **Authentication**: Spotify OAuth 2.0 with PKCE (no client secret needed)
- **API**: Direct calls to `api.spotify.com/v1` from the widget using `fetch()`
- **Token Management**: Refresh tokens are exchanged for access tokens client-side
- **Polling**: Widget polls the Spotify API at the configured interval
- **All data stays local** – no external services other than Spotify's API

## Supported Devices

- Corsair Xeneon Edge (Medium and Large sizes)
- Other iCUE dashboard LCDs may work but are not officially tested

## License

MIT