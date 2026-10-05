#!/usr/bin/env bash
# Simulation of the remote-site gateways, entirely inside network namespaces it creates (sg-*):
#
#   sg-hub (CCTV server: wg0 10.77.0.1, no forwarding, the hub firewall)  203.0.113.10/.11
#     |
#   sg-inet ("internet" + carrier NAT: sites can dial out, nothing unsolicited gets in)
#     |-- site 3: sg-a-rtr (4G router, masquerade) + sg-a-pi (Raspberry Pi, ONE port, runs
#     |           site-gateway.sh) + sg-a-nvr (NVR 192.168.1.10/.11, gateway = the router, not the Pi)
#     |-- site 4: sg-b-gw (Debian box that IS the router, runs site-gateway.sh --only .10) + sg-b-nvr
#     `-- site 5: sg-c-rtr (OpenWrt-style router: site-recipes.sh's nft include inside an emulated
#                 fw4 table) + sg-c-nvr
#   All three site LANs are 192.168.1.0/24 and every NVR is 192.168.1.10.
#
# Needs root, wireguard-tools, nftables, python3. Never touches the host's own network: every
# link/rule lives in the namespaces, and everything (namespaces, /etc/netns/sg-*, temp files) is
# removed on exit; at the end it compares the host's links/addresses/routes/nft rules with before.
#   sudo bash deploy/vpn/test/site-sim.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GW=$here/../site-gateway.sh
REC=$here/../site-recipes.sh
SIM=$here/simnet.py
NSS=(sg-hub sg-inet sg-a-rtr sg-a-pi sg-a-nvr sg-b-gw sg-b-nvr sg-c-rtr sg-c-nvr)
[[ $(id -u) == 0 ]] || { echo "run as root" >&2; exit 1; }
for t in wg wg-quick nft ip python3; do command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done
for ns in "${NSS[@]}"; do ! ip netns list | grep -qw "$ns" || { echo "namespace $ns exists already" >&2; exit 1; }; done

host_state() {
  ip -br link | awk '{print $1, $2}'
  ip -4 -o addr | awk '{print $2, $4}'
  ip route show table all
  ip rule
  nft list ruleset | sed -E 's/counter packets [0-9]+ bytes [0-9]+/counter/'
  sysctl -n net.ipv4.ip_forward
}
T=$(mktemp -d /tmp/sg-sim.XXXXXX)
ETC_NETNS_EXISTED=0
[[ -d /etc/netns ]] && ETC_NETNS_EXISTED=1
host_state >"$T/host-before"

