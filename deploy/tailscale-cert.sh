#!/usr/bin/env bash
# A real HTTPS certificate for this server's tailnet name, from Tailscale.
#
# Why bother: the app generates its own self-signed certificate, which works but makes every
# browser show a warning before it will play video, on every device, for ever. Tailscale will issue
# a genuine Let's Encrypt certificate for the machine's own tailnet name, so viewing the cameras
# from outside is just a normal HTTPS page.
#
# Nothing here is exposed to the internet. The name resolves only inside your tailnet, and the
# certificate is issued for it; the server keeps listening on the same port it always did.
#
#   sudo deploy/tailscale-cert.sh            get (or renew) the certificate and install it
#   sudo deploy/tailscale-cert.sh --timer    ... and check weekly from then on
#
# Run it after `sudo tailscale up`. It refuses to do anything if Tailscale is not connected yet,
# rather than leaving a half-installed certificate behind.
set -euo pipefail

want_timer=0
[ "${1:-}" = "--timer" ] && want_timer=1
[ "$(id -u)" = 0 ] || { echo "run this with sudo" >&2; exit 1; }
command -v tailscale >/dev/null || { echo "tailscale is not installed" >&2; exit 1; }

# The app's certificate lives in its state directory. systemd's DynamicUser puts that under
# /var/lib/private, and the service reaches it as /var/lib/cctv; either path may be the real one.
data_dir=""
for d in /var/lib/private/cctv /var/lib/cctv; do [ -d "$d" ] && { data_dir="$d"; break; }; done
[ -n "$data_dir" ] || { echo "cannot find the app's data directory" >&2; exit 1; }
certs="$data_dir/certs"

fqdn="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
if [ -z "$fqdn" ]; then
  echo "Tailscale is not connected yet. Run 'sudo tailscale up' first, then run this again." >&2
  exit 2
fi
echo "tailnet name: $fqdn"

# tailscale cert renews by itself when the certificate is close to expiry, and is a no-op when it
# is not, so this is safe to run as often as you like.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! tailscale cert --cert-file "$tmp/cert.pem" --key-file "$tmp/key.pem" "$fqdn" 2>"$tmp/err"; then
  echo "Tailscale would not issue a certificate:" >&2
  sed 's/^/  /' "$tmp/err" >&2
  echo "  HTTPS certificates have to be switched on for your tailnet: in the admin console," >&2
  echo "  under DNS, enable MagicDNS and then HTTPS Certificates." >&2
  exit 3
fi

# Only touch the running service if something actually changed: a needless restart costs a minute
# of recording on every site.
if [ -f "$certs/cert.pem" ] && cmp -s "$tmp/cert.pem" "$certs/cert.pem"; then
  echo "certificate is already current; nothing to do"
else
  mkdir -p "$certs"
  install -m 0644 "$tmp/cert.pem" "$certs/cert.pem"
  install -m 0600 "$tmp/key.pem" "$certs/key.pem"
  # Match whatever owns the data directory: under DynamicUser that is a number, not a name.
  owner="$(stat -c '%u:%g' "$data_dir")"
  chown "$owner" "$certs/cert.pem" "$certs/key.pem" "$certs" 2>/dev/null || true
  # The app regenerates its self-signed certificate whenever the host list changes, and it decides
  # a certificate is its own by the presence of this marker. Removing it means "this one is mine,
  # leave it alone" -- see cctv/tls.mjs.
  rm -f "$certs/hosts"
  echo "installed into $certs"
  systemctl restart cctv
  echo "cctv restarted"
fi

if [ "$want_timer" = 1 ]; then
  # Tailscale certificates last about 90 days. Checking weekly renews well before that, and does
  # nothing at all on the weeks it is not due.
  cat > /etc/systemd/system/cctv-tailscale-cert.service <<EOF
[Unit]
Description=Renew the CCTV server's tailnet HTTPS certificate
After=tailscaled.service

[Service]
Type=oneshot
ExecStart=$(readlink -f "$0")
EOF
  cat > /etc/systemd/system/cctv-tailscale-cert.timer <<'EOF'
[Unit]
Description=Check the CCTV server's tailnet HTTPS certificate weekly

[Timer]
OnCalendar=Mon 04:30
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now cctv-tailscale-cert.timer
  echo "weekly renewal check enabled"
fi

echo
echo "Open the cameras from anywhere on your tailnet at:"
echo "  https://$fqdn:8443/"
