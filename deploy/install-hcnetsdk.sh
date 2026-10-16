#!/usr/bin/env bash
# Installs Hikvision's Device Network SDK (HCNetSDK) for Argus's Hikvision support (cctv/hik-sdk.mjs):
# the PINNED Linux 64-bit V6.1.11.40 (build 2026-09-22), checked against the SHA-256 of its
# libhcnetsdk.so before anything is copied. The SDK is Hikvision's and is not in the repo: download it
# from Hikvision's developer site, copy it to the server, and run this once per machine as root (or
# with sudo), and again only to change the version below.
#
#   sudo bash deploy/install-hcnetsdk.sh <unpacked SDK folder | SDK .zip>
#       copies the SDK's lib/ (libhcnetsdk.so, libHCCore.so, libhpr.so, HCNetSDKCom/ ...) to
#       /opt/cctv/hcnetsdk/<version>/ and points /opt/cctv/hcnetsdk/current at it
#
# The folder can be the SDK's top folder (EN-HCNetSDKV6.1.11.40_build20260922_linux64), its lib/
# folder, or anything with libhcnetsdk.so a few levels down. A .zip is unpacked first (needs unzip).
#
# Like MediaMTX (install-mediamtx.sh) it lives outside the releases, so every release finds it at the
# same place, and the service (DynamicUser, ProtectSystem=strict) can load it but not change it. Argus
# loads it only in a Hikvision device's own child process, with this folder and its HCNetSDKCom/ on
# that process's library path (cctv/hik-config.mjs hikChildEnv); CCTV_HIKSDK_DIR points elsewhere.
# The SDK's error log goes to DATA_DIR/hiksdk-log/ (errors only; the SDK deletes its oldest files).
# Without it, Hikvision devices say "Hikvision support is not installed on this server" and nothing
# else changes. To remove it: remove the Hikvision devices, then rm -rf /opt/cctv/hcnetsdk.
#
# To move to another version: change VERSION and SHA256 (sha256sum lib/libhcnetsdk.so of the new
# SDK), then check cctv/hik-structs.mjs against the new incEn/HCNetSDK.h (its layouts are checked
# against koffi when the worker starts, but only for the fields it knows about).
set -euo pipefail
VERSION=6.1.11.40
SHA256=1e3b7a1bd7eb8b43b96e2240d6a74d178e73331fe3109f83bcf7059a605f594d
DEST=/opt/cctv/hcnetsdk

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "this installs the Linux 64-bit (x86_64) SDK; this machine is $(uname -m)"; exit 1; }
SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: sudo bash $0 <unpacked SDK folder | SDK .zip>"; exit 1; }
[ -e "$SRC" ] || { echo "$SRC does not exist"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -f "$SRC" ]; then
  case "$SRC" in
    *.zip|*.ZIP) command -v unzip >/dev/null || { echo "unzip is needed for a .zip (apt install unzip), or unpack it first"; exit 1; }
                 unzip -q "$SRC" -d "$work/x"; SRC="$work/x" ;;
    *) echo "$SRC is a file but not a .zip"; exit 1 ;;
  esac
fi

# the folder that holds libhcnetsdk.so (the SDK's lib/)
mapfile -t found < <(find "$SRC" -maxdepth 4 -type f -name libhcnetsdk.so 2>/dev/null)
[ "${#found[@]}" -ge 1 ] || { echo "no libhcnetsdk.so under $SRC: is this the Linux 64-bit HCNetSDK?"; exit 1; }
[ "${#found[@]}" -eq 1 ] || { echo "more than one libhcnetsdk.so under $SRC:"; printf '  %s\n' "${found[@]}"; echo "give the folder of the one to install"; exit 1; }
LIB="$(dirname "${found[0]}")"
echo "$SHA256  ${found[0]}" | sha256sum -c --quiet || { echo "CHECKSUM MISMATCH: ${found[0]} is not the pinned V$VERSION libhcnetsdk.so; not installed"; exit 1; }
[ -d "$LIB/HCNetSDKCom" ] || { echo "$LIB/HCNetSDKCom is missing: the SDK's components must come with it; not installed"; exit 1; }

if [ -f "$DEST/$VERSION/libhcnetsdk.so" ] && echo "$SHA256  $DEST/$VERSION/libhcnetsdk.so" | sha256sum -c --quiet 2>/dev/null; then
  echo "HCNetSDK V$VERSION is already installed at $DEST/$VERSION"
else
  rm -rf "$DEST/$VERSION.new"
  install -d -m 755 -o root -g root "$DEST/$VERSION.new"
  cp -a "$LIB/." "$DEST/$VERSION.new/"
  # Hikvision's licence notices, when the folder has them (the SDK's doc/)
  for f in "$LIB"/../doc/*.txt; do [ -f "$f" ] && install -m 644 -o root -g root "$f" "$DEST/$VERSION.new/" || true; done
  chown -R root:root "$DEST/$VERSION.new"
  find "$DEST/$VERSION.new" -type d -exec chmod 755 {} +
  find "$DEST/$VERSION.new" -type f -exec chmod 644 {} +
  find "$DEST/$VERSION.new" -type f -name '*.so*' -exec chmod 755 {} +
  rm -rf "$DEST/$VERSION"
  mv -T "$DEST/$VERSION.new" "$DEST/$VERSION"
  echo "installed $DEST/$VERSION"
fi
ln -sfn "$DEST/$VERSION" "$DEST/current.new" && mv -T "$DEST/current.new" "$DEST/current"
echo "$DEST/current -> $DEST/$VERSION"
# the libraries it needs from the system (anything "not found" here must be installed first)
missing="$(LD_LIBRARY_PATH="$DEST/current:$DEST/current/HCNetSDKCom" ldd "$DEST/current/libhcnetsdk.so" | grep 'not found' || true)"
if [ -n "$missing" ]; then echo "WARNING: libraries the SDK needs are missing:"; echo "$missing"; fi
echo "done: check it with   node cctv/tools/hik-smoke.mjs 192.0.2.1   (prints the SDK version and a login error; see that file)"
