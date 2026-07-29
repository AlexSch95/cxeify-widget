# Cxeify

A Spotify controller widget for **Corsair Xeneon Edge** displays.

## Overview

Cxeify turns your Xeneon Edge into a Spotify remote control. It consists of two parts:

1. **Widget** (`Cxeify/`) – The iCUE HTML widget that runs on your Xeneon Edge display
2. **Companion Server** (`server/`) – A lightweight Node.js server that connects to the Spotify API

## Features

- Real-time playback control: Play, pause, skip, seek
- Volume control directly from your Xeneon Edge
- Shuffle & Repeat mode toggles
- Album art display with blurred background
- Automatically detects active Spotify device
- Touch-optimized for Xeneon Edge displays
- Works with all Xeneon Edge sizes (S/M/L/XL, horizontal & vertical)
- Customizable accent color, text color, background & transparency
- No external services – all data stays local

## Setup

### Prerequisites

- **Corsair iCUE** (v5.45 or newer) with a Xeneon Edge device
- **Node.js** (v18 or newer) for the companion server
- **Spotify Premium** account

### Step 1: Start the Companion Server

```bash
cd server
npm install
npm start
```

You'll see:

```
╔══════════════════════════════════════════════╗
║              🎵 Cxeify Server                ║
║                                              ║
║  Server running on http://127.0.0.1:3000     ║
║                                              ║
║  1. Open http://127.0.0.1:3000 in your       ║
║     browser to start setup                   ║
║  2. Authorize with Spotify                   ║
║  3. Widget connects automatically            ║
║                                              ║
╚══════════════════════════════════════════════╝
```

Open `http://127.0.0.1:3000` in your browser and click **Authorize Spotify** to log in with your Spotify account.

Keep the server running in the background.

### Step 2: Install the Widget

1. Copy the `Cxeify/` folder to your iCUE widgets directory:
   - `%APPDATA%/Corsair/CUE5/widgets/widgets/` (Windows)
2. Open iCUE and navigate to your Xeneon Edge settings
3. Select the **Cxeify** widget from the widget picker
4. The widget will connect to the companion server automatically

### Step 3: Configure (Optional)

In iCUE widget settings you can adjust:

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `http://127.0.0.1:3000` | Address of the companion server |
| Update Interval | 2000 ms | How often to refresh playback status |
| Text Color | `#ffffff` | Color of text |
| Accent Color | `#1DB954` | Spotify green accent |
| Background Color | `#121212` | Background color |
| Background Transparency | 0% | Background transparency level |

## Project Structure

```
├── Cxeify/                  # iCUE HTML Widget
│   ├── index.html           # Main widget HTML + meta properties
│   ├── manifest.json        # Widget manifest
│   ├── translation.json     # UI labels
│   ├── scripts/
│   │   └── main.js          # Widget logic: polling, controls, settings
│   ├── styles/
│   │   └── main.css         # Responsive styling for all Xeneon Edge sizes
│   └── resources/
│       └── icon.svg         # Widget icon
├── server/                  # Companion server (Node.js)
│   ├── package.json
│   └── server.js            # Express API + Spotify PKCE OAuth
└── README.md
```

## Building a Standalone Executable

To create a standalone `.exe` (no Node.js required):

```bash
npm install -g pkg
cd server
pkg server.js --output cxeify-server.exe
```

## Technical Details

- **Authentication**: Spotify OAuth 2.0 with PKCE (no client secret needed)
- **Token Storage**: `tokens.json` in the server directory
- **API**: REST endpoints on `http://127.0.0.1:3000/api/*`
- **Widget Communication**: Polls the server via `fetch()` at the configured interval
- **All data stays local** – no external services other than Spotify's API

## License

MIT