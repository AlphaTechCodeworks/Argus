#!/usr/bin/env bash
# Installs the RTSP server Argus uses for camera links (cctv/rtsp.mjs): MediaMTX, MIT licence,
# https://github.com/bluenviron/mediamtx. A PINNED release for linux amd64, checked against its
# SHA-256 before anything is unpacked. Not part of the app or the repo: run once per machine, as root
# (or with sudo), and again only to change the version below.
#
#   sudo bash deploy/install-mediamtx.sh            installs /opt/cctv/mediamtx/<version>/mediamtx
#                                                   and points /opt/cctv/mediamtx/mediamtx at it
#
# It lives outside the releases, so every release (and a pages-only one) finds it at the same place,
# and the service (DynamicUser, ProtectSystem=strict) can run it but not change it. Argus starts it
# itself once camera links are switched on in Settings; nothing else is needed. To remove it:
# switch camera links off, then rm -rf /opt/cctv/mediamtx.
#
# To move to another version: change VERSION and SHA256 (from the release's checksums.sha256, the
# line for mediamtx_<version>_linux_amd64.tar.gz), and MEDIAMTX_VERSION in cctv/rtsp-server.mjs;
# check the config keys rtsp-core.mjs buildConfig writes still exist in that version.
set -euo pipefail
VERSION=v1.21.1
SHA256=653abc672a3e693f8d3b2717752492fdcfb8072291ec108d03d3dd857411b0ee
FILE="mediamtx_${VERSION}_linux_amd64.tar.gz"
URL="https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/${FILE}"
DEST=/opt/cctv/mediamtx

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "this installs the linux amd64 build; this machine is $(uname -m)"; exit 1; }
if [ -x "$DEST/$VERSION/mediamtx" ]; then
  echo "MediaMTX $VERSION is already installed at $DEST/$VERSION"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  echo "downloading $URL"
  curl -fsSL --retry 3 -o "$work/$FILE" "$URL"
  echo "$SHA256  $work/$FILE" | sha256sum -c --quiet || { echo "CHECKSUM MISMATCH: not installed"; exit 1; }
  mkdir -p "$work/x"
  tar -xzf "$work/$FILE" -C "$work/x" mediamtx LICENSE
  install -d -m 755 -o root -g root "$DEST/$VERSION"
  install -m 755 -o root -g root "$work/x/mediamtx" "$DEST/$VERSION/mediamtx"
  install -m 644 -o root -g root "$work/x/LICENSE" "$DEST/$VERSION/LICENSE"
  echo "installed $DEST/$VERSION/mediamtx"
fi
ln -sfn "$DEST/$VERSION/mediamtx" "$DEST/mediamtx.new" && mv -T "$DEST/mediamtx.new" "$DEST/mediamtx"
"$DEST/mediamtx" --version 2>/dev/null || true
command -v ffmpeg >/dev/null || echo "WARNING: ffmpeg is not on the PATH: camera links need it (apt install ffmpeg)"
echo "done: switch on Settings > Camera links. RTSP listens on 8554 (TCP and UDP) and RTP/RTCP on UDP 8000-8001."
