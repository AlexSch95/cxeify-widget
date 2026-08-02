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

1. Visit the [Setup Page](https://alexsch95.github.io/cxeify-widget/)
2. Read the privacy notice and click **"I Understand"**
3. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in
4. Click **"Create App"**:
   - App name: `Cxeify`
   - App description: `iCUE Widget for Xeneon Edge`
   - Add the Redirect URI from the Setup Page
   - APIs used: ✅ **Web API**
5. Click **"Save"**
7. Copy your **Client ID** from the app dashboard and paste it into the setup page
8. Click **"Authorize with Spotify"** and log in – you will be redirected back with your credentials
9. Copy the generated **Client ID** and **Refresh Token**

### Step 2: Install the Widget

1. Open iCUE and navigate to your Xeneon Edge settings
2. Select the **Cxeify** widget from the widget picker
3. Paste Client ID and Refresh Token
4. Make sure Spotify is running on any Device and Music is playing
5. The Widget should now display your Spotify Controller

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
├── docs/                     # Landing & Setup Pages
│   ├── index.html            # Landing page (open in browser)
│   ├── setup.html            # OAuth setup wizard
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

- Corsair Xeneon Edge (Medium Widget Size)
- Other iCUE dashboard LCDs may work but are not officially tested

## License

MIT

Made by Machinezr
