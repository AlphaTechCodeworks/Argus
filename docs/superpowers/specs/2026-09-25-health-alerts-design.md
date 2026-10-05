# Health alerts — design

Date: 2026-09-25. Status: approved in chat (approach A), awaiting spec review.

## Goal

Tell the owner, quickly and without noise, when the CCTV server stops doing its job: the server or
its PC is down, the recording drive is missing or full, a camera that should record is not, a camera
or NVR is offline, or an NVR refuses streams or rejects the login. On 2026-09-25 the server was down
~10 min (PC restart, keep-alive disabled) and nobody was told; this must be caught.

## Approach

Two watchers, because a server that is down cannot report itself:

1. **In-app** (`cctv/health.mjs`): evaluates checks every 30 s from state the server already has,
   raises/clears alerts, delivers them, serves the Health page.
2. **Outside** (added to `C:\ProgramData\cctv-test\cctv-keepalive.ps1` on the test PC's Windows
   side): every minute polls `http://127.0.0.1:8080/healthz`; alerts when there is no answer for
   3 min, Ubuntu is not running, or the drive is not attached; "OK again" when it recovers. Also
   alerts once after a Windows boot ("test PC restarted at HH:MM").

## Checks (in-app)

| Id | Condition | Raised after | Grouping key |
|---|---|---|---|
| `server-restart` | process started and previous run ended by crash/watchdog (`restarts.json`, `last-hang.json`) | at start (one-shot, no clear) | — |
| `drive-missing` | a storage location with recording on is not mounted / not writable | 2 min | location |
| `drive-full` | free space < `storage.lowFreePct` (default 15 %, i.e. 85 % used) | 2 min | location |
| `not-recording` | camera with mode ≠ off, camera online, no segment written for 5 min | 5 min | NVR |
| `camera-offline` | camera offline (poll state) | 2 min | NVR |
| `nvr-offline` | NVR worker not online | 2 min | NVR |
| `nvr-refusing` | ≥ 3 "refused by the NVR" for that NVR within 10 min | immediate on 3rd | NVR |
| `nvr-login` | wrong password / locked out | immediate | NVR |

Rules:
- An alert **opens** once when its condition has held for the "raised after" time, and **clears**
  once ("OK again") when the condition has been false for 1 min. No repeats while open.
- Alerts with the same kind and grouping key raised in the same 30 s evaluation are sent as one
  message ("nvr-2: 6 cameras offline — Front Gate, Yard, …"). Cameras of an offline NVR are
  folded into the `nvr-offline` alert, not sent separately.
- `not-recording` is not raised while its camera is offline or its NVR is offline/refusing (those
  alerts already explain it) or while its drive is missing.
- For the first 3 min after start no alert is raised except `server-restart` (let streams start).

## Delivery

- **ntfy**: POST to `https://ntfy.sh/<topic>` (or a configured server URL), title + body, priority
  high for open, default for clear. Topic is a random string generated in Settings.
- **Email**: SMTP (host, port, TLS, user, password, from, to list) typed by the owner in Settings.
  Sent with a minimal SMTP client (node `net`/`tls`, AUTH LOGIN/PLAIN, STARTTLS); no new dependency
  unless the minimal client proves insufficient (then `nodemailer`).
- Each method has **Test** in Settings. A failed send is retried 3 times over 5 min, then logged and
  shown on the Health page ("email failing: …"); it never blocks checks.
- Secrets (SMTP password) stored in `/var/lib/cctv/settings.json` (mode 0600) and never returned
  by the settings API (write-only field; the page shows "set").
- Per-kind mute toggles; everything on by default once a method is configured.

## Outside watcher

- The server writes `/var/lib/cctv/alert-targets.json` (ntfy URL+topic, and email settings) when
  alert settings change; the keep-alive reads it via `wsl -u root cat` and caches it on the Windows
  side (`C:\ProgramData\cctv-test\alert-targets.json`, ACL Admin+SYSTEM only) so it still works
  when Ubuntu is down.
- Sends ntfy with `Invoke-RestMethod`, email with `Send-MailMessage`-free SMTP (.NET `SmtpClient`).
- Same open/clear discipline; state kept in memory plus a small state file so a watcher restart does
  not re-send.
- Honors the OFF button: while the keep-alive task is disabled nothing runs (OFF is deliberate). The
  ON/OFF scripts send "turned off/on by the desktop button" so an OFF is visible.

## Web

- **Health page** (`public/health.html`, admin + viewers read-only): server (uptime, last restart
  reason, memory), drives (mounted, % used, days kept), each NVR (online, login, refusals last hour),
  each camera (online, recording, last segment age) as green/amber/red; alert history of the last
  7 days (open/clear times).
- **Banner** on every page while any alert is open (red, links to Health).
- **Settings → Alerts**: ntfy topic/server + Test, email fields + Test, per-kind toggles,
  "not-recording" minutes (default 5).
- API: `GET /api/health` (status + open alerts + history), `POST /api/admin/alerts/test`
  (`{method}`), settings via the existing settings API.

## Storage of alert history

`data/alerts.jsonl`, one line per open/clear event, pruned to 30 days by housekeeping.

## Testing

- Unit (`test/health.test.mjs`): raise delays, clear delay, no repeats, grouping, suppression
  (offline suppresses not-recording; NVR offline folds cameras), start grace, refusal counting
  window, secret not returned by settings API.
- Unit (`test/smtp.test.mjs`): SMTP client against a local fake server (plain, STARTTLS, auth fail).
- Live on the test server: set one camera's mode to continuous while blocking its writes (stop
  its stream) → ntfy message within 5–6 min, "OK again" after restoring; Test buttons deliver;
  outside watcher: `systemctl stop cctv` → alert after 3 min, start → OK again.

## Out of scope

SMS/WhatsApp/Telegram, per-user alert subscriptions, escalation, quiet hours (can be added later).
