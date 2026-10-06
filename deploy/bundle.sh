#!/usr/bin/env bash
# Builds a self-contained release, dist/cctv-<release>.tar.gz: the app, the TVT SDK libraries,
# the compiled SDK structs and production npm packages (Linux x86-64). The target needs only
# Node.js, openssl and ffmpeg (deploy/install-ubuntu.sh installs them). Prints the file path.
#   deploy/bundle.sh
# Uses the app's Docker image on this PC (tvt-cctv) as the Linux build environment; nothing is
# downloaded (the image already has every package).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bash "$root/deploy/check-gui.sh"
# the release's scripts run on Linux: CRLF line endings (core.autocrlf=true on this PC) would break
# them. .gitattributes keeps deploy/ at LF; refuse to build if a CR slipped in anyway. (tr, not
# grep: Git for Windows' grep does not match a lone CR reliably.)
crlf=""
while IFS= read -r -d '' f; do
  if [[ $(tr -cd '\r' <"$f" | wc -c) -gt 0 ]]; then crlf+=" ${f#"$root"/}"; fi
done < <(find "$root/deploy" -type f \( -name '*.sh' -o -name '*.py' -o -name '*.service' -o -name '*.socket' -o -name 'cctv-disk-helper' -o -name 'cctv-vpn' \) -print0)
if [[ -n $crlf ]]; then echo "CRLF line endings in:$crlf (convert them to LF first)" >&2; exit 1; fi
release="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$root/dist"
work="$(mktemp -d "$root/dist/.bundle-XXXXXX")"
box="cctv-bundle-$release"
trap 'rm -rf "$work"; docker rm -f "$box" >/dev/null 2>&1 || true' EXIT
stage="$work/cctv-$release"
mkdir -p "$stage"

# production packages and the compiled structs, taken from the image (Linux builds of koffi).
# Copied out with docker cp, not through a shared folder: Docker Desktop's folder sharing can
# hang (seen after its VM crashed), and docker cp goes through the Docker API instead.
host_path() { command -v cygpath >/dev/null && cygpath -m "$1" || echo "$1"; }
docker run --name "$box" --network none tvt-cctv sh -c '
  set -e
  mkdir -p /tmp/p && cp /app/package.json /app/package-lock.json /tmp/p/
  cp -r /app/node_modules /tmp/p/
  cd /tmp/p && npm prune --omit=dev --no-audit --no-fund >/dev/null 2>&1
  cp -r /app/node_modules/ws /tmp/p/node_modules/   # installed outside package.json in the image
' >&2
MSYS_NO_PATHCONV=1 docker cp "$box:/tmp/p/node_modules" "$(host_path "$stage")/node_modules" >&2
MSYS_NO_PATHCONV=1 docker cp "$box:/app/build" "$(host_path "$stage")/build" >&2

cp -r "$root/cctv" "$root/bin" "$root/deploy" "$root/package.json" "$root/VERSION" "$stage/"
# not part of a release: tests, local experiments
rm -rf "$stage/cctv/test"
echo "$release" > "$stage/RELEASE"

out="$root/dist/cctv-$release.tar.gz"
# compressed inside the image, through a pipe: Windows application control can block Git's
# gzip.exe (seen 2026-09-23), and this needs no shared folder either
tar -C "$work" -cf - "cctv-$release" | docker run --rm -i --network none tvt-cctv gzip -6 > "$out"
echo "$(du -h "$out" | cut -f1) $out" >&2
echo "$out"
