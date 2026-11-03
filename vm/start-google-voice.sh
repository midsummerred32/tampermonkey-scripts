#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HOME:-}" ]]; then
    echo "HOME is not set; start this launcher from the VM desktop user session." >&2
    exit 1
fi

browser=""
for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
        browser="$(command -v "$candidate")"
        break
    fi
done

if [[ -z "$browser" ]]; then
    echo "Could not find Google Chrome or Chromium. Install a supported browser first." >&2
    exit 1
fi

profile_dir="${HOME}/.local/share/niis-google-voice/chrome-profile"
mkdir -p "$profile_dir"
chmod 700 "$(dirname "$profile_dir")" "$profile_dir"

exec "$browser" \
    --user-data-dir="$profile_dir" \
    --new-window \
    "https://voice.google.com/"
