#!/bin/sh
# /usr/local/sbin/argus-reboot (root:root 0755), run by argus-reboot.service when the Argus app asks
# for the machine to be rebooted (Settings > Server). The request is a file the app writes in its own
# data folder. Nothing in it is read: only its age. It is deleted first, so this can never run in a loop.
#
# Install (once, as root):
#   install -m 755 deploy/argus-reboot.sh /usr/local/sbin/argus-reboot
#   install -m 644 deploy/argus-reboot.path deploy/argus-reboot.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now argus-reboot.path
set -u
F=/var/lib/private/cctv/reboot-request
[ -e "$F" ] || [ -L "$F" ] || exit 0
MT=$(stat -c %Y -- "$F" 2>/dev/null || echo 0) # (stat does not follow a symlink)
rm -rf -- "$F"
NOW=$(date +%s)
UP=$(cut -d. -f1 /proc/uptime)
if [ "$UP" -lt 300 ]; then
  echo "reboot request ignored: the machine started ${UP} s ago"
  exit 0
fi
AGE=$((NOW - MT))
if [ "$AGE" -gt 120 ] || [ "$AGE" -lt -5 ]; then
  echo "reboot request ignored: it is ${AGE} s old"
  exit 0
fi
echo "rebooting: requested from the Argus app (who asked is in its audit log)"
exec systemctl reboot