cleanup() {
  local ns pids
  for ns in "${NSS[@]}"; do
    if ip netns list | grep -qw "$ns"; then
      pids=$(ip netns pids "$ns" 2>/dev/null | tr '\n' ' ')
      [[ -z ${pids// /} ]] || kill $pids 2>/dev/null || true
    fi
  done
  sleep 0.5
  for ns in "${NSS[@]}"; do ip netns del "$ns" 2>/dev/null || true; done
  rm -rf /etc/netns/sg-a-pi
  [[ $ETC_NETNS_EXISTED == 1 ]] || rmdir /etc/netns 2>/dev/null || true
}
finish() {
  local rc=$?
  cleanup
  host_state >"$T/host-after"
  if diff -q "$T/host-before" "$T/host-after" >/dev/null; then
    echo "host network: unchanged"
  else
    echo "HOST NETWORK CHANGED:"
    diff "$T/host-before" "$T/host-after" || true
    rc=1
  fi
  rm -rf "$T"
  exit "$rc"
}
trap finish EXIT

PASS=0
FAIL=0
LAST=""
report() { # ok label detail
  if [[ $1 == 1 ]]; then PASS=$((PASS + 1)); echo "PASS  $2${3:+  [$3]}"; else FAIL=$((FAIL + 1)); echo "FAIL  $2${3:+  [$3]}"; fi
}
n() { ip netns exec "$@"; }
probe() { n "$1" python3 "$SIM" probe "$2" "$3" "${4:-3}" 2>&1 || true; }
expect_open() { # label ns host port [substring...]
  local label=$1 ns=$2 host=$3 port=$4 ok=1 p
  shift 4
  LAST=$(probe "$ns" "$host" "$port")
  [[ $LAST == OPEN* ]] || ok=0
  for p in "$@"; do [[ $LAST == *"$p"* ]] || ok=0; done
  report "$ok" "$label" "$LAST"
}
expect_closed() { # label ns host port
  LAST=$(probe "$2" "$3" "$4")
  if [[ $LAST == OPEN* ]]; then report 0 "$1" "$LAST"; else report 1 "$1" "$LAST"; fi
}
expect_ping() { if n "$2" ping -c1 -W2 "$3" >/dev/null 2>&1; then report 1 "$1"; else report 0 "$1" "no reply"; fi; }
expect_noping() { if n "$2" ping -c1 -W2 "$3" >/dev/null 2>&1; then report 0 "$1" "replied"; else report 1 "$1"; fi; }
expect_fail() { # label substring command...
  local label=$1 sub=$2 out rc=0
  shift 2
  out=$("$@" 2>&1) || rc=$?
  if [[ $rc != 0 && $out == *"$sub"* ]]; then report 1 "$label" "$(grep -m1 -F "$sub" <<<"$out")"; else report 0 "$label" "rc=$rc: $(tail -2 <<<"$out" | tr '\n' ' ')"; fi
}
mss_ok() { # LAST holds "... mss N ... clientmss M": both must fit the 1280 tunnel MTU
  local a b
  a=$(sed -n 's/.* mss \([0-9]*\).*/\1/p' <<<"$LAST")
  b=$(sed -n 's/.*clientmss \([0-9]*\).*/\1/p' <<<"$LAST")
  if [[ -n $a && -n $b && $a -le 1240 && $b -le 1240 ]]; then report 1 "$1: MSS clamped (NVR $a, hub $b)"; else report 0 "$1: MSS" "NVR $a hub $b"; fi
}
section() { printf '\n---- %s\n' "$*"; }
serve() { n "$1" python3 "$SIM" serve "$2" "${@:3}" >>"$T/serve-$1.log" 2>&1 & }

# ---------------------------------------------------------------- topology
section "topology"
for ns in "${NSS[@]}"; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
link() { # ns1 if1 ns2 if2
  ip -n "$1" link add "$2" type veth peer name "$4" netns "$3"
  ip -n "$1" link set "$2" up
  ip -n "$3" link set "$4" up
}
fwd() { n "$1" sysctl -q -w net.ipv4.ip_forward="$2"; }
link sg-inet i-hub sg-hub wan
link sg-inet i-a sg-a-rtr wan
link sg-inet i-b sg-b-gw wan
link sg-inet i-c sg-c-rtr wan
ip -n sg-inet addr add 203.0.113.1/24 dev i-hub
ip -n sg-inet addr add 100.64.1.1/24 dev i-a
ip -n sg-inet addr add 100.64.2.1/24 dev i-b
ip -n sg-inet addr add 100.64.3.1/24 dev i-c
fwd sg-inet 1
n sg-inet nft -f - <<'EOF'
table ip cgn {
  chain post { type nat hook postrouting priority srcnat; policy accept;
    oifname "i-hub" ip saddr 100.64.0.0/16 masquerade
  }
  chain forward { type filter hook forward priority filter; policy accept;
    iifname "i-hub" ct state established,related accept
    iifname "i-hub" counter drop comment "carrier NAT: nothing unsolicited reaches a site"
  }
}
EOF
ip -n sg-hub addr add 203.0.113.10/24 dev wan
ip -n sg-hub addr add 203.0.113.11/24 dev wan
ip -n sg-hub route add default via 203.0.113.1
# site A: router + Pi + NVR on one bridge
ip -n sg-a-rtr addr add 100.64.1.2/24 dev wan
ip -n sg-a-rtr route add default via 100.64.1.1
ip -n sg-a-rtr link add br0 type bridge
ip -n sg-a-rtr link set br0 up
link sg-a-rtr a-pi sg-a-pi eth0
link sg-a-rtr a-nvr sg-a-nvr eth0
ip -n sg-a-rtr link set a-pi master br0
ip -n sg-a-rtr link set a-nvr master br0
ip -n sg-a-rtr addr add 192.168.1.1/24 dev br0
fwd sg-a-rtr 1
n sg-a-rtr nft add table ip nat
n sg-a-rtr nft 'add chain ip nat post { type nat hook postrouting priority srcnat; policy accept; }'
n sg-a-rtr nft add rule ip nat post oifname wan masquerade
ip -n sg-a-pi addr add 192.168.1.50/24 dev eth0
ip -n sg-a-pi route add default via 192.168.1.1
ip -n sg-a-nvr addr add 192.168.1.10/24 dev eth0
ip -n sg-a-nvr addr add 192.168.1.11/24 dev eth0
ip -n sg-a-nvr route add default via 192.168.1.1
# site B: the gateway is the router
ip -n sg-b-gw addr add 100.64.2.2/24 dev wan
ip -n sg-b-gw route add default via 100.64.2.1
link sg-b-gw lan sg-b-nvr eth0
ip -n sg-b-gw addr add 192.168.1.1/24 dev lan
ip -n sg-b-nvr addr add 192.168.1.10/24 dev eth0
ip -n sg-b-nvr addr add 192.168.1.11/24 dev eth0
ip -n sg-b-nvr route add default via 192.168.1.1
# site C: OpenWrt-style router
ip -n sg-c-rtr addr add 100.64.3.2/24 dev wan
ip -n sg-c-rtr route add default via 100.64.3.1
link sg-c-rtr lan sg-c-nvr eth0
ip -n sg-c-rtr addr add 192.168.1.1/24 dev lan
fwd sg-c-rtr 1
ip -n sg-c-nvr addr add 192.168.1.10/24 dev eth0
ip -n sg-c-nvr route add default via 192.168.1.1
# the Pi finds the hub by name (ip netns exec bind-mounts /etc/netns/<ns>/hosts over /etc/hosts)
mkdir -p /etc/netns/sg-a-pi
printf '127.0.0.1 localhost\n203.0.113.10 hub.cctv.test\n' >/etc/netns/sg-a-pi/hosts
# listeners: NVRs on 6036 (+22/80 that must stay unreachable), the Pi/gateways on 22 and 6036
serve sg-a-nvr nvr-a 6036 22 80
serve sg-b-nvr nvr-b 6036 22 80
serve sg-c-nvr nvr-c 6036 22 80
serve sg-a-pi pi-a 22 6036
serve sg-b-gw gw-b 22 6036
serve sg-c-rtr rtr-c 22 6036
serve sg-hub hub 22 8443
sleep 1
echo "namespaces: ${NSS[*]}"

# ---------------------------------------------------------------- hub + bundles
section "hub and site bundles"
umask 077
wg genkey >"$T/hub.key"
HUBPUB=$(wg pubkey <"$T/hub.key")
mkbundle() { # dir id name endpoint real_lan
  local d=$1 id=$2 key pub
  mkdir -p "$d"
  key=$(wg genkey)
  pub=$(wg pubkey <<<"$key")
  cat >"$d/site.env" <<EOF
# CCTV VPN site bundle (format 1). No secrets.
CCTV_VPN_BUNDLE=1
SITE_ID=$id
SITE_NAME=$3
TUNNEL_IP=10.77.0.$id
VIRTUAL_SUBNET=10.78.$id.0/24
REAL_LAN=$5
HUB_TUNNEL_IP=10.77.0.1
HUB_ENDPOINT=$4
HUB_PUBLIC_KEY=$HUBPUB
SITE_PUBLIC_KEY=$pub
NVR_PORT=6036
KEEPALIVE=25
MTU=1280
EOF
  printf '%s\n' "$key" >"$d/site.key"
  cat >"$d/wg0.conf" <<EOF
[Interface]
PrivateKey = $key
Address = 10.77.0.$id/32
MTU = 1280

[Peer]
PublicKey = $HUBPUB
Endpoint = $4
AllowedIPs = 10.77.0.1/32
PersistentKeepalive = 25
EOF
  echo "$pub"
}
PUB_A=$(mkbundle "$T/b/cctv-site-3-yard-a" 3 yard-a hub.cctv.test:51820 192.168.1.0/24)
PUB_B=$(mkbundle "$T/b/cctv-site-4-depot-b" 4 depot-b 203.0.113.10:51820 192.168.1.0/24)
PUB_C=$(mkbundle "$T/b/cctv-site-5-farm-c" 5 farm-c 203.0.113.10:51820 192.168.1.0/24)
wg genpsk >"$T/b/cctv-site-4-depot-b/site.psk"
tar -C "$T/b" -czf "$T/b/cctv-site-4-depot-b.tar.gz" cctv-site-4-depot-b
n sg-hub ip link add wg0 type wireguard
n sg-hub wg set wg0 private-key "$T/hub.key" listen-port 51820
n sg-hub ip addr add 10.77.0.1/24 dev wg0
n sg-hub ip link set wg0 up
for s in "3 $PUB_A" "4 $PUB_B" "5 $PUB_C"; do
  read -r id pub <<<"$s"
  n sg-hub wg set wg0 peer "$pub" allowed-ips "10.77.0.$id/32,10.78.$id.0/24"
  [[ $id != 4 ]] || n sg-hub wg set wg0 peer "$pub" preshared-key "$T/b/cctv-site-4-depot-b/site.psk"
  n sg-hub ip route add "10.78.$id.0/24" dev wg0
done
HUBFW=$(cat <<'EOF'
table inet cctv_vpn {
  chain input { type filter hook input priority filter; policy accept;
    iifname "wg0" ct state established,related accept
    iifname "wg0" icmp type echo-reply accept
    iifname "wg0" counter drop
  }
  chain output { type filter hook output priority filter; policy accept;
    oifname "wg0" ip daddr { 10.78.0.0/16, 10.77.0.0/24 } tcp dport 6036 accept
    oifname "wg0" ip daddr { 10.78.0.0/16, 10.77.0.0/24 } icmp type echo-request accept
    oifname "wg0" counter drop
  }
}
EOF
)
echo "hub: wg0 10.77.0.1/24 (MTU 1420), peers for sites 3 4 5, ip_forward $(n sg-hub sysctl -n net.ipv4.ip_forward)"

# ---------------------------------------------------------------- input checks
section "site-gateway.sh refuses bad or unsafe bundles"
BA=$T/b/cctv-site-3-yard-a
variant() { # name sed-expression -> a changed copy of bundle A
  local d=$T/v/$1
  rm -rf "$d"
  mkdir -p "$T/v"
  cp -a "$BA" "$d"
  sed -i "$2" "$d/site.env"
  echo "$d"
}
chk() { n sg-a-pi bash "$GW" check "$@" --no-packages; }
expect_fail "bad site name" "site name must be" chk "$(variant name 's/^SITE_NAME=.*/SITE_NAME=Yard_A/')"
expect_fail "tunnel IP of another site" "does not belong" chk "$(variant tip 's/^TUNNEL_IP=.*/TUNNEL_IP=10.77.0.9/')"
d=$(variant id1 's#^SITE_ID=.*#SITE_ID=1#; s#^TUNNEL_IP=.*#TUNNEL_IP=10.77.0.1#; s#^VIRTUAL_SUBNET=.*#VIRTUAL_SUBNET=10.78.1.0/24#')
rm "$d/wg0.conf"
expect_fail "site id 1 (would be the hub's 10.77.0.1)" "site ids are 2..250" chk "$d"
expect_fail "real LAN not a /24" "must be one /24" chk "$(variant l23 's#^REAL_LAN=.*#REAL_LAN=192.168.0.0/23#')"
expect_fail "real LAN public" "not a private network" chk "$(variant pub 's#^REAL_LAN=.*#REAL_LAN=8.8.8.0/24#')"
expect_fail "real LAN inside the VPN ranges" "overlaps" chk "$(variant ovl 's#^REAL_LAN=.*#REAL_LAN=10.78.1.0/24#')"
expect_fail "real LAN not on this box" "no interface directly on" chk "$(variant far 's#^REAL_LAN=.*#REAL_LAN=192.168.9.0/24#')"
expect_fail "hub key garbage" "hub public key" chk "$(variant key 's#^HUB_PUBLIC_KEY=.*#HUB_PUBLIC_KEY=abc#')"
expect_fail "shell code in a value" "unexpected characters" chk "$(variant sh 's#^SITE_NAME=.*#SITE_NAME=$(reboot)#')"
expect_fail "endpoint with a ;" "unexpected characters" chk "$(variant ep 's#^HUB_ENDPOINT=.*#HUB_ENDPOINT=hub;reboot:51820#')"
d=$(variant eplan 's#^HUB_ENDPOINT=.*#HUB_ENDPOINT=192.168.1.1:51820#')
rm "$d/wg0.conf" # (also: a bundle without wg0.conf is fine)
expect_fail "endpoint inside the site LAN" "inside the site LAN" chk "$d"
d=$(variant epmix 's#^HUB_ENDPOINT=.*#HUB_ENDPOINT=198.51.100.7:51820#')
expect_fail "site.env and wg0.conf disagree" "different hub endpoints" chk "$d"
expect_fail "keepalive 0" "KEEPALIVE must be" chk "$(variant ka 's#^KEEPALIVE=.*#KEEPALIVE=0#')"
expect_fail "key does not match SITE_PUBLIC_KEY" "does not match" chk "$(variant pk "s#^SITE_PUBLIC_KEY=.*#SITE_PUBLIC_KEY=$PUB_B#")"
d=$(variant peers 's/x/x/')
printf '\n[Peer]\nPublicKey = %s\nAllowedIPs = 10.0.0.0/8\n' "$PUB_B" >>"$d/wg0.conf"
expect_fail "wg0.conf with a second peer" "[Peer] sections" chk "$d"
expect_fail "--only outside the LAN" "is not in the site LAN" chk "$BA" --only 192.168.2.10
expect_fail "--only this box itself" "is this box itself" chk "$BA" --only 192.168.1.50
mkdir -p "$T/evil/x" && cp "$BA"/* "$T/evil/x/" && tar -C "$T/evil" -czf "$T/evil1.tar.gz" x --transform 's#^x/site.env#x/../../site.env#'
expect_fail "tar member with .." "unexpected file name" chk "$T/evil1.tar.gz"
ln -s /etc/shadow "$T/evil/x/README.txt" && tar -C "$T/evil" -czf "$T/evil2.tar.gz" x
expect_fail "tar with a symlink" "links or special files" chk "$T/evil2.tar.gz"
ip -n sg-a-pi link add d0 type veth peer name d1 && ip -n sg-a-pi addr add 10.78.9.1/24 dev d0
expect_fail "box already uses the VPN ranges" "inside the VPN ranges" chk "$BA"
ip -n sg-a-pi link del d0
d=$(variant nolan 's#^REAL_LAN=.*#REAL_LAN=#')
out=$(chk "$d" 2>&1) && [[ $out == *"Record that for site 3"* && $out == *"192.168.1.0/24 on eth0"* ]] && report 1 "no REAL_LAN in the bundle: detected 192.168.1.0/24 on eth0" || report 0 "no REAL_LAN detection" "$out"
d=$(variant alias 's/^SITE_ID=/ID=/; s/^SITE_NAME=/NAME=/; s/^REAL_LAN=/LAN=/')
mv "$d/site.key" "$d/private.key" && rm "$d/wg0.conf" && wg genpsk >"$d/psk"
out=$(chk "$d" 2>&1) && [[ $out == *"check passed"* && $out == *"site 3 (yard-a)"* ]] && report 1 "hub-style names (ID/NAME/LAN, private.key, psk, no wg0.conf) are read" || report 0 "alias bundle" "$(tail -2 <<<"$out")"
n sg-a-pi nft -f - <<<'table ip filter { chain FORWARD { type filter hook forward priority filter; policy drop; }; }'
out=$(chk "$BA" 2>&1) && [[ $out == *"another firewall drops forwarded packets"* && $out == *"iptables -I FORWARD -i wg-cctv -o eth0"* ]] && report 1 "warns about a Docker-style FORWARD drop policy and prints the fix" || report 0 "forward-drop warning" "$(tail -3 <<<"$out")"
n sg-a-pi nft delete table ip filter
out=$(chk "$BA" 2>&1) && [[ $out == *"check passed"* ]] && report 1 "check of the good bundle passes and changes nothing" || report 0 "check good bundle" "$out"

# ---------------------------------------------------------------- install the gateways
section "install: site 3 (Pi with one port behind a 4G router), site 4 (Debian router, --only .10)"
mkdir -p "$T/root-a" "$T/root-b"
n sg-a-pi bash "$GW" install "$BA" --root "$T/root-a" --no-systemd --no-packages | tee "$T/install-a.log" | sed 's/^/  | /'
n sg-b-gw bash "$GW" install "$T/b/cctv-site-4-depot-b.tar.gz" --only 192.168.1.10 --root "$T/root-b" --no-systemd --no-packages | tee "$T/install-b.log" | sed 's/^/  | /'
grep -q "tunnel UP" "$T/install-a.log" && report 1 "site 3 handshake after install" || report 0 "site 3 handshake"
grep -q "tunnel UP" "$T/install-b.log" && report 1 "site 4 handshake after install (with a preshared key)" || report 0 "site 4 handshake"
grep -q "^PresharedKey = " "$T/root-b/etc/wireguard/wg-cctv.conf" && report 1 "site 4 config carries the preshared key" || report 0 "site 4 psk in config"
[[ $(stat -c %a "$T/root-a/etc/wireguard/wg-cctv.conf") == 600 ]] && report 1 "the key file is 0600" || report 0 "key file mode"
grep -q PrivateKey "$T/root-a/etc/cctv-site/site.env" && report 0 "site.env holds no key" || report 1 "the saved site.env holds no key"

section "site 5: OpenWrt recipe (fw4 include) in an emulated fw4 table"
bash "$REC" "$T/b/cctv-site-5-farm-c" openwrt --out "$T/rec-c" >/dev/null
sed -n "/^cat >\/etc\/nftables.d\/50-cctv-vpn.nft <<'NFT'\$/,/^NFT\$/p" "$T/rec-c/cctv-site-5-openwrt.sh" | sed '1d;$d' >"$T/c-include.nft"
{
  echo "table inet fw4 {"
  cat "$T/c-include.nft"
  cat <<'EOF'
  chain input { type filter hook input priority filter; policy accept;
    ct state established,related accept
    iifname "cctv" ip saddr 10.77.0.1 icmp type echo-request accept comment "uci rule cctv_ping"
    iifname "cctv" drop comment "zone cctv input DROP"
  }
  chain forward { type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "cctv" jump forward_cctv
    iifname "lan" oifname "wan" accept
  }
  chain forward_cctv {
    ip saddr 10.77.0.1 ip daddr 192.168.1.0/24 tcp dport 6036 oifname "lan" accept comment "uci rule cctv_nvr"
    ip saddr 10.77.0.1 ip daddr 192.168.1.0/24 icmp type echo-request oifname "lan" accept comment "uci rule cctv_nvr_ping"
    drop comment "zone cctv forward DROP"
  }
}
EOF
} >"$T/c-fw4.nft"
if n sg-c-rtr nft -f "$T/c-fw4.nft"; then report 1 "OpenWrt include loads inside table inet fw4"; else report 0 "OpenWrt include loads"; fi
n sg-c-rtr ip link add cctv type wireguard
n sg-c-rtr wg set cctv private-key "$T/b/cctv-site-5-farm-c/site.key" peer "$HUBPUB" endpoint 203.0.113.10:51820 allowed-ips 10.77.0.1/32 persistent-keepalive 25
n sg-c-rtr ip addr add 10.77.0.5/32 dev cctv
n sg-c-rtr ip link set cctv mtu 1280 up
n sg-c-rtr ip route add 10.77.0.1/32 dev cctv
sleep 2

# ---------------------------------------------------------------- what gets through
section "from the CCTV server (hub firewall OFF: the site gateways alone must hold)"
expect_open "site 3 NVR 10.78.3.10:6036 via the one-port Pi" sg-hub 10.78.3.10 6036 "nvr-a port 6036" "peer 192.168.1.50"
mss_ok "site 3"
expect_open "site 3 second host 10.78.3.11:6036 (whole /24 mapped)" sg-hub 10.78.3.11 6036 "nvr-a"
expect_open "site 4 NVR 10.78.4.10:6036 (same real IP 192.168.1.10)" sg-hub 10.78.4.10 6036 "nvr-b port 6036" "peer 192.168.1.1"
mss_ok "site 4"
expect_open "site 5 NVR 10.78.5.10:6036 (OpenWrt include)" sg-hub 10.78.5.10 6036 "nvr-c port 6036" "peer 192.168.1.1"
mss_ok "site 5"
expect_closed "site 4 10.78.4.11:6036 is not in --only" sg-hub 10.78.4.11 6036
expect_closed "site 3 NVR SSH port 22" sg-hub 10.78.3.10 22
expect_closed "site 3 NVR web port 80" sg-hub 10.78.3.10 80
expect_closed "site 4 NVR port 22" sg-hub 10.78.4.10 22
expect_closed "site 5 NVR port 22" sg-hub 10.78.5.10 22
expect_closed "site 3 Pi's own SSH on its tunnel IP" sg-hub 10.77.0.3 22
expect_closed "site 3 Pi's own 6036 on its tunnel IP" sg-hub 10.77.0.3 6036
expect_closed "site 3 Pi's own LAN address through the map (10.78.3.50)" sg-hub 10.78.3.50 6036
expect_closed "site 4 router's own SSH" sg-hub 10.77.0.4 22
expect_closed "site 4 router's LAN address through the map (10.78.4.1)" sg-hub 10.78.4.1 22
expect_closed "site 5 router's own SSH" sg-hub 10.77.0.5 22
expect_ping "ping site 3 gateway 10.77.0.3" sg-hub 10.77.0.3
expect_ping "ping site 3 NVR 10.78.3.10" sg-hub 10.78.3.10
expect_ping "ping site 4 NVR 10.78.4.10" sg-hub 10.78.4.10
expect_noping "no ping to site 4 10.78.4.11 (not in --only)" sg-hub 10.78.4.11
expect_ping "ping site 5 NVR 10.78.5.10" sg-hub 10.78.5.10
# a compromised hub that addresses the real LAN directly (no virtual address, so no DNAT)
n sg-hub wg set wg0 peer "$PUB_A" allowed-ips 10.77.0.3/32,10.78.3.0/24,192.168.1.0/24
n sg-hub ip route add 192.168.1.0/24 dev wg0
expect_closed "hub sending straight to the real 192.168.1.10:6036 is dropped (not via the map)" sg-hub 192.168.1.10 6036
n sg-hub ip route del 192.168.1.0/24 dev wg0
n sg-hub wg set wg0 peer "$PUB_A" allowed-ips 10.77.0.3/32,10.78.3.0/24

section "from the sites (hub firewall OFF)"
n sg-a-nvr ip route add 10.77.0.0/24 via 192.168.1.50
expect_closed "a LAN device using the Pi as gateway cannot reach the hub" sg-a-nvr 10.77.0.1 8443
n sg-a-nvr ip route del 10.77.0.0/24 via 192.168.1.50
n sg-a-pi ip route add 10.78.4.0/24 dev wg-cctv
expect_closed "site 3 cannot reach site 4's NVR (10.78.4.10)" sg-a-pi 10.78.4.10 6036
n sg-a-pi ip route del 10.78.4.0/24 dev wg-cctv

section "hub firewall ON (the decided inet cctv_vpn rules)"
n sg-hub nft -f - <<<"$HUBFW"
expect_open "hub -> site 3 NVR still works" sg-hub 10.78.3.10 6036 "nvr-a"
expect_closed "hub -> site 3 NVR port 80 stopped at the hub" sg-hub 10.78.3.10 80
expect_closed "site 3 gateway -> hub SSH (22) dropped by the hub" sg-a-pi 10.77.0.1 22
expect_closed "site 4 gateway -> hub web UI (8443) dropped by the hub" sg-b-gw 10.77.0.1 8443
expect_noping "site 3 pinging the hub is not answered (by design)" sg-a-pi 10.77.0.1
echo "  hub sees the sites behind the carrier NAT:"
n sg-hub wg show wg0 endpoints | sed 's/^/    /'

section "status, re-run, DNS re-resolve"
n sg-a-pi bash "$GW" status --root "$T/root-a" | sed 's/^/  | /'
n sg-a-pi bash "$GW" install "$BA" --root "$T/root-a" --no-systemd --no-packages >"$T/install-a2.log" 2>&1 && report 1 "install again (idempotent)" || report 0 "install again" "$(tail -3 "$T/install-a2.log")"
c=$(n sg-a-pi nft list table ip cctv_site | grep -c 'dnat to' || true)
[[ $c == 2 ]] && report 1 "still exactly 2 DNAT rules after the re-run" || report 0 "DNAT rules after re-run" "$c"
expect_open "site 3 NVR after the re-run" sg-hub 10.78.3.10 6036 "nvr-a"
# the main site's public address changes: the old one stops working for site 3, DNS now says .11
n sg-inet nft add rule ip cgn forward iifname "i-a" ip daddr 203.0.113.10 drop
printf '127.0.0.1 localhost\n203.0.113.11 hub.cctv.test\n' >/etc/netns/sg-a-pi/hosts
n sg-a-pi conntrack -F >/dev/null 2>&1 || true
expect_closed "site 3 cut off after the hub address changed" sg-hub 10.78.3.10 6036
n sg-a-pi env CCTV_SITE_RERESOLVE_AFTER=0 bash "$GW" reresolve --root "$T/root-a" | sed 's/^/  | /'
n sg-a-pi ping -c1 -W3 -I wg-cctv 10.77.0.1 >/dev/null 2>&1 || true # any packet: new handshake
sleep 2
expect_open "site 3 back after re-resolving the hub name" sg-hub 10.78.3.10 6036 "nvr-a"

section "uninstall"
n sg-a-pi bash "$GW" uninstall --root "$T/root-a" | sed 's/^/  | /'
n sg-b-gw bash "$GW" uninstall --root "$T/root-b" | sed 's/^/  | /'
for ns in sg-a-pi sg-b-gw; do
  left=$( { ip -n "$ns" link show dev wg-cctv 2>/dev/null; n "$ns" nft list table ip cctv_site 2>/dev/null || true; } | wc -l)
  fw=$(n "$ns" sysctl -n net.ipv4.ip_forward)
  [[ $left == 0 && $fw == 0 ]] && report 1 "$ns: tunnel, table gone, ip_forward back to 0" || report 0 "$ns uninstall" "left=$left fwd=$fw"
done
[[ -z $(find "$T/root-a" "$T/root-b" -type f) ]] && report 1 "no files left under the test roots" || report 0 "files left" "$(find "$T/root-a" "$T/root-b" -type f | tr '\n' ' ')"
expect_closed "site 3 unreachable after uninstall" sg-hub 10.78.3.10 6036

section "systemd units (rendered, not started) and all recipes"
mkdir -p "$T/root-u"
n sg-a-pi bash "$GW" install "$BA" --root "$T/root-u" --no-packages >"$T/units.log" 2>&1 && report 1 "units rendered under --root" || report 0 "units rendered" "$(tail -3 "$T/units.log")"
if command -v systemd-analyze >/dev/null; then
  u=$T/root-u/etc/systemd/system
  out=$(systemd-analyze verify "$u/cctv-site-gateway-firewall.service" "$u/cctv-site-gateway-reresolve.service" "$u/cctv-site-gateway-reresolve.timer" 2>&1 || true)
  bad=$(grep -v -E "/usr/local/sbin/cctv-site-gateway.*(not executable|No such file)|^$" <<<"$out" || true)
  [[ -z $bad ]] && report 1 "systemd-analyze verify: units OK" || report 0 "systemd-analyze verify" "$(tr "
" " " <<<"$bad")"
fi
bash "$REC" "$T/b/cctv-site-5-farm-c" all --nvr 192.168.1.10,192.168.1.11 --out "$T/rec-all" >/dev/null 2>"$T/rec.err" && report 1 "site-recipes.sh renders every platform" || report 0 "recipes" "$(cat "$T/rec.err")"
if grep -rl '@@' "$T/rec-all" >/dev/null 2>&1; then report 0 "unfilled placeholders" "$(grep -rl '@@' "$T/rec-all")"; else report 1 "no unfilled placeholders"; fi
sh -n "$T/rec-all/cctv-site-5-openwrt/cctv-site-5-openwrt.sh" && report 1 "OpenWrt script: sh -n OK" || report 0 "OpenWrt script syntax"
bad=$(find "$T/rec-all" -type f ! -perm 600 | wc -l)
[[ $bad == 0 ]] && report 1 "every recipe file is 0600" || report 0 "recipe file modes" "$bad"
for f in "$T/rec-all"/*/*; do printf '  %-60s %s lines\n' "${f#"$T"/rec-all/}" "$(wc -l <"$f")"; done
[[ -n ${SIM_KEEP_RECIPES:-} ]] && { rm -rf "$SIM_KEEP_RECIPES"; cp -a "$T/rec-all" "$SIM_KEEP_RECIPES"; echo "  recipes copied to $SIM_KEEP_RECIPES"; }

section "result"
echo "passed $PASS, failed $FAIL"
[[ $FAIL == 0 ]]
