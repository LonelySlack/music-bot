#!/bin/bash
# Runs a Cloudflare quick-tunnel to the local dashboard and records the assigned
# public https URL to tunnel-url.txt so the bot's `67 link` can hand it out.
URLFILE=/home/lonelyslack/music-bot/tunnel-url.txt
: > "$URLFILE"
cloudflared tunnel --no-autoupdate --url http://localhost:3000 2>&1 | while IFS= read -r line; do
  echo "$line"
  u=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' | head -1)
  if [ -n "$u" ]; then printf '%s\n' "$u" > "$URLFILE"; fi
done
