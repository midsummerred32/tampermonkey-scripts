# Run the Google Voice reply monitor on an Ubuntu VM

This project is a Tampermonkey userscript, not a standalone service. It reads
Google Voice conversations from the signed-in browser, asks Ollama to assess
incoming messages and draft replies, and sends drafts to Telegram. A message is
sent only after you press **Approve & Send** in Telegram. A Python replacement
would still need a signed-in browser because Google Voice does not provide a
supported public SMS API for this workflow.

The monitor scans for unread conversations about once per minute and inspects
up to five per scan. It opens unread conversations while inspecting them. It
does not scan while the Google Voice tab is hidden, so keep that tab selected
and the VM's desktop session running. These constraints are intentional; this
is not a headless or boot-before-login service.

## Set up the VM

1. Use an Ubuntu VM with a desktop session you can access through its console or
   remote desktop. Install Google Chrome or Chromium, then install the
   Tampermonkey browser extension.
2. From the VM's desktop session, run `vm/start-google-voice.sh` from this
   repository. The launcher creates a dedicated browser profile at
   `~/.local/share/niis-google-voice/chrome-profile`; install Tampermonkey in
   this profile and install this repository's `.user.js` script.
3. Sign into Google Voice in that profile. Keep the profile dedicated to this
   monitor, and do not start another browser using the same profile.
4. Configure and validate Telegram and Ollama in **Script Settings**. Run
   Ollama on the VM or use a trusted private-network endpoint; do not expose
   Ollama to the public internet. The browser profile stores the Google session
   and userscript settings, including the Telegram bot token, so protect the VM
   and its disk.
5. On Google Voice, enable **Telegram Reply Monitor** and confirm the button
   shows **ON**. This enabled state persists in the userscript profile and is
   restored when Google Voice is opened again. New drafts are sent to the
   configured Telegram chat; no message is sent if you reject or do not approve
   it. Approval requests expire after five minutes.

## Launch it when the desktop session starts

After confirming the launcher works, create
`~/.config/autostart/niis-google-voice.desktop` with the following content.
Replace `/absolute/path/to/tampermonkey-scripts` with this repository's actual
location on the VM:

```ini
[Desktop Entry]
Type=Application
Name=NIIS Google Voice Monitor
Exec=/bin/bash /absolute/path/to/tampermonkey-scripts/vm/start-google-voice.sh
Terminal=false
```

This starts the browser when the VM user's desktop session starts. Sign into
the desktop after a reboot, and leave the session running when disconnecting
from remote desktop; do not log out or let the VM sleep. Keep the Google Voice
tab selected and visible. If Google requires reauthentication, sign in again
before relying on the monitor.

## Verify operation

- Confirm the Google Voice tab is open, the monitor button says **ON**, and
  its status changes to **up to date** after a scan.
- Send a benign incoming test message to the Google Voice number. Confirm a
  Telegram draft appears and verify both recipient and text before approving.
- Confirm an unapproved or rejected draft is not sent. Use the browser console
  and Telegram notices to diagnose scan or connection errors.
