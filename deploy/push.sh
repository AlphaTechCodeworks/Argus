#!/usr/bin/env bash
# Pushes the current code to another machine and (re)starts it there, over SSH (key login).
#   deploy/push.sh                          test PC: Ubuntu in WSL on 192.168.3.147 (test install, sign-in off)
#   deploy/push.sh --code-only              ... only the app code (and bin/linux/libp2pserial.so), laid over a
#                                           copy of the release already installed there (no Docker needed
#                                           on this PC; refused if package.json changed, as the npm
#                                           packages would differ)
#   deploy/push.sh --data                   ... and on the first install copy this PC's NVR list (data/nvrs.json)
#   deploy/push.sh --linux user@server      a Linux server (runs the installer with sudo; normal sign-in)
# Each push installs a new release next to the previous ones (the last 3 are kept); see deploy/install-ubuntu.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
target=wsl
host="admin@192.168.3.147"
distro="Ubuntu"
with_data=0
code_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data) with_data=1 ;;
    --code-only) code_only=1 ;;
    --linux) target=linux; host="$2"; shift ;;
    --host) host="$2"; shift ;;
    --distro) distro="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR)
# Windows' own OpenSSH (Microsoft-signed) when present: Windows application control can block
# Git's unsigned scp/ssh (seen 2026-09-23). It gets local paths in Windows form.
if [ -x /c/Windows/System32/OpenSSH/scp.exe ]; then
  scp() { MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/scp.exe "$@"; }
  ssh() { MSYS_NO_PATHCONV=1 /c/Windows/System32/OpenSSH/ssh.exe "$@"; }
fi
local_path() { command -v cygpath >/dev/null && cygpath -m "$1" || echo "$1"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ "$code_only" = 1 ]; then
  release="$(date -u +%Y%m%d-%H%M%S)"
  echo "== packing the app code (no Docker)" >&2
  echo "$release" > "$work/RELEASE"
  bundle="$work/cctv-code-$release.tar"
  # with the plain-serial add-on (logins by serial number, see cctv/sdk.mjs): it is the app's own
  # library, not the vendor SDK's, and a release installed before it came has no copy of it
  tar -cf "$bundle" -C "$root" --exclude=cctv/test cctv deploy package.json VERSION bin/linux/libp2pserial.so -C "$work" RELEASE
else
  echo "== building the release" >&2
  bundle="$(bash "$root/deploy/bundle.sh")"
fi
name="$(basename "$bundle")"

if [ "$target" = wsl ]; then
  # files go to the admin user's own temp folder (private to that account), reached from WSL via /mnt/c
  win_tmp="C:/Users/${host%%@*}/AppData/Local/Temp"
  wsl_tmp="/mnt/c/Users/${host%%@*}/AppData/Local/Temp"
  step="$work/cctv-push.sh"
  if [ "$code_only" = 1 ]; then
    cat > "$step" <<EOF
set -euo pipefail
cur="\$(readlink -f /opt/cctv/current)"
new=/tmp/cctv-release/cctv-$release
rm -rf /tmp/cctv-release && mkdir -p /tmp/cctv-release
cp -a "\$cur" "\$new"
rm -rf "\$new/cctv" "\$new/deploy"
tar -xf "$wsl_tmp/$name" -C "\$new"
cleanup() { rm -rf /tmp/cctv-release "$wsl_tmp/$name" "$wsl_tmp/cctv-push.sh"; }
if ! cmp -s "\$new/package.json" "\$cur/package.json"; then
  echo "package.json changed since the installed release: the npm packages may differ. Run a full push (without --code-only)." >&2
  cleanup
  exit 3
fi
echo "code $release over \$(cat "\$cur/RELEASE" 2>/dev/null || basename "\$cur")'s packages"
status=0
bash "\$new/deploy/install-ubuntu.sh" --test || status=\$?
cleanup
exit \$status
EOF
  else
    cat > "$step" <<EOF
set -euo pipefail
rm -rf /tmp/cctv-release && mkdir -p /tmp/cctv-release
tar -xzf "$wsl_tmp/$name" -C /tmp/cctv-release
opts="--test"
if [ -f "$wsl_tmp/cctv-seed/nvrs.json" ]; then opts="\$opts --data $wsl_tmp/cctv-seed"; fi
status=0
bash /tmp/cctv-release/*/deploy/install-ubuntu.sh \$opts || status=\$?
rm -rf /tmp/cctv-release "$wsl_tmp/$name" "$wsl_tmp/cctv-seed" "$wsl_tmp/cctv-push.sh"
exit \$status
EOF
  fi
  echo "== copying to $host" >&2
  scp -q "${ssh_opts[@]}" "$(local_path "$bundle")" "$host:$win_tmp/$name"
  scp -q "${ssh_opts[@]}" "$(local_path "$step")" "$host:$win_tmp/cctv-push.sh"
  if [ "$with_data" = 1 ]; then
    ssh "${ssh_opts[@]}" "$host" "mkdir \"$win_tmp/cctv-seed\" 2>nul & exit 0"
    scp -q "${ssh_opts[@]}" "$(local_path "$root/data/nvrs.json")" "$host:$win_tmp/cctv-seed/nvrs.json"
  fi
  echo "== installing in WSL ($distro)" >&2
  ssh "${ssh_opts[@]}" "$host" wsl -d "$distro" -u root -- bash "$wsl_tmp/cctv-push.sh"
else
  echo "== copying to $host" >&2
  scp -q "${ssh_opts[@]}" "$(local_path "$bundle")" "$host:/tmp/$name"
  echo "== installing" >&2
  if [ "$code_only" = 1 ]; then
    # The same overlay the test PC gets: the new app code laid over the packages and the compiled
    # SDK bindings of the release already installed there. Those come out of the Docker build, and
    # a change that touches neither has no business needing Docker running on this PC to reach the
    # server. package.json is compared because a new dependency would not be installed by this
    # route, and the app would start without it.
    ssh -t "${ssh_opts[@]}" "$host" "set -e
cur=\"\$(readlink -f /opt/cctv/current)\"
new=/tmp/cctv-release/cctv-$release
rm -rf /tmp/cctv-release && mkdir -p /tmp/cctv-release
sudo cp -a \"\$cur\" \"\$new\"
sudo rm -rf \"\$new/cctv\" \"\$new/deploy\"
sudo tar -xf /tmp/$name -C \"\$new\"
if ! cmp -s \"\$new/package.json\" \"\$cur/package.json\"; then
  echo 'package.json changed since the installed release: the npm packages would differ. Run a full push (without --code-only).' >&2
  sudo rm -rf /tmp/cctv-release; rm -f /tmp/$name; exit 3
fi
echo \"code $release over \$(cat \"\$cur/RELEASE\" 2>/dev/null || basename \"\$cur\")'s packages\"
status=0
sudo bash \"\$new/deploy/install-ubuntu.sh\" || status=\$?
sudo rm -rf /tmp/cctv-release; rm -f /tmp/$name
exit \$status"
  else
    ssh -t "${ssh_opts[@]}" "$host" "set -e; rm -rf /tmp/cctv-release && mkdir -p /tmp/cctv-release && tar -xzf /tmp/$name -C /tmp/cctv-release && sudo bash /tmp/cctv-release/*/deploy/install-ubuntu.sh; rm -rf /tmp/cctv-release /tmp/$name"
  fi
fi
