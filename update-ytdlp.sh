#!/usr/bin/env bash
# Keep yt-dlp current — YouTube changes often break older versions (HTTP 403 on
# downloads). Downloads the latest release binary directly (the built-in `-U`
# hits GitHub API rate limits on the shared WARP IP). Replaces the binary
# atomically; the bot picks it up on the next download, so no restart needed.
set -uo pipefail
BIN="$HOME/bin/yt-dlp"
URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
TMP="$(mktemp "$HOME/bin/.ytdlp.XXXXXX")" || exit 1
trap 'rm -f "$TMP"' EXIT

echo "[yt-dlp-update] $(date -Is) fetching latest…"
if ! curl -fsSL -o "$TMP" "$URL"; then echo "[yt-dlp-update] download failed"; exit 1; fi
chmod +x "$TMP"

NEW="$(python3 "$TMP" --version 2>/dev/null)"
if [ -z "$NEW" ]; then echo "[yt-dlp-update] downloaded file isn't runnable — aborting"; exit 1; fi
CUR="$("$BIN" --version 2>/dev/null || echo none)"
if [ "$NEW" = "$CUR" ]; then echo "[yt-dlp-update] already up to date ($CUR)"; exit 0; fi

cp -f "$BIN" "$BIN.bak" 2>/dev/null || true
mv -f "$TMP" "$BIN" && chmod +x "$BIN"
trap - EXIT
echo "[yt-dlp-update] updated $CUR → $NEW"
