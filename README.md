# Argus

Argus is a self-hosted CCTV system for TVT recorders (NVRs): one web app to watch live, play back,
record and manage cameras across many NVRs and many sites, in any modern browser, with no plugin.

It began as a fork of [2BAD/tvt](https://github.com/2BAD/tvt), a TypeScript SDK for TVT devices,
and has since grown into a complete application of its own. The SDK is still here, in `source/`
(see [docs/SDK.md](docs/SDK.md)); the application is everything in `cctv/` and `deploy/`.

## What it does

**Watching**

- Live grids from one camera to a wall of them, drag to arrange, saved views per user
- Sub-streams in the grid, the camera's main stream at full size
- Plays H.265 and H.264 in the browser itself; for a PC whose browser cannot play H.265 the server
  converts the picture to H.264, so the cameras can stay on H.265
- A lighter stream for phones and for viewers coming in over the internet
- Maps with cameras placed on them

**Playback**

- Playback straight from the NVR's own disks, or from recordings Argus keeps itself
- A timeline with motion and events, frame step, speeds up to 16x
- "Many cameras": several cameras played back together on one clock
- Bookmarks, and clips exported as MP4 with a signature that shows they have not been altered

**Recording and events**

- Argus's own recording to local disks, USB drives and network shares, with retention rules
- Backfill from the NVR for any time the server was not recording
- Alarms and events from the NVRs (motion, line crossing and others), each with a snapshot, with
  rules for who is told and when

**Managing**

- Many NVRs across many sites, found on the network or added by address or by serial number
- Camera settings from the app: stream resolution, codec and bit rate, on-screen text, picture
- Health: every NVR, camera, disk and conversion at a glance, and who is watching what
- Users with per-camera rights for live, playback and export; an audit log of what was done

## Reaching NVRs

| How | When to use it |
|---|---|
| By address | The NVR is on the server's network, or reachable through a VPN |
| By serial number (P2P) | The NVR is somewhere else, behind a router that cannot be changed |
| Site connector | A whole remote site, through a small gateway that dials out to the server |

**P2P by serial number** is the part that did not exist anywhere. TVT's recorders reach their cloud
through an undocumented protocol that the vendor's own Linux SDK does not get right. Argus
implements it from a study of the protocol as it appears on the wire: the direct route (NAT 2.0)
and the relayed one (NAT 1.0). An NVR is added by the serial number printed on it, with no port
forward and no change at the site.

The site connector is described in [deploy/vpn/README.md](deploy/vpn/README.md).

## How it is built

- Node.js 24, plain ES modules, SQLite from Node's own `node:sqlite`. The web pages are plain
  JavaScript: there is no build step for the application.
- TVT's device SDK (a native library) is called through [koffi](https://koffi.dev). Each NVR has
  its own worker process, so a recorder that misbehaves cannot take the others down.
- Video goes to the browser over WebSockets and is decoded there with WebCodecs.
- ffmpeg is used only where a picture has to be decoded on the server: motion search, the phone
  stream and the H.264 conversion.

| Folder | What is in it |
|---|---|
| `cctv/` | The application: the server, and `cctv/public/` for the pages |
| `cctv/test/` | Its tests; each is a plain script, `node cctv/test/<name>.test.mjs` |
| `deploy/` | Install and update scripts for Ubuntu, the systemd units, the site connector |
| `source/` | The device SDK this project started from (TypeScript) |
| `bin/`, `native/` | TVT's native libraries and the glue for them |
| `docs/` | TVT's SDK manual, and design notes |

## Running it

Argus runs on Linux (Ubuntu 24.04 is what it is used on), x86-64, with Node.js 24.

```bash
# on the machine it will run on, as root: installs Node, ffmpeg and the service
bash deploy/install-ubuntu.sh

# the first account
node cctv/adduser.mjs <name> --admin
```

Then open `http://<server>:8080`, or `https://<server>:8443`, sign in, and add the first NVR under
Sites. Later versions are sent to a running server with `deploy/push.sh`, which checks that the
NVRs come back afterwards and returns to the previous version by itself if they do not.

A `Dockerfile` and `docker-compose.yml` are included for running it in a container instead.

## Tests

```bash
node cctv/test/<name>.test.mjs
```

Most tests load the native library and so run on Linux only. Every pull request runs all of them
(`.github/workflows/cctv-tests.yml`).

## Credits and licence

MIT, see [LICENSE](LICENSE).

The device SDK in `source/` is the work of [2BAD](https://github.com/2BAD) (Jason Hyde), whose
project this was forked from. The application, the P2P implementation and everything else under
`cctv/` and `deploy/` are by AlphaTech Codeworks.

TVT's native libraries and manuals in `bin/` and `docs/` belong to TVT. This project is not
affiliated with or endorsed by TVT.
