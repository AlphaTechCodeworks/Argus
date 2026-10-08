# Argus

**Self-hosted CCTV for TVT recorders.** One web app to watch live, play back, record and manage
every camera on every NVR at every site, in an ordinary browser, with no plugin and no vendor cloud
account.

Argus is for people who run TVT-made NVRs (sold under many names, among them TVT, Provision-ISR and
Eye in Cloud) and have outgrown the recorder's own web page and the vendor's Windows client: more
than one recorder, more than one site, staff who need different levels of access, and a need to
find and hand over footage quickly.

It began as a fork of [2BAD/tvt](https://github.com/2BAD/tvt), a TypeScript SDK for talking to TVT
devices, and has since grown into a complete application: about 77,000 lines of server and page
code and 200 test files. The SDK is still here in `source/` ([docs/SDK.md](docs/SDK.md)); the
application is everything in `cctv/` and `deploy/`.

## Contents

- [What it does](#what-it-does)
- [The pages](#the-pages)
- [Reaching NVRs, and P2P by serial number](#reaching-nvrs)
- [Who may see what](#who-may-see-what)
- [How it is built](#how-it-is-built)
- [What it needs](#what-it-needs)
- [Installing and updating](#installing-and-updating)
- [Settings](#settings)
- [Tests](#tests)
- [Credits and licence](#credits-and-licence)

## What it does

### Live

- Grids from one camera to a wall of them. Drag tiles to arrange them; each user keeps their own
  order and saved views.
- The grid uses each camera's light sub-stream. Opening a camera full size switches to its main
  stream, and the sub-stream stays on screen until the main one has a picture, so nothing goes
  black in between.
- H.265 and H.264 are decoded by the browser itself (WebCodecs), which is what makes a large grid
  possible without loading the server.
- **Old PCs.** Where a browser cannot play H.265, the server converts that camera to H.264 for it,
  once per camera however many old PCs are watching. Cameras can therefore stay on H.265, which
  saves bandwidth and disk space. A converted sub-stream costs about 3 to 4 % of one CPU core.
- **Phones and remote viewers** get a lighter stream sized to the link, with a total bandwidth
  budget for everything leaving the building.
- **It protects the recorder.** An NVR shares one bandwidth budget between serving viewers and
  recording to its own disks. Argus opens streams one at a time, stops a stream the moment its tile
  is off the page or the tab is hidden, shares one stream between every viewer of a camera, and
  backs off when an NVR refuses. A grid of cameras cannot stop a site recording.

### Playback

- Two sources, chosen per camera: the NVR's own disks, or Argus's own recordings.
- A timeline with recording, motion and event lanes; frame step forward and back; speeds up to 16x.
- **Many cameras:** several cameras played back together on one clock, in 2x2 or 3x3, with a
  timeline lane per camera, snapshots, and the whole view exported as one job.
- Bookmarks, made by hand or automatically around events. Bookmarked footage is never thinned by
  housekeeping.

### Evidence export

- Clips are exported as MP4 into an evidence pack: the video, and a signature over every file made
  with the server's Ed25519 key, so anyone can check that nothing has been altered. A pack can be
  protected with a password.
- Each pack carries its own player page, so the person receiving it needs nothing installed.

### Recording

- Argus can keep its own recordings, separately from the NVR's, on local disks, USB drives and
  network shares, with retention rules and thinning of old footage.
- **Backfill:** footage for any time the server was not recording is fetched from the NVR
  afterwards, so the server's copy has no gaps.
- Storage that goes away is noticed and reported; recording carries on to what remains.

### Alarms and events

- Motion, line crossing and the NVR's other alarms are collected from every recorder into one list,
  each with a picture.
- **Line crossing** is set up in Argus: draw up to four lines on the live picture and Argus writes
  them into the camera's own detection through the NVR, reads them back to confirm, and can undo.
- Rules decide which cameras raise an alert, on which days and hours.
- Alerts go to phones through [ntfy](https://ntfy.sh) and to other systems as signed webhooks. An
  alert links straight to the alarm and its footage.

### Managing recorders and cameras

- NVRs are found on the network, or added by address, or by serial number.
- Camera settings without visiting each recorder: resolution, codec and bit rate of main and
  sub-streams (one camera or in bulk), on-screen text, picture and lens settings. Each change is
  logged before it is sent and read back afterwards.
- Reports: every camera with its model, streams and settings, as a file to download.
- NVR clocks are checked, and NVR disks and their health are shown.
- Restart or shut down an NVR, or the server, from the Health page.

### Health

- Every NVR, camera, disk, storage location and conversion at a glance.
- Who is signed in and what each person is watching.
- Alerts when a recorder, camera or disk goes down, held for a few minutes first so a brief blip
  does not page anyone.

## The pages

| Page | What it is for |
|---|---|
| Live | The camera grid and the full-size view |
| Playback | One camera's recordings, timeline, export |
| Many cameras | Several cameras played back together |
| Alarms | Events from every NVR, with pictures and rules |
| Map | Cameras placed on a map |
| Cameras | Camera list, notes and reports |
| Sites | NVRs and sites, stream settings, remote sites |
| Storage | Where Argus records, and how long it keeps footage |
| Health | State of everything, and who is watching |
| Users & audit | Accounts, access rights, and the log of what was done |
| Settings | Alerts and system settings |

## Reaching NVRs

| How | When to use it | What the site needs |
|---|---|---|
| By address | The NVR is on the server's network, or reachable through a VPN | Nothing |
| By serial number (P2P) | The NVR is elsewhere, behind a router you cannot change | Nothing: the NVR's own cloud setting |
| Site connector | A whole remote site with several NVRs | One small gateway that dials out to the server |

### P2P by serial number

TVT recorders keep a connection open to the vendor's cloud so that the vendor's apps can find them
by serial number. The protocol is not documented, and the vendor's Linux SDK does not manage it:
it sends the cloud an MD5 of the serial number where the cloud expects the serial itself, so every
such login fails after twenty seconds.

Argus's P2P support was worked out by studying the protocol as it appears on the wire:

- a small native add-on (`native/p2pserial`), loaded ahead of the vendor library, that puts the
  plain serial number back and leaves the vendor's files untouched;
- the direct route (NAT 2.0), where the cloud introduces the two ends and video then flows
  between them over UDP;
- the relayed route (NAT 1.0), for sites whose router allows nothing else, where video passes
  through the vendor's relay.

The result is that an NVR anywhere is added by typing the serial number printed on it: no port
forward, no VPN, no change at the site. Relayed streams are slower to start, main streams most of
all, and the login queue is arranged so that one unreachable NVR does not hold up the others.

### Site connector

For a whole remote site, a small gateway (a Raspberry Pi, the site's router or a PC) dials out to
the server, so the site needs no port forward and can sit behind 4G. Several sites may use the same
address range. See [deploy/vpn/README.md](deploy/vpn/README.md).

## Who may see what

Access is set per user and per site or camera, and is enforced on the server, not just hidden on
the page.

| Right | What it allows |
|---|---|
| Live | The camera in the grid, on its sub-stream |
| Live HD | The main stream at full size |
| Playback SD | The NVR's recordings |
| Playback HD | Argus's own recordings |
| Export | Taking footage away |

Administrators also manage NVRs, sites, users and settings. Alarms, events and their pictures
follow the same rights: a user never sees an event from a camera they may not watch.

Other protections:

- Passwords are stored as scrypt hashes; sessions are signed cookies that are refused once signed
  out.
- HTTPS with the server's own certificate, or a real certificate per name (for example one from
  Let's Encrypt for a public name and one from Tailscale).
- A strict content security policy: no inline scripts, no framing.
- An audit log of what was done and by whom.

## How it is built

```
 browsers                    Argus server                           recorders
+----------+   HTTPS    +------------------------+   TVT SDK    +--------------+
| Live     | <--------> | main process           | <----------> | NVR (LAN)    |
| Playback |  WebSocket |  web, API, rights,     |              +--------------+
| ...      |   video    |  recording, events     |   P2P / UDP  +--------------+
+----------+            |          |             | <----------> | NVR (remote) |
                        |  one worker per NVR    |              +--------------+
                        |  (live streams)        |
                        |          |             |
                        |  ffmpeg, only where a  |
                        |  picture must be       |
                        |  decoded on the server |
                        +------------------------+
                            SQLite + files on disk
```

- **Node.js 24, plain ES modules.** The database is SQLite through Node's own `node:sqlite`. The
  pages are plain JavaScript modules: the application has no build step and no framework.
- **TVT's device SDK** is a native library, called through [koffi](https://koffi.dev).
- **One worker process per NVR** carries its live streams, so a recorder that misbehaves, or a
  crash inside the vendor library, cannot take the other recorders down.
- **Video reaches the browser over WebSockets** as the camera's own H.264 or H.265, and is decoded
  there. The server does not decode what it passes on.
- **ffmpeg** is used only where the server must decode: motion search, the phone stream, and the
  H.264 conversion for old PCs.

| Folder | What is in it |
|---|---|
| `cctv/` | The application server |
| `cctv/public/` | The pages |
| `cctv/test/` | The tests, each a plain script |
| `deploy/` | Install and update scripts for Ubuntu, the systemd units, the site connector |
| `native/` | Small native add-ons, including the P2P fix |
| `bin/` | TVT's native libraries |
| `source/` | The device SDK this project started from (TypeScript) |
| `docs/` | TVT's SDK manual, the SDK page, and design notes |

## What it needs

- **Server:** Linux on x86-64 (Ubuntu 24.04 is what it runs on), Node.js 24, ffmpeg. No GPU.
- **Disk:** only if Argus keeps its own recordings; otherwise the NVRs' disks are used.
- **Browsers:** a current Chrome or Edge is best. H.265 in the browser needs a PC that can decode
  it; without that, Argus converts to H.264 as described above.
- **NVRs:** TVT-made recorders with the device network port open (6036 by default) for access by
  address, or their cloud setting on for access by serial number.

## Installing and updating

```bash
# on the machine it will run on, as root: installs Node, ffmpeg and the service
bash deploy/install-ubuntu.sh

# the first account
node cctv/adduser.mjs <name> --admin
```

Open `http://<server>:8080` or `https://<server>:8443`, sign in, and add the first NVR under Sites.

Updates are sent from a development machine:

```bash
bash deploy/push.sh --linux <user>@<server> --code-only
```

Each release is kept in its own folder. After switching to the new one the installer waits for the
NVRs to come back online, and returns to the previous release by itself if they do not.

A `Dockerfile` and `docker-compose.yml` are included for running Argus in a container instead.

## Settings

Most settings are in the app. A few are environment variables on the service:

| Variable | What it does |
|---|---|
| `DATA_DIR` | Where Argus keeps its database, settings, certificates and logs |
| `CERT_HOSTS` | Extra names and addresses for the server's own HTTPS certificate |
| `CCTV_P2P` | `off` switches off NVRs by serial number |
| `CCTV_P2P_SERVER` | The cloud server used for logins by serial number, `host:port` |
| `CCTV_H264_FALLBACK_MAX` | Most sub-stream conversions for old PCs at once (24) |
| `CCTV_H264_FALLBACK_CORES` | CPU cores those conversions may use between them (2) |
| `CCTV_WAN_BUDGET_MBPS` | Total bandwidth for viewers outside the building |

Real certificates go in `<DATA_DIR>/certs/named/<any name>/cert.pem` and `key.pem`; the server
answers each name with the certificate that covers it.

## Tests

```bash
node cctv/test/<name>.test.mjs
```

Each test is a plain script that prints PASS or FAIL per check. Most load the native library and
so run on Linux only. Every pull request runs all of them (`.github/workflows/cctv-tests.yml`),
and `master` accepts nothing that has not passed.

## Credits and licence

MIT, see [LICENSE](LICENSE).

The device SDK in `source/` is the work of [2BAD](https://github.com/2BAD) (Jason Hyde), whose
project this was forked from. The application, the P2P implementation and everything else under
`cctv/`, `deploy/` and `native/p2pserial` are by AlphaTech Codeworks.

TVT's native libraries and manuals in `bin/` and `docs/` belong to TVT. This project is not
affiliated with or endorsed by TVT, Provision-ISR or Eye in Cloud.
