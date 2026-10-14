# Installs changed PAGE files as a new release on top of the one running and has the running server
# take it up WITHOUT a restart (page-reload.mjs, SIGHUP to the main process). If the server will not
# (the release changes more than pages), it is restarted as before; if that fails, rolled back.
# Set by the caller (sed): rel, expect, FILES (may be empty: a release that only has a new name).
# Uploaded first: /tmp/pg-rel.tar, /tmp/pg-rel.new.sums, /tmp/pg-rel.old.sums (not needed when FILES is empty).
set -euo pipefail
rel=__REL__
expect=__EXPECT__
FILES="__FILES__"
cur="$(readlink -f /opt/cctv/current)"
dest=/opt/cctv/releases/$rel
[ "$cur" = "$expect" ] || { echo "prod has moved to $cur since I checked: stopping, nothing changed"; exit 9; }
[ ! -e "$dest" ] || { echo "$dest exists: stopping"; exit 9; }
if [ -n "$FILES" ]; then
  (cd "$cur" && sha256sum -c --quiet /tmp/pg-rel.old.sums) || { echo "prod's files changed since I fetched them: stopping, nothing changed"; exit 9; }
  rm -rf /tmp/pg-rel && mkdir /tmp/pg-rel && tar -xf /tmp/pg-rel.tar -C /tmp/pg-rel
  (cd /tmp/pg-rel && sha256sum -c --quiet /tmp/pg-rel.new.sums) || { echo "the upload differs from what was tested: stopping, nothing changed"; exit 9; }
fi
pid_before="$(systemctl show cctv -p MainPID --value)"
streams() { curl -fsS -m 5 http://127.0.0.1:8080/healthz 2>/dev/null | grep -oE '"streams":[0-9]+' | grep -oE '[0-9]+' | head -1; }
online() { curl -fsS -m 5 http://127.0.0.1:8080/healthz 2>/dev/null | grep -oE '"online":[0-9]+' | grep -oE '[0-9]+' | head -1; }
s_before="$(streams || true)"; o_before="$(online || true)"; o_before="${o_before:-0}"
sudo cp -a "$cur" "$dest"
# (-D: a file new to the app may sit in a folder the release does not have yet)
for f in $FILES; do sudo install -D -m 644 -o root -g root "/tmp/pg-rel/$f" "$dest/$f"; done
echo "$rel" | sudo tee "$dest/RELEASE" >/dev/null
sudo ln -sfn "$dest" /opt/cctv/current.new && sudo mv -T /opt/cctv/current.new /opt/cctv/current
stamped() { curl -fsS -m 5 http://127.0.0.1:8080/login.html 2>/dev/null | grep -q "v=$rel"; }
sudo systemctl kill --kill-whom=main -s HUP cctv
taken=""
for _ in $(seq 1 15); do if stamped; then taken=1; break; fi; sleep 1; done
if [ -n "$taken" ] && [ "$(systemctl show cctv -p MainPID --value)" = "$pid_before" ]; then
  echo "$(date -u +%H:%M:%S) $rel taken up WITHOUT a restart (same process $pid_before; streams ${s_before:-?} -> $(streams || echo '?'), NVRs online $o_before -> $(online || echo '?'))"
else
  echo "$(date -u +%H:%M:%S) not taken up without a restart: $(sudo journalctl -u cctv --since '-30 s' --no-pager | grep '\[pages\]' | tail -1 | sed 's/^.*\[pages\]/[pages]/')"
  echo "restarting instead"
  sudo systemctl restart cctv
  rollback() { echo "ROLLING BACK to ${cur##*/}: $1"; sudo ln -sfn "$cur" /opt/cctv/current.new && sudo mv -T /opt/cctv/current.new /opt/cctv/current; sudo systemctl restart cctv; exit 1; }
  ok=""; for _ in $(seq 1 30); do if stamped; then ok=1; break; fi; sleep 2; done
  [ -n "$ok" ] || rollback "the app did not answer with the new release"
  want=$(( (o_before + 1) / 2 )); peak=0
  for _ in $(seq 1 36); do n="$(online || echo 0)"; n="${n:-0}"; [ "$n" -gt "$peak" ] && peak="$n"; [ "$peak" -ge "$want" ] && break; sleep 5; done
  [ "$peak" -ge "$want" ] || rollback "only $peak of $o_before NVRs came back online"
  echo "$(date -u +%H:%M:%S) restarted; online $peak of $o_before"
fi
rm -rf /tmp/pg-rel /tmp/pg-rel.tar /tmp/pg-rel.old.sums /tmp/pg-rel.new.sums
# Old releases go, so the disk does not fill: every install is a whole copy of the app (about 42 MB),
# and on 2026-10-13 29 of them had left 1.2 GB free on an 11 GB disk. Kept: the KEEP newest (by when
# they were made: a copy keeps its files' times, so a name or a file time would mislead), the one
# current points at, the one the running process started from, and the one this install replaced (the
# way back). Anything else under releases/ that is not a directory is left alone.
KEEP=${KEEP:-6}
run_from="$(sudo readlink -f "/proc/$(systemctl show cctv -p MainPID --value)/cwd" 2>/dev/null || true)"
now_at="$(readlink -f /opt/cctv/current)"
gone=0
for d in $(cd /opt/cctv/releases && ls -1tcd -- */ 2>/dev/null | sed 's:/$::' | tail -n +$((KEEP + 1))); do
  p="/opt/cctv/releases/$d"
  case "$run_from" in "$p"|"$p"/*) continue ;; esac
  [ "$p" = "$now_at" ] || [ "$p" = "$cur" ] || [ "$p" = "$dest" ] && continue
  sudo rm -rf -- "$p" && gone=$((gone + 1))
done
[ "$gone" -gt 0 ] && echo "old releases removed: $gone (kept the newest $KEEP, the current, the running and the one before); disk: $(df -h /opt/cctv | awk 'NR==2{print $4" free"}')"
echo "current -> $(readlink -f /opt/cctv/current), RELEASE=$(cat /opt/cctv/current/RELEASE)"
