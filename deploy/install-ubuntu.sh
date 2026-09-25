#!/usr/bin/env bash
# Installs (or updates) the CCTV VMS natively on Ubuntu 22.04/24.04 x86-64 (also inside WSL).
# Run as root from an unpacked release (made by deploy/bundle.sh):
#   bash deploy/install-ubuntu.sh [--test] [--data DIR]
#     --test      test install: sign-in off (CCTV_AUTH=off); only for machines reachable from trusted PCs
#     --data DIR  first install only: copy the NVR list etc. from DIR into /var/lib/cctv
# Layout: /opt/cctv/releases/<release>/ (last 3 kept), /opt/cctv/current -> the active one,
#         /var/lib/cctv (data), /etc/cctv/cctv.env (settings), systemd service "cctv" (no root, no
#         sudo); the root disk helper: cctv-disk-helper.socket/.service, group cctv-disk.
set -euo pipefail

NODE_MAJOR=24
here="$(cd "$(dirname "$0")/.." && pwd)" # the unpacked release
test_mode=0
data_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test) test_mode=1 ;;
    --data) data_dir="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$here/cctv/server.mjs" ] || { echo "not an unpacked release: $here" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

say "system packages (openssl: HTTPS certificate; ffmpeg: motion search decoding; xfsprogs, gdisk: preparing a USB drive; cifs-utils, nfs-common: network drives)"
need=()
for p in ca-certificates curl xz-utils openssl ffmpeg xfsprogs gdisk cifs-utils nfs-common; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}"
fi

say "Node.js $NODE_MAJOR"
if ! /usr/local/bin/node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(printf '%s\n' "$sums" | awk '/linux-x64\.tar\.xz$/ { print $2 }')"
  [ -n "$file" ] || { echo "no Node.js $NODE_MAJOR build found at $base" >&2; exit 1; }
  curl -fsSLo "/tmp/$file" "$base/$file"
  (cd /tmp && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c -) # verify before installing
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "/tmp/$file" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -f "/tmp/$file"
fi
/usr/local/bin/node -v

say "npm packages"
# A release built by deploy/bundle.sh already carries node_modules and build/. Installing straight
# from a git checkout (which is how this is done now that the Docker image is gone) carries
# neither: build/ holds the compiled SDK struct definitions and is a build artifact, so it is not
# in git. Fetch and compile here when they are missing.
command -v npm >/dev/null 2>&1 || ln -sf /opt/node/bin/npm /usr/local/bin/npm
npm=/usr/local/bin/npm
if [ -d "$here/node_modules/koffi" ] && [ -d "$here/build/lib" ]; then
  echo "bundled with the release"
elif [ -d "$here/build/lib" ]; then
  # runtime packages only; koffi ships a prebuilt Linux x86-64 binary, so nothing is compiled
  (cd "$here" && "$npm" install --omit=dev --no-audit --no-fund --loglevel=error)
else
  # the SDK structs have to be compiled, which needs the dev tools; they are removed again after
  echo "compiling the SDK struct definitions"
  (cd "$here" && "$npm" install --no-audit --no-fund --loglevel=error && "$npm" run build --loglevel=error && "$npm" prune --omit=dev --no-audit --no-fund --loglevel=error)
fi
[ -d "$here/node_modules/koffi" ] || { echo "npm install did not produce koffi; the app cannot talk to the NVRs" >&2; exit 1; }
[ -d "$here/build/lib" ] || { echo "the SDK struct definitions were not built (build/lib is missing)" >&2; exit 1; }

