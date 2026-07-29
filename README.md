# Music67 Discord Music Bot

Discord music bot (prefix `67`) with voice playback, web dashboard, Spotify support, and yt-dlp sources.

## Setup

1. Install Node.js 22+
2. Copy `.env.example` → `.env` and fill in tokens
3. Ensure `yt-dlp` and `ffmpeg` paths in `.env` are correct
4. `npm install`
5. `npm start` (or `./start.sh`)

## Notes

- Secrets live only in `.env` (never committed)
- Runtime data (`history.json`, `cache/`, etc.) is gitignored