say "app files"
release="$(cat "$here/RELEASE" 2>/dev/null || date -u +%Y%m%d-%H%M%S)"
dest="/opt/cctv/releases/$release"
mkdir -p /opt/cctv/releases
rm -rf "$dest"
cp -a "$here" "$dest"
chown -R root:root "$dest"
chmod -R go-w "$dest"
ln -sfn "$dest" /opt/cctv/current.new && mv -T /opt/cctv/current.new /opt/cctv/current
# keep the three newest releases (rollback: point /opt/cctv/current at an older one and restart)
ls -1dt /opt/cctv/releases/*/ | tail -n +4 | xargs -r rm -rf
echo "active: $dest"

say "settings (/etc/cctv/cctv.env)"
mkdir -p /etc/cctv
if [ ! -f /etc/cctv/cctv.env ]; then
  ip4="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.' | head -1 || true)"
  {
    echo "# CCTV settings. Restart after changes: systemctl restart cctv"
    echo "# names/addresses for the HTTPS certificate (other PCs open https://<this address>:8443)"
    echo "CERT_HOSTS=${ip4}"
    echo "# on a Linux host the app runs the TVT network search itself: no helper"
    echo "DISCOVERY_HELPER_URL="
    if [ "$test_mode" = 1 ]; then
      echo "# TEST INSTALL: sign-in is off. Only for machines reachable from trusted PCs."
      echo "CCTV_AUTH=off"
    fi
  } > /etc/cctv/cctv.env
  chmod 600 /etc/cctv/cctv.env
fi
cat /etc/cctv/cctv.env

say "data (/var/lib/cctv)"
install -d -m 700 /var/lib/private
if [ -n "$data_dir" ] && [ ! -e /var/lib/private/cctv/nvrs.json ] && [ ! -e /var/lib/cctv/nvrs.json ]; then
  install -d -m 700 /var/lib/private/cctv
  cp -a "$data_dir"/. /var/lib/private/cctv/
  # copies from a Windows drive (/mnt/c) arrive world-readable: this folder holds NVR passwords
  chmod -R u=rwX,go= /var/lib/private/cctv
  # the service runs as a dynamic user: files must belong to it (systemd sets the folder owner)
  if [ "$(stat -c %u /var/lib/private/cctv)" != 0 ]; then chown -R --reference=/var/lib/private/cctv /var/lib/private/cctv; fi
  echo "copied first data from $data_dir"
fi

say "disk helper (Settings -> Prepare USB drive)"
# The only root part: a small service on a unix socket that only the cctv service can reach (it
# has the cctv-disk group). It lists drives and prepares one after its own checks and a matching
# serial number (see deploy/cctv-disk-helperd.mjs and deploy/cctv-disk-helper); nothing else.
getent group cctv-disk >/dev/null || groupadd --system cctv-disk
install -m 755 -o root -g root "$dest/deploy/cctv-disk-helper" /usr/local/sbin/cctv-disk-helper
install -d -m 755 -o root -g root /usr/local/lib/cctv
install -m 644 -o root -g root "$dest/deploy/cctv-disk-helperd.mjs" /usr/local/lib/cctv/cctv-disk-helperd.mjs
install -d -m 755 /srv/cctv-rec
# NAS shares (Settings -> Network drive) are mounted under here, one folder per share
install -d -m 755 /srv/cctv-net
# the sudo rule of earlier versions: gone (the service has no sudo at all)
rm -f /etc/sudoers.d/cctv-disk
install -m 644 "$dest/deploy/cctv-disk-helper.socket" /etc/systemd/system/cctv-disk-helper.socket
install -m 644 "$dest/deploy/cctv-disk-helper.service" /etc/systemd/system/cctv-disk-helper.service
systemctl daemon-reload
systemctl enable --now cctv-disk-helper.socket >/dev/null 2>&1 || echo "cctv-disk-helper.socket did not start; Prepare USB drive will not work" >&2
# (a running helper is not restarted: it could be preparing a drive. It exits by itself after a
# minute without requests; the next request starts the new code.)

say "journal size cap"
# the service logs a lot (SDK tracing, NVR outages): cap the system journal instead of the
# default 10% of the disk (up to 4 GB). An admin's own cctv.conf is kept as it is.
jconf=/etc/systemd/journald.conf.d/cctv.conf
if [ ! -e "$jconf" ]; then
  install -d -m 755 /etc/systemd/journald.conf.d
  printf '%s\n' '# written by the CCTV installer (install-ubuntu.sh); edit freely, it is not overwritten' '[Journal]' 'SystemMaxUse=1G' 'SystemMaxFileSize=64M' 'MaxRetentionSec=1month' >"$jconf"
  chmod 644 "$jconf"
  systemctl restart systemd-journald || echo "systemd-journald did not restart; the cap applies after the next boot" >&2
else
  echo "$jconf exists: kept"
fi

say "service"
install -m 644 "$dest/deploy/cctv.service" /etc/systemd/system/cctv.service
systemctl daemon-reload
systemctl enable cctv >/dev/null 2>&1
systemctl restart cctv

say "health check"
for _ in $(seq 1 30); do
  if out="$(curl -fsS http://127.0.0.1:8080/healthz 2>/dev/null)"; then
    echo "$out"
    echo "OK: CCTV $release is running"
    exit 0
  fi
  sleep 2
done
echo "the app did not answer on port 8080; last log lines:" >&2
journalctl -u cctv -n 40 --no-pager >&2 || true
exit 1
