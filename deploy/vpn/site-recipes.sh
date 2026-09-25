#!/usr/bin/env bash
# CCTV VPN: the exact setup for a remote site whose gateway is NOT a Linux box (a router, a
# firewall or a Windows PC), filled in from that site's bundle. Linux boxes (Raspberry Pi,
# Debian, Ubuntu) use site-gateway.sh instead.
#
#   bash site-recipes.sh <bundle> <platform> [--nvr IP[,IP..]] [--lan CIDR] [--lan-if NAME]
#                        [--ifname NAME] [--out DIR]
#
#   platform   mikrotik | openwrt | rutos | pfsense | opnsense | edgeos | unifi | windows | linux | all
#   --nvr      the NVRs' real LAN addresses. Needed for edgeos, unifi and windows (they map host
#              by host); for the others it narrows the allow rules to these hosts
#   --lan      the site LAN /24 (when the bundle has no REAL_LAN)
#   --lan-if   the router's LAN interface (mikrotik: bridge, edgeos: switch0, openwrt zone: lan)
#   --ifname   the tunnel interface name on the device (default per platform)
#   --out      folder for the result (default ./cctv-site-<id>-<platform>); made 0700, files 0600
#
# Every platform gets the same result as site-gateway.sh: the tunnel dials out to the hub
# (keepalive 25 s), 10.78.N.x on the CCTV server = <site LAN>.x, from the tunnel only TCP 6036 and
# ping reach the LAN, nothing from the LAN (or the device) can start a connection into the tunnel.
# The output holds the site's private key (like the bundle): copy it to the site, delete it after.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# the bundle checks are shared with the Linux gateway script (sourcing it runs nothing)
# shellcheck source=site-gateway.sh
source "$here/site-gateway.sh"
PROG=cctv-site-recipes
umask 077

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 2; }
[[ $# -ge 2 ]] || usage
BUNDLE=$1
PLATFORM=$2
shift 2
OPT_NVR=""
OPT_OUT=""
OPT_TIF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --nvr) OPT_NVR=${2:?--nvr needs a value}; shift ;;
    --lan) OPT_LAN=${2:?--lan needs a value}; shift ;;
    --lan-if) OPT_LAN_IF=${2:?--lan-if needs a value}; shift ;;
    --ifname) OPT_TIF=${2:?--ifname needs a value}; shift ;;
    --out) OPT_OUT=${2:?--out needs a value}; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
case "$PLATFORM" in mikrotik | openwrt | rutos | pfsense | opnsense | edgeos | unifi | windows | linux | all) ;; *) die "unknown platform $PLATFORM" ;; esac
command -v wg >/dev/null 2>&1 || die "needs the wg tool (wireguard-tools) to check the keys"

load_bundle "$BUNDLE"
check_bundle
[[ $S_REAL_LAN != auto ]] || die "the bundle has no REAL_LAN: give --lan <the site's /24 with the NVRs>"
[[ -z $OPT_LAN_IF ]] || is_ifname "$OPT_LAN_IF" || die "--lan-if: bad interface name"
[[ -z $OPT_TIF ]] || is_ifname "$OPT_TIF" || die "--ifname: bad interface name"
[[ $S_EP_HOST != *:* ]] || die "these recipes expect an IPv4 address or DNS name as the hub endpoint"

NVRS=() # last octets
if [[ -n $OPT_NVR ]]; then
  [[ $OPT_NVR =~ ^[0-9.,]{7,}$ ]] || die "--nvr: comma-separated IPv4 addresses"
  IFS=, read -r -a _list <<<"$OPT_NVR"
  for h in "${_list[@]}"; do
    is_ip4 "$h" || die "--nvr: not an IPv4 address: $h"
    cidr_contains "$S_REAL_LAN" "$h" || die "--nvr: $h is not in the site LAN $S_REAL_LAN"
    [[ ${h##*.} != 0 && ${h##*.} != 255 ]] || die "--nvr: $h is not a host address"
    NVRS+=("${h##*.}")
  done
fi
RB=${S_REAL_LAN%.*}  # real /24 base, e.g. 192.168.1
VB=10.78.$S_ID       # virtual /24 base

need_nvrs() { [[ ${#NVRS[@]} -gt 0 ]] || die "$1 maps NVRs one by one: give --nvr <their LAN addresses>"; }

# values for the templates (all checked above); templates are quoted heredocs, so nothing in
# them is expanded by bash: only @@NAME@@ placeholders are replaced
declare -A V=(
  [ID]=$S_ID [NAME]=$S_NAME [TIP]=$S_TUNNEL_IP [VNET]=$S_VIRTUAL [VB]=$VB [RLAN]=$S_REAL_LAN [RB]=$RB
  [HUB]=$S_HUB_IP [HUBPUB]=$S_HUB_PUB [KEY]=$S_KEY [PSK]=$S_PSK [EP]=$S_ENDPOINT [EPHOST]=$S_EP_HOST
  [EPPORT]=$S_EP_PORT [PORT]=$S_PORT [KA]=$S_KEEPALIVE [MTU]=$S_MTU [MSS]=$S_MSS [MSS1]=$((S_MSS + 1))
  [SITEPUB]=$S_PUB
)
fill() { # stdin template -> stdout
  local t k
  t=$(cat)
  for k in "${!V[@]}"; do t=${t//"@@$k@@"/"${V[$k]}"}; done
  if [[ $t =~ @@[A-Z0-9_]+@@ ]]; then die "internal: unfilled placeholder ${BASH_REMATCH[0]}"; fi
  printf '%s\n' "$t"
}
nvr_list_real() { local h o=(); for h in "${NVRS[@]}"; do o+=("$RB.$h"); done; local IFS=,; echo "${o[*]}"; }
nvr_table() { # "10.78.3.10 -> 192.168.1.10" lines
  local h
  if [[ ${#NVRS[@]} -gt 0 ]]; then
    for h in "${NVRS[@]}"; do echo "    add the NVR at $VB.$h (port $S_PORT) in the app   = $RB.$h at the site"; done
  else
    echo "    an NVR at $RB.X at the site is added in the app as $VB.X (port $S_PORT)"
  fi
}

outdir() {
  local d=${OPT_OUT:-./cctv-site-$S_ID-$1}
  [[ $PLATFORM != all || -z $OPT_OUT ]] || d=$OPT_OUT/cctv-site-$S_ID-$1
  install -d -m 700 "$d"
  printf '%s' "$d"
}

common_head() { # $1 platform title
  V[PLAT]=$1
  V[NVRTABLE]=$(nvr_table)
  V[ONLY]=$([[ ${#NVRS[@]} -gt 0 ]] && echo "only $(nvr_list_real)" || echo "the whole $S_REAL_LAN")
  fill <<'EOF'
CCTV VPN - site @@ID@@ (@@NAME@@) on @@PLAT@@
=====================================================================
This file holds the site's WireGuard private key: keep it private, delete it after the setup.
(Whoever has a copy can stand in for this site's gateway and receive the CCTV app's NVR logins.)

What this sets up
  - a WireGuard tunnel that DIALS OUT to the CCTV server at @@EP@@ (keepalive @@KA@@ s),
    so the site needs no port forwarding and may sit behind 4G / carrier NAT
  - tunnel address @@TIP@@; the only peer is the CCTV server @@HUB@@
  - the CCTV server sees this site's LAN @@RLAN@@ as @@VNET@@, host by host:
@@NVRTABLE@@
  - from the tunnel only TCP @@PORT@@ (TVT SDK) and ping reach @@ONLY@@;
    nothing else, not the router itself; nothing from the LAN can start a connection into the tunnel
  - MTU @@MTU@@ on the tunnel (4G links), TCP MSS clamped to @@MSS@@ where the device can

What the CCTV server (hub) must know about this site
  - its real LAN: @@RLAN@@ (shown next to the NVRs in the app; does not change routing)
  - its public key (already in the bundle): @@SITEPUB@@
  - nothing about the site's internet address: the site dials in

Before you go: the NVRs need FIXED addresses at the site (static, or a DHCP reservation on the
router), and if an NVR has an IP allow-list (TVT: Network > Security / IP filter) allow the
router's LAN address. A DNS name for the hub (@@EPHOST@@) must have an A record only: with an
AAAA record, a router on 4G with IPv6 may dial the IPv6 address, which the main site does not forward.

EOF
}

common_tests() {
  fill <<'EOF'

Tests
  on the CCTV server:  ping -c3 @@TIP@@                 (the site's router answers)
                       nc -zv @@VB@@.X @@PORT@@   (an NVR at @@RB@@.X: the real test)
                       ping -c3 @@VB@@.X      (answered where the recipe maps ping)
                       the app's Sites page shows the site as connected (handshake < 3 min)
  at the site:         the device's WireGuard status shows a recent handshake with the hub
                       (ping @@HUB@@ from the site is NOT answered, by design: the hub accepts
                       no new connections from sites)
  If there is no handshake: internet at the site? the hub address @@EP@@ right? The main site's
  router must forward UDP @@EPPORT@@ to the CCTV server, and the hub must have this site's key.
EOF
}

# ---------------------------------------------------------------- MikroTik RouterOS 7
gen_mikrotik() {
  local d f tif=${OPT_TIF:-wg-cctv} lan=${OPT_LAN_IF:-bridge} h dst psk="" nvrlist="" resolve=""
  d=$(outdir mikrotik)
  f=$d/cctv-site-$S_ID.rsc
  V[TIF]=$tif
  V[LANIF]=$lan
  [[ -n $S_PSK ]] && psk=" preshared-key=\"$S_PSK\""
  V[PSKOPT]=$psk
  if [[ ${#NVRS[@]} -gt 0 ]]; then
    dst='dst-address-list=cctv-vpn-nvrs'
    for h in "${NVRS[@]}"; do nvrlist+="/ip firewall address-list add list=cctv-vpn-nvrs address=$RB.$h comment=\"cctv-vpn NVR ($VB.$h)\""$'\n'; done
  else
    dst="dst-address=$S_REAL_LAN"
  fi
  V[DST]=$dst
  V[NVRLIST]=${nvrlist%$'\n'}
  if [[ $S_EP_KIND == name ]]; then
    V[EPADDR]="[:resolve \"$S_EP_HOST\"]"
    resolve=$(fill <<'EOF'
# the hub has a DNS name: look it up again every minute (RouterOS resolves it only once)
/system script add name=cctv-vpn-reresolve comment="cctv-vpn" source=":local ip [:resolve \"@@EPHOST@@\"]; :foreach p in=[/interface wireguard peers find where comment=\"cctv-vpn hub\"] do={ :if ([:tostr [/interface wireguard peers get \$p endpoint-address]] != [:tostr \$ip]) do={ /interface wireguard peers set \$p endpoint-address=\$ip } }"
/system scheduler add name=cctv-vpn-reresolve interval=1m on-event=cctv-vpn-reresolve comment="cctv-vpn"
EOF
)
  else
    V[EPADDR]=$S_EP_HOST
  fi
  V[RESOLVE]=$resolve
  fill >"$f" <<'EOF'
# CCTV VPN - site @@ID@@ (@@NAME@@) for MikroTik RouterOS 7.
#   Upload this file (Files), then in a terminal:  /import file-name=cctv-site-@@ID@@.rsc
#   Then delete it from the router: it holds the site's private key:  /file remove cctv-site-@@ID@@.rsc
# Safe to import again: it first removes what an earlier import added (everything tagged cctv-vpn).
# LAN interface: @@LANIF@@ (the default-config bridge). @@VNET@@ on the CCTV server = @@RLAN@@ here.

# ---- remove an earlier import
/system scheduler remove [find where name="cctv-vpn-reresolve"]
/system script remove [find where name="cctv-vpn-reresolve"]
/ip firewall filter remove [find where comment~"^cctv-vpn"]
/ip firewall nat remove [find where comment~"^cctv-vpn"]
/ip firewall mangle remove [find where comment~"^cctv-vpn"]
/ip firewall address-list remove [find where list="cctv-vpn-nvrs"]
/ip address remove [find where interface="@@TIF@@"]
/interface wireguard peers remove [find where interface="@@TIF@@"]
/interface wireguard remove [find where name="@@TIF@@"]

# ---- the tunnel: dials out to the CCTV server, keepalive @@KA@@ s
/interface wireguard add name=@@TIF@@ mtu=@@MTU@@ private-key="@@KEY@@" comment="cctv-vpn"
/interface wireguard peers add interface=@@TIF@@ public-key="@@HUBPUB@@"@@PSKOPT@@ endpoint-address=@@EPADDR@@ endpoint-port=@@EPPORT@@ allowed-address=@@HUB@@/32 persistent-keepalive=@@KA@@s comment="cctv-vpn hub"
/ip address add address=@@TIP@@/24 interface=@@TIF@@ comment="cctv-vpn"
@@NVRLIST@@

# ---- 1:1 map @@VNET@@ -> @@RLAN@@ (TCP @@PORT@@ and ping only) and send the NVRs' replies back here
/ip firewall nat add chain=dstnat in-interface=@@TIF@@ src-address=@@HUB@@ dst-address=@@VNET@@ protocol=tcp dst-port=@@PORT@@ action=netmap to-addresses=@@RLAN@@ comment="cctv-vpn: @@VNET@@ -> @@RLAN@@ TCP @@PORT@@"
/ip firewall nat add chain=dstnat in-interface=@@TIF@@ src-address=@@HUB@@ dst-address=@@VNET@@ protocol=icmp action=netmap to-addresses=@@RLAN@@ comment="cctv-vpn: @@VNET@@ -> @@RLAN@@ ping"
/ip firewall nat add chain=srcnat src-address=@@HUB@@ dst-address=@@RLAN@@ out-interface=@@LANIF@@ action=masquerade comment="cctv-vpn: NVRs answer the router"

# ---- fit TCP into the tunnel MTU
/ip firewall mangle add chain=forward in-interface=@@TIF@@ protocol=tcp tcp-flags=syn tcp-mss=@@MSS1@@-65535 action=change-mss new-mss=@@MSS@@ passthrough=yes comment="cctv-vpn: MSS"
/ip firewall mangle add chain=forward out-interface=@@TIF@@ protocol=tcp tcp-flags=syn tcp-mss=@@MSS1@@-65535 action=change-mss new-mss=@@MSS@@ passthrough=yes comment="cctv-vpn: MSS"

# ---- filter: own chains, jumped to from the top of input/forward (before fasttrack)
/ip firewall filter add chain=cctv-vpn-in connection-state=established,related action=accept comment="cctv-vpn"
/ip firewall filter add chain=cctv-vpn-in src-address=@@HUB@@ protocol=icmp icmp-options=8:0 action=accept comment="cctv-vpn: the hub may ping the router"
/ip firewall filter add chain=cctv-vpn-in action=drop comment="cctv-vpn: nothing else from the tunnel to the router"
/ip firewall filter add chain=cctv-vpn-fwd-in connection-state=established,related action=accept comment="cctv-vpn"
/ip firewall filter add chain=cctv-vpn-fwd-in connection-state=new connection-nat-state=dstnat src-address=@@HUB@@ @@DST@@ out-interface=@@LANIF@@ protocol=tcp dst-port=@@PORT@@ action=accept comment="cctv-vpn: hub -> NVRs TCP @@PORT@@"
/ip firewall filter add chain=cctv-vpn-fwd-in connection-state=new connection-nat-state=dstnat src-address=@@HUB@@ @@DST@@ out-interface=@@LANIF@@ protocol=icmp icmp-options=8:0 action=accept comment="cctv-vpn: hub -> NVRs ping"
/ip firewall filter add chain=cctv-vpn-fwd-in action=drop comment="cctv-vpn: nothing else from the tunnel"
/ip firewall filter add chain=cctv-vpn-fwd-out connection-state=established,related action=accept comment="cctv-vpn"
/ip firewall filter add chain=cctv-vpn-fwd-out action=drop comment="cctv-vpn: nothing from the LAN into the tunnel"
:if ([:len [/ip firewall filter find where chain="input" or chain="forward"]] = 0) do={
  /ip firewall filter add chain=input in-interface=@@TIF@@ action=jump jump-target=cctv-vpn-in comment="cctv-vpn"
  /ip firewall filter add chain=forward in-interface=@@TIF@@ action=jump jump-target=cctv-vpn-fwd-in comment="cctv-vpn"
  /ip firewall filter add chain=forward out-interface=@@TIF@@ action=jump jump-target=cctv-vpn-fwd-out comment="cctv-vpn"
} else={
  /ip firewall filter add chain=input in-interface=@@TIF@@ action=jump jump-target=cctv-vpn-in comment="cctv-vpn" place-before=[:pick [/ip firewall filter find where chain="input" or chain="forward"] 0]
  /ip firewall filter add chain=forward in-interface=@@TIF@@ action=jump jump-target=cctv-vpn-fwd-in comment="cctv-vpn" place-before=[:pick [/ip firewall filter find where chain="input" or chain="forward"] 0]
  /ip firewall filter add chain=forward out-interface=@@TIF@@ action=jump jump-target=cctv-vpn-fwd-out comment="cctv-vpn" place-before=[:pick [/ip firewall filter find where chain="input" or chain="forward"] 0]
}
@@RESOLVE@@
:put "cctv-vpn: site @@ID@@ set up. Check: /interface wireguard peers print detail  (last-handshake)"
EOF
  sed -n '/^# ---- remove an earlier import$/,/^$/p' "$f" | sed '1s/.*/# CCTV VPN - remove site @@ID@@ from this router (everything tagged cctv-vpn)/' | fill >"$d/cctv-site-$S_ID-remove.rsc"
  {
    common_head "MikroTik RouterOS 7"
    fill <<'EOF'
Bring: an admin login to the router (WinBox or SSH), this folder on a laptop, the NVR addresses.
Needs RouterOS 7.x (WireGuard arrived in 7.1). 4G models (Chateau, LtAP, wAP LTE) work the same.

Steps
  1. WinBox > Files: upload cctv-site-@@ID@@.rsc (or scp it to the router).
  2. Terminal:  /import file-name=cctv-site-@@ID@@.rsc     (prints "cctv-vpn: site @@ID@@ set up")
  3. Terminal:  /file remove cctv-site-@@ID@@.rsc          (it holds the private key)
  4. Check:     /interface wireguard peers print detail    -> last-handshake a few seconds
                /ip firewall filter print stats where comment~"cctv-vpn"
  The LAN interface is assumed to be "@@LANIF@@"; if yours differs, run site-recipes.sh again
  with --lan-if <name>. If the import says the listen port is in use, add listen-port=<free UDP
  port> to the "/interface wireguard add" line (the site only dials out; any port works).
  Remove it all: upload cctv-site-@@ID@@-remove.rsc, then /import file-name=cctv-site-@@ID@@-remove.rsc
Docs: https://help.mikrotik.com/docs/spaces/ROS/pages/69664792/WireGuard
      https://help.mikrotik.com/docs/spaces/ROS/pages/3211299/NAT (action=netmap)
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

# ---------------------------------------------------------------- OpenWrt 22.03+ (fw4 / nftables)
gen_openwrt() {
  local d f tif=${OPT_TIF:-cctv} zone=${OPT_LAN_IF:-lan} h dests="" psk="" watchdog=""
  d=$(outdir openwrt)
  f=$d/cctv-site-$S_ID-openwrt.sh
  V[TIF]=$tif
  V[LANZONE]=$zone
  [[ -n $S_PSK ]] && psk="uci set network.${tif}_hub.preshared_key='$S_PSK'"
  V[PSKLINE]=${psk:-# (no preshared key in this bundle)}
  if [[ ${#NVRS[@]} -gt 0 ]]; then
    for h in "${NVRS[@]}"; do dests+="uci add_list firewall.${tif}_nvr.dest_ip='$RB.$h'"$'\n'"uci add_list firewall.${tif}_nvr_ping.dest_ip='$RB.$h'"$'\n'; done
  else
    dests="uci add_list firewall.${tif}_nvr.dest_ip='$S_REAL_LAN'"$'\n'"uci add_list firewall.${tif}_nvr_ping.dest_ip='$S_REAL_LAN'"$'\n'
  fi
  V[DESTS]=${dests%$'\n'}
  if [[ $S_EP_KIND == name ]]; then
    watchdog="grep -q wireguard_watchdog /etc/crontabs/root 2>/dev/null || echo '* * * * * /usr/bin/wireguard_watchdog' >>/etc/crontabs/root
/etc/init.d/cron enable
/etc/init.d/cron restart"
  fi
  V[WATCHDOG]=${watchdog:-# (the hub has a fixed IP address: no DNS watchdog needed)}
  fill >"$f" <<'EOF'
#!/bin/sh
# CCTV VPN - site @@ID@@ (@@NAME@@) for OpenWrt 19.07 or newer: firewall4 (nftables, 22.03 and
# newer) or firewall3 (iptables, 19.07 and 21.02); the script finds out which.
# Run on the router:  sh cctv-site-@@ID@@-openwrt.sh     then delete this file (it holds the key).
# Safe to run again. @@VNET@@ on the CCTV server = @@RLAN@@ here (1:1, TCP @@PORT@@ + ping only).
set -e
[ -f /etc/openwrt_release ] || { echo "not OpenWrt"; exit 1; }
. /etc/openwrt_release
if command -v fw4 >/dev/null 2>&1; then FW=fw4
elif command -v fw3 >/dev/null 2>&1; then
  FW=fw3
  major=${DISTRIB_RELEASE%%.*}
  case $major in
    '' | *[!0-9]*) ;;
    *) [ "$major" -ge 19 ] || { echo "OpenWrt $DISTRIB_RELEASE: needs 19.07 or newer (WireGuard)"; exit 1; } ;;
  esac
else
  echo "neither firewall4 nor firewall3 found: see README.txt"; exit 1
fi
echo "cctv-vpn: OpenWrt ${DISTRIB_RELEASE:-?} with $FW"
need=""
command -v wg >/dev/null 2>&1 || need="wireguard-tools kmod-wireguard luci-proto-wireguard"
# firewall3 maps the NVR range with iptables NETMAP (kernel module in kmod-ipt-nat-extra)
if [ $FW = fw3 ] && ! opkg list-installed 2>/dev/null | grep -q '^iptables-mod-nat-extra '; then need="$need iptables-mod-nat-extra"; fi
if [ -n "$need" ]; then
  if command -v apk >/dev/null 2>&1; then apk update && apk add $need
  else opkg update && opkg install $need; fi
fi

# ---- remove an earlier run
for s in network.@@TIF@@ network.@@TIF@@_hub firewall.@@TIF@@ firewall.@@TIF@@_nvr firewall.@@TIF@@_nvr_ping firewall.@@TIF@@_ping firewall.@@TIF@@_inc; do
  uci -q delete "$s" || true
done

# ---- the tunnel: dials out to the CCTV server
uci set network.@@TIF@@=interface
uci set network.@@TIF@@.proto='wireguard'
uci set network.@@TIF@@.private_key='@@KEY@@'
uci add_list network.@@TIF@@.addresses='@@TIP@@/32'
uci set network.@@TIF@@.mtu='@@MTU@@'
uci set network.@@TIF@@_hub=wireguard_@@TIF@@
uci set network.@@TIF@@_hub.description='CCTV hub'
uci set network.@@TIF@@_hub.public_key='@@HUBPUB@@'
@@PSKLINE@@
uci set network.@@TIF@@_hub.endpoint_host='@@EPHOST@@'
uci set network.@@TIF@@_hub.endpoint_port='@@EPPORT@@'
uci set network.@@TIF@@_hub.persistent_keepalive='@@KA@@'
uci set network.@@TIF@@_hub.route_allowed_ips='1'
uci add_list network.@@TIF@@_hub.allowed_ips='@@HUB@@/32'

# ---- its own firewall zone: nothing in, nothing through, except the rules below
uci set firewall.@@TIF@@=zone
uci set firewall.@@TIF@@.name='@@TIF@@'
uci add_list firewall.@@TIF@@.network='@@TIF@@'
uci set firewall.@@TIF@@.input='DROP'
uci set firewall.@@TIF@@.output='ACCEPT'
uci set firewall.@@TIF@@.forward='DROP'
# (after the 1:1 map, so these name the REAL addresses)
uci set firewall.@@TIF@@_nvr=rule
uci set firewall.@@TIF@@_nvr.name='cctv-vpn: hub to NVRs TCP @@PORT@@'
uci set firewall.@@TIF@@_nvr.src='@@TIF@@'
uci set firewall.@@TIF@@_nvr.src_ip='@@HUB@@'
uci set firewall.@@TIF@@_nvr.dest='@@LANZONE@@'
uci set firewall.@@TIF@@_nvr.proto='tcp'
uci set firewall.@@TIF@@_nvr.dest_port='@@PORT@@'
uci set firewall.@@TIF@@_nvr.target='ACCEPT'
uci set firewall.@@TIF@@_nvr_ping=rule
uci set firewall.@@TIF@@_nvr_ping.name='cctv-vpn: hub pings NVRs'
uci set firewall.@@TIF@@_nvr_ping.src='@@TIF@@'
uci set firewall.@@TIF@@_nvr_ping.src_ip='@@HUB@@'
uci set firewall.@@TIF@@_nvr_ping.dest='@@LANZONE@@'
uci set firewall.@@TIF@@_nvr_ping.proto='icmp'
uci add_list firewall.@@TIF@@_nvr_ping.icmp_type='echo-request'
uci set firewall.@@TIF@@_nvr_ping.target='ACCEPT'
@@DESTS@@
uci set firewall.@@TIF@@_ping=rule
uci set firewall.@@TIF@@_ping.name='cctv-vpn: hub pings the router'
uci set firewall.@@TIF@@_ping.src='@@TIF@@'
uci set firewall.@@TIF@@_ping.src_ip='@@HUB@@'
uci set firewall.@@TIF@@_ping.proto='icmp'
uci add_list firewall.@@TIF@@_ping.icmp_type='echo-request'
uci set firewall.@@TIF@@_ping.target='ACCEPT'

# ---- 1:1 map + masquerade + MSS
if [ $FW = fw4 ]; then
# fw4 includes /etc/nftables.d/*.nft inside table inet fw4
rm -f /etc/firewall.cctv-vpn
mkdir -p /etc/nftables.d
cat >/etc/nftables.d/50-cctv-vpn.nft <<'NFT'
# CCTV VPN site @@ID@@: @@VNET@@ (CCTV server) -> @@RLAN@@ (this LAN), TCP @@PORT@@ + ping only
chain cctv_vpn_dstnat {
	type nat hook prerouting priority dstnat - 5; policy accept;
	iifname "@@TIF@@" ip saddr @@HUB@@ ip daddr @@VNET@@ tcp dport @@PORT@@ dnat ip prefix to ip daddr map { @@VNET@@ : @@RLAN@@ }
	iifname "@@TIF@@" ip saddr @@HUB@@ ip daddr @@VNET@@ icmp type echo-request dnat ip prefix to ip daddr map { @@VNET@@ : @@RLAN@@ }
}
chain cctv_vpn_srcnat {
	type nat hook postrouting priority srcnat - 5; policy accept;
	ip saddr @@HUB@@ ip daddr @@RLAN@@ ct status dnat masquerade comment "NVRs answer the router"
}
chain cctv_vpn_mss {
	type filter hook forward priority mangle; policy accept;
	iifname "@@TIF@@" tcp flags & (syn | rst) == syn tcp option maxseg size > @@MSS@@ tcp option maxseg size set @@MSS@@
	oifname "@@TIF@@" tcp flags & (syn | rst) == syn tcp option maxseg size > @@MSS@@ tcp option maxseg size set @@MSS@@
}
NFT
grep -qx /etc/nftables.d/50-cctv-vpn.nft /etc/sysupgrade.conf 2>/dev/null || echo /etc/nftables.d/50-cctv-vpn.nft >>/etc/sysupgrade.conf
else
# fw3: the same map with iptables, from a script fw3 runs at every firewall start and reload
cat >/etc/firewall.cctv-vpn <<'FW3'
# CCTV VPN site @@ID@@ (firewall3): @@VNET@@ (CCTV server) -> @@RLAN@@ (this LAN), TCP @@PORT@@ + ping only.
# Run by fw3 (include @@TIF@@_inc) at every firewall start and reload; safe to run again.
for c in nat:cctv_vpn_pre nat:cctv_vpn_post mangle:cctv_vpn_mss; do
  iptables -t "${c%%:*}" -N "${c#*:}" 2>/dev/null || iptables -t "${c%%:*}" -F "${c#*:}"
done
iptables -t nat -C PREROUTING -j cctv_vpn_pre 2>/dev/null || iptables -t nat -I PREROUTING -j cctv_vpn_pre
iptables -t nat -C POSTROUTING -j cctv_vpn_post 2>/dev/null || iptables -t nat -I POSTROUTING -j cctv_vpn_post
iptables -t mangle -C FORWARD -j cctv_vpn_mss 2>/dev/null || iptables -t mangle -I FORWARD -j cctv_vpn_mss
iptables -t nat -A cctv_vpn_pre -i @@TIF@@ -s @@HUB@@ -d @@VNET@@ -p tcp --dport @@PORT@@ -j NETMAP --to @@RLAN@@
iptables -t nat -A cctv_vpn_pre -i @@TIF@@ -s @@HUB@@ -d @@VNET@@ -p icmp --icmp-type echo-request -j NETMAP --to @@RLAN@@
iptables -t nat -A cctv_vpn_post -s @@HUB@@ -d @@RLAN@@ -m conntrack --ctstate DNAT -j MASQUERADE
# the NVRs' answers into the tunnel: MSS from the tunnel's MTU (@@MTU@@ -> @@MSS@@); the hub clamps its own
iptables -t mangle -A cctv_vpn_mss -o @@TIF@@ -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
FW3
uci set firewall.@@TIF@@_inc=include
uci set firewall.@@TIF@@_inc.path='/etc/firewall.cctv-vpn'
uci set firewall.@@TIF@@_inc.type='script'
uci set firewall.@@TIF@@_inc.reload='1'
grep -qx /etc/firewall.cctv-vpn /etc/sysupgrade.conf 2>/dev/null || echo /etc/firewall.cctv-vpn >>/etc/sysupgrade.conf
fi

@@WATCHDOG@@

uci commit network
uci commit firewall
/etc/init.d/network reload
/etc/init.d/firewall reload
sleep 5
if [ $FW = fw3 ] && ! iptables -t nat -S cctv_vpn_pre 2>/dev/null | grep -q NETMAP; then
  echo "cctv-vpn: the NVR map is not loaded (iptables NETMAP): check that iptables-mod-nat-extra installed, then /etc/init.d/firewall reload"
  exit 1
fi
echo "cctv-vpn: site @@ID@@ set up. Check: wg show @@TIF@@   (latest handshake)"
wg show @@TIF@@ latest-handshakes || true
EOF
  fill >"$d/cctv-site-$S_ID-openwrt-remove.sh" <<'EOF'
#!/bin/sh
# CCTV VPN - remove site @@ID@@ from this OpenWrt router.
for s in network.@@TIF@@ network.@@TIF@@_hub firewall.@@TIF@@ firewall.@@TIF@@_nvr firewall.@@TIF@@_nvr_ping firewall.@@TIF@@_ping firewall.@@TIF@@_inc; do
  uci -q delete "$s" || true
done
uci commit network
uci commit firewall
rm -f /etc/nftables.d/50-cctv-vpn.nft /etc/firewall.cctv-vpn
sed -i '\#^/etc/nftables.d/50-cctv-vpn.nft$#d; \#^/etc/firewall.cctv-vpn$#d' /etc/sysupgrade.conf 2>/dev/null || true
sed -i '/wireguard_watchdog/d' /etc/crontabs/root 2>/dev/null || true
# firewall3: its reload leaves chains it did not make, so take the map's out by hand
if ! command -v fw4 >/dev/null 2>&1 && command -v iptables >/dev/null 2>&1; then
  for c in nat:PREROUTING:cctv_vpn_pre nat:POSTROUTING:cctv_vpn_post mangle:FORWARD:cctv_vpn_mss; do
    t=${c%%:*}; rest=${c#*:}; from=${rest%%:*}; chain=${rest#*:}
    while iptables -t "$t" -D "$from" -j "$chain" 2>/dev/null; do :; done
    iptables -t "$t" -F "$chain" 2>/dev/null || true
    iptables -t "$t" -X "$chain" 2>/dev/null || true
  done
fi
/etc/init.d/network reload
/etc/init.d/firewall reload
echo "cctv-vpn: site @@ID@@ removed"
EOF
  {
    common_head "OpenWrt 19.07 or newer (firewall3 or firewall4)"
    fill <<'EOF'
Bring: SSH (or LuCI) admin access to the router, this folder, internet at the site (the script
installs wireguard-tools / kmod-wireguard / luci-proto-wireguard if missing, and on firewall3
also iptables-mod-nat-extra). Which version the router runs does not matter: the script checks.
  Not sure which OpenWrt it is?  cat /etc/openwrt_release   (or LuCI: Status > Overview)

Steps
  1. Copy the script:   scp -O cctv-site-@@ID@@-openwrt.sh root@<router>:/tmp/
     (OpenWrt 19.07/21.02 has no -O: scp cctv-site-@@ID@@-openwrt.sh root@<router>:/tmp/)
  2. On the router:     sh /tmp/cctv-site-@@ID@@-openwrt.sh && rm /tmp/cctv-site-@@ID@@-openwrt.sh
     The first line it prints says what it found, e.g. "OpenWrt 21.02.7 with fw3".
  3. Check:             wg show @@TIF@@
       22.03 and newer (fw4):       nft list chain inet fw4 cctv_vpn_dstnat
       19.07 and 21.02 (fw3):       iptables -t nat -S cctv_vpn_pre
  The LAN zone is assumed to be "@@LANZONE@@" (run site-recipes.sh with --lan-if <zone> otherwise).
  The tunnel and rules show in LuCI (Network > Interfaces "@@TIF@@", Network > Firewall).
  The 1:1 map lives in /etc/nftables.d/50-cctv-vpn.nft (fw4) or /etc/firewall.cctv-vpn (fw3,
  run by the firewall at every start and reload); both are kept over sysupgrade.
  Upgrading a router from 21.02 to 22.03 or newer: run the script again afterwards.
  Remove:  sh cctv-site-@@ID@@-openwrt-remove.sh   (on the router)
  OpenWrt 18.06 or older: upgrade first (no WireGuard package there).
Docs: https://openwrt.org/docs/guide-user/services/vpn/wireguard/client
      https://openwrt.org/docs/guide-user/firewall/firewall_configuration (includes, /etc/nftables.d)
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

# ---------------------------------------------------------------- Teltonika RutOS
gen_rutos() {
  local d tif=${OPT_TIF:-cctv} h fw="" rules=""
  d=$(outdir rutos)
  V[TIF]=$tif
  if [[ ${#NVRS[@]} -gt 0 ]]; then
    local n=1
    for h in "${NVRS[@]}"; do
      fw+="     Port forward $n: Name cctv-nvr-$h, Protocol TCP, Source zone $tif, Source IP $S_HUB_IP,"$'\n'
      fw+="       External IP $VB.$h, External port $S_PORT, Internal zone lan, Internal IP $RB.$h, Internal port $S_PORT"$'\n'
      n=$((n + 1))
    done
  else
    fw="     (run site-recipes.sh with --nvr <NVR addresses> to list one port forward per NVR)"$'\n'
  fi
  V[PORTFWDS]=${fw%$'\n'}
  if [[ $S_EP_KIND == name ]]; then
    reresolve_script >"$d/cctv-vpn-reresolve.sh"
    V[DNSSTEP]=$(fill <<'EOF'
7. The hub has a DNS name, and RutOS resolves it only when the instance starts. So that the site
   follows a change of the main site's public address by itself, over SSH (root) on the router:
     scp cctv-vpn-reresolve.sh root@<router>:/etc/cctv-vpn-reresolve.sh   (from this folder)
     chmod 700 /etc/cctv-vpn-reresolve.sh
     echo '* * * * * /etc/cctv-vpn-reresolve.sh' >>/etc/crontabs/root && /etc/init.d/cron restart
   It looks the name up again (IPv4 only) once the tunnel has been silent for 150 s. "wg show" must
   list the tunnel as "@@TIF@@" (else change IF= in the script). A firmware upgrade may drop
   /etc/crontabs/root: check it after upgrades.
EOF
)
  else
    V[DNSSTEP]="7. The hub has a fixed IP address: nothing to follow up."
  fi
  {
    common_head "Teltonika RutOS (RUT/RUTX/RUTM/TRB)"
    fill <<'EOF'
RutOS has WireGuard built in (Services > VPN > WireGuard, no package). Two ways to map the NVRs:
  A. one Port forward per NVR in the WebUI: no package, survives firmware upgrades (recommended)
  B. one NETMAP custom rule for the whole /24: needs the "IPtables NAT extra" package
     (System > Package Manager); after a firmware upgrade the rule can load before the package
     is back (seen on RUT9M 7.13), so re-check after upgrades
Bring: WebUI admin login, this folder, the NVR addresses, internet at the site.

1. Services > VPN > WireGuard: add instance "@@TIF@@", then edit it
     General: Enable on; Private key: paste the key below (do not click Generate);
              IP addresses: @@TIP@@/32
     Advanced: MTU @@MTU@@ (leave Listen port as it is)
     Private key:  @@KEY@@
2. Same page, Peers: add "cctvhub"
     Public key: @@HUBPUB@@
     Endpoint host: @@EPHOST@@    Endpoint port: @@EPPORT@@
     Allowed IPs: @@HUB@@/32      Route allowed IPs: on
     Persistent keepalive: @@KA@@ (Advanced)    Preshared key: only if site.psk is in the bundle
3. Network > Firewall > General settings, Zones: the zone that holds "@@TIF@@" (create zone
   "@@TIF@@" for it if RutOS did not): Input Drop, Output Accept, Forward Drop; NO forwarding
   from it to lan or wan (and no masquerading on it).
   Network > Firewall > Traffic rules: add "cctv-vpn ping": source zone @@TIF@@, source IP @@HUB@@,
   protocol ICMP, ICMP type echo-request, destination zone Device (input), action Accept (the
   hub pings the tunnel when it is idle, so that the session is renewed in time).
4. Network > Firewall > Port forwards (A), one per NVR (Advanced settings hold Source IP and
   External IP):
@@PORTFWDS@@
   RutOS accepts forwarded traffic of a port forward itself; nothing else passes from the tunnel.
   (Port forwards carry TCP only: ping to @@VB@@.x is not answered; test with nc -zv.)
   The NVRs' replies go to their default gateway = this router, which sends them back into the
   tunnel. If an NVR's gateway is NOT this router, add (Network > Firewall > NAT rules or custom
   rules):  iptables -t nat -I POSTROUTING -s @@HUB@@ -d @@RLAN@@ -o br-lan -j MASQUERADE
5. (B instead of 4) Network > Firewall > Custom rules, after installing "IPtables NAT extra":
     iptables -t nat -I PREROUTING -i @@TIF@@ -s @@HUB@@ -d @@VNET@@ -p tcp --dport @@PORT@@ -j NETMAP --to @@RLAN@@
     iptables -t nat -I PREROUTING -i @@TIF@@ -s @@HUB@@ -d @@VNET@@ -p icmp --icmp-type echo-request -j NETMAP --to @@RLAN@@
     iptables -t nat -I POSTROUTING -s @@HUB@@ -d @@RLAN@@ -o br-lan -j MASQUERADE
     iptables -I FORWARD -i @@TIF@@ -s @@HUB@@ -d @@RLAN@@ -p tcp --dport @@PORT@@ -m conntrack --ctstate DNAT -j ACCEPT
     iptables -I FORWARD -i @@TIF@@ -s @@HUB@@ -d @@RLAN@@ -p icmp --icmp-type echo-request -m conntrack --ctstate DNAT -j ACCEPT
   (the zone's Forward Drop still drops everything else from the tunnel)
6. Check: Services > VPN > WireGuard shows the peer's latest handshake; Status > Network.
@@DNSSTEP@@
Docs: https://wiki.teltonika-networks.com/view/WireGuard_Configuration_Example
      https://wiki.teltonika-networks.com/view/RUTX_1-to-1_NAT
      https://community.teltonika.lt/t/iptables-nat-extra-package-does-not-reload-firewall-custom-rules/13494
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

# ---------------------------------------------------------------- pfSense / OPNsense
gen_pfsense() {
  local d
  d=$(outdir pfsense)
  V[NVRRULE]=$([[ ${#NVRS[@]} -gt 0 ]] && echo "an alias CCTV_NVRS (Firewall > Aliases, Hosts: $(nvr_list_real))" || echo "network $S_REAL_LAN")
  {
    common_head "pfSense (CE 2.7+ / Plus 23+)"
    fill <<'EOF'
Bring: WebGUI admin login, this folder, internet at the site (package install).

1. System > Package Manager > Available Packages: install "WireGuard".
2. VPN > WireGuard > Tunnels > Add Tunnel
     Enabled: yes   Description: cctv-vpn   Listen Port: 51820 (any free port; the site only dials out)
     Interface Keys: paste the private key (the public key must then show @@SITEPUB@@)
       Private key:  @@KEY@@
     Save. Then Peers > Add Peer
     Tunnel: the cctv-vpn tunnel   Description: CCTV hub   Dynamic Endpoint: unchecked
     Endpoint: @@EPHOST@@   Endpoint Port: @@EPPORT@@   Keep Alive: @@KA@@
     Public Key: @@HUBPUB@@   Pre-shared Key: only if site.psk is in the bundle
     Allowed IPs: @@HUB@@/32
   VPN > WireGuard > Settings: Enable WireGuard.
3. Interfaces > Assignments: add the tun_wg device, open it: Enable; Description CCTVVPN;
   IPv4 Configuration Type Static IPv4; IPv4 Address @@TIP@@/24; MTU @@MTU@@; MSS @@MSS@@.
4. Firewall > NAT > 1:1 > Add
     Interface: CCTVVPN   External subnet IP: @@VB@@.0
     Internal IP: Network @@RLAN@@   Destination: Any   NAT reflection: Disable
   (1:1 maps the whole /24 host by host; the rules in step 5 limit what passes)
5. Firewall > Rules > CCTVVPN (NAT happens first, so rules name the REAL addresses):
     Pass  IPv4 TCP   source @@HUB@@   destination @@NVRRULE@@  port @@PORT@@
     Pass  IPv4 ICMP echo request   source @@HUB@@   destination the same
     Pass  IPv4 ICMP echo request   source @@HUB@@   destination CCTVVPN address (the hub pings
           the tunnel when it is idle, so that the session is renewed in time)
     nothing else (the default blocks the rest). On the "WireGuard" group tab: NO rules
     (a pass rule there would open the tunnel to everything).
   Firewall > Rules > LAN, at the top: Block IPv4 any, source LAN net, destination @@HUB@@
   (keeps LAN devices from starting connections to the CCTV server through the tunnel).
6. Replies: pfSense is normally the NVRs' default gateway, so replies return by themselves. If
   an NVR's gateway is something else: Firewall > NAT > Outbound: Hybrid, add a mapping
   Interface LAN, Source @@HUB@@/32, Destination @@RLAN@@, Translation Interface Address.
7. Check: Status > WireGuard (handshake), Diagnostics > States.
   The hub has a DNS name? pfSense looks endpoint names up again every 300 s by default
   (VPN > WireGuard > Settings: Endpoint Hostname Resolve Interval): leave that on. The name must
   have an A record only (with an AAAA record pfSense may dial IPv6, which the main site does not forward).
Docs: https://docs.netgate.com/pfsense/en/latest/recipes/wireguard-s2s.html
      https://docs.netgate.com/pfsense/en/latest/nat/1-1.html
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}
gen_opnsense() {
  local d
  d=$(outdir opnsense)
  V[NVRRULE]=$([[ ${#NVRS[@]} -gt 0 ]] && echo "an alias CCTV_NVRS (Firewall > Aliases, Hosts: $(nvr_list_real))" || echo "network $S_REAL_LAN")
  {
    common_head "OPNsense 24.1+"
    fill <<'EOF'
WireGuard is built into OPNsense since 24.1 (older: install the os-wireguard plugin).
Bring: WebGUI admin login, this folder.

1. VPN > WireGuard > Instances > +
     Enabled; Name: cctv; Private key: paste it (Public key must show @@SITEPUB@@)
       Private key:  @@KEY@@
     Listen port: any free port (the site only dials out); MTU @@MTU@@; Tunnel address @@TIP@@/24
   VPN > WireGuard > Peers > +
     Enabled; Name: cctv-hub; Public key: @@HUBPUB@@; Pre-shared key: only if site.psk exists
     Allowed IPs: @@HUB@@/32; Endpoint address: @@EPHOST@@; Endpoint port: @@EPPORT@@
     Instances: cctv; Keepalive interval: @@KA@@
   Back in Instances: Peers = cctv-hub. VPN > WireGuard > General: Enable WireGuard. Apply.
2. Interfaces > Assignments: assign the wg device of "cctv" as CCTVVPN, enable it, MTU @@MTU@@,
   MSS @@MSS@@ (no IP settings: the instance sets the address).
3. Firewall > NAT > One-to-One > +
     Interface CCTVVPN; Type BINAT; External network @@VB@@.0; Source: @@RLAN@@;
     Destination: any; NAT reflection: disable
4. Firewall > Rules > CCTVVPN (rules name the REAL addresses; NAT happens first):
     Pass TCP  source @@HUB@@  destination @@NVRRULE@@  port @@PORT@@
     Pass ICMP (echo request)  source @@HUB@@  destination the same
     Pass ICMP (echo request)  source @@HUB@@  destination CCTVVPN address (the hub pings the
       tunnel when it is idle, so that the session is renewed in time)
   Firewall > Rules > WireGuard (Group): NO pass rules there.
   Firewall > Rules > LAN, at the top: Block, source LAN net, destination @@HUB@@.
5. Replies return by themselves when OPNsense is the NVRs' gateway; otherwise
   Firewall > NAT > Outbound: Hybrid, rule Interface LAN, Source @@HUB@@/32, Destination @@RLAN@@,
   Translation Interface address.
6. Check: VPN > WireGuard > Status (handshake).
7. The hub has a DNS name? OPNsense resolves it when the instance starts. So that the site follows
   a change of the main site's address: System > Settings > Cron > +, Command "Renew DNS for
   WireGuard on stale connections", Minutes */5, Hours *, save and apply. The name must have an
   A record only (with an AAAA record OPNsense may dial IPv6, which the main site does not forward).
Docs: https://docs.opnsense.org/manual/how-tos/wireguard-s2s.html
      https://docs.opnsense.org/releases/CE_24.1.html (WireGuard in core)
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

# ---------------------------------------------------------------- follow a DNS hub name (routers without it)
# a small sh script for routers that resolve the hub name only once (EdgeOS, RutOS): when the
# tunnel has been silent for 150 s, look the name up again (IPv4 only) and give wg the address
reresolve_script() { # needs V[TIF]
  fill <<'EOF'
#!/bin/sh
# CCTV VPN site @@ID@@: follow the hub's DNS name (A record) when the tunnel has been silent 150 s
IF='@@TIF@@'
PEER='@@HUBPUB@@'
HOST='@@EPHOST@@'
PORT='@@EPPORT@@'
t=$(wg show "$IF" latest-handshakes 2>/dev/null | awk -v k="$PEER" '$1 == k {print $2}')
now=$(date +%s)
[ -n "$t" ] && [ "$t" -gt 0 ] && [ $((now - t)) -lt 150 ] && exit 0
ip=$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1; exit}')
[ -n "$ip" ] || ip=$(nslookup "$HOST" 2>/dev/null | awk '/^Name:/ {n = 1; next} n && /^Address/ {for (i = 2; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {print $i; exit}}')
[ -n "$ip" ] || exit 0
cur=$(wg show "$IF" endpoints 2>/dev/null | awk -v k="$PEER" '$1 == k {print $2}')
[ "$cur" = "$ip:$PORT" ] && exit 0
wg set "$IF" peer "$PEER" endpoint "$ip:$PORT" && logger -t cctv-vpn "hub $HOST now $ip:$PORT (was $cur)"
EOF
}

# ---------------------------------------------------------------- Ubiquiti EdgeOS (EdgeRouter)
# Rule numbers are fixed per NVR (its last octet x) in ranges that are unlikely to be in use:
#   destination NAT (EdgeOS: 1-4999)     4400+x  TCP to NVR .x      4700+x  ping to NVR .x
#   source NAT      (EdgeOS: 5000-9999)  7400    masquerade towards the LAN
EDGE_TCP=4400
EDGE_PING=4700
EDGE_MASQ=7400
gen_edgeos() {
  need_nvrs edgeos
  local d tif=${OPT_TIF:-wg77} lan=${OPT_LAN_IF:-switch0} h t p nat="" rmnat="" grp="" psk="" re="" task="" rmtask=""
  [[ $tif =~ ^wg[0-9]{1,3}$ ]] || die "edgeos: --ifname must be wgN (EdgeOS names WireGuard interfaces wg0, wg1, ...)"
  d=$(outdir edgeos)
  V[TIF]=$tif
  V[LANIF]=$lan
  V[MASQ]=$EDGE_MASQ
  for h in "${NVRS[@]}"; do
    t=$((EDGE_TCP + h))
    p=$((EDGE_PING + h))
    re+="$t|$p|"
    grp+="set firewall group address-group CCTV_NVRS address $RB.$h"$'\n'
    rmnat+="delete service nat rule $t"$'\n'"delete service nat rule $p"$'\n'
    nat+="delete service nat rule $t"$'\n'
    nat+="set service nat rule $t description 'cctv-vpn: $VB.$h -> $RB.$h TCP $S_PORT'"$'\n'
    nat+="set service nat rule $t type destination"$'\n'
    nat+="set service nat rule $t inbound-interface $tif"$'\n'
    nat+="set service nat rule $t protocol tcp"$'\n'
    nat+="set service nat rule $t source address $S_HUB_IP"$'\n'
    nat+="set service nat rule $t destination address $VB.$h"$'\n'
    nat+="set service nat rule $t destination port $S_PORT"$'\n'
    nat+="set service nat rule $t inside-address address $RB.$h"$'\n'
    nat+="set service nat rule $t inside-address port $S_PORT"$'\n'
    nat+="delete service nat rule $p"$'\n'
    nat+="set service nat rule $p description 'cctv-vpn: $VB.$h -> $RB.$h ping'"$'\n'
    nat+="set service nat rule $p type destination"$'\n'
    nat+="set service nat rule $p inbound-interface $tif"$'\n'
    nat+="set service nat rule $p protocol icmp"$'\n'
    nat+="set service nat rule $p source address $S_HUB_IP"$'\n'
    nat+="set service nat rule $p destination address $VB.$h"$'\n'
    nat+="set service nat rule $p inside-address address $RB.$h"$'\n'
  done
  V[RULES_RE]="${re}$EDGE_MASQ"
  V[GROUP]=${grp%$'\n'}
  V[NATRULES]=${nat%$'\n'}
  V[RMNAT]=${rmnat%$'\n'}
  [[ -n $S_PSK ]] && psk="set interfaces wireguard @@TIF@@ peer @@HUBPUB@@ preshared-key /config/auth/cctv-vpn.psk"
  V[PSKLINE]=$(fill <<<"${psk:-# (no preshared key in this bundle)}")
  if [[ $S_EP_KIND == name ]]; then
    reresolve_script >"$d/cctv-vpn-reresolve.sh"
    task="set system task-scheduler task cctv-vpn-reresolve executable path /config/scripts/cctv-vpn-reresolve.sh"$'\n'
    task+="set system task-scheduler task cctv-vpn-reresolve interval 1m"
    rmtask="delete system task-scheduler task cctv-vpn-reresolve"
  fi
  V[TASK]=${task:-# (the hub has a fixed IP address: no DNS follow-up needed)}
  V[RMTASK]=${rmtask:-# (no DNS follow-up task)}
  printf '%s\n' "$S_KEY" >"$d/cctv-vpn.key"
  [[ -z $S_PSK ]] || printf '%s\n' "$S_PSK" >"$d/cctv-vpn.psk"
  fill >"$d/cctv-site-$S_ID-edgeos.txt" <<'EOF'
# CCTV VPN - site @@ID@@ (@@NAME@@) for an EdgeRouter (EdgeOS 2.x) with the WireGuard package.
#
# BEFORE PASTING, check in the SSH session (operational mode) that nothing else uses these names:
#   show interfaces wireguard
#       @@TIF@@ must NOT be listed, unless it is this site's earlier CCTV import
#       (description "CCTV VPN site @@ID@@ @@NAME@@"). The lines below DELETE @@TIF@@ first.
#   show configuration commands | match "nat rule (@@RULES_RE@@) "
#       must print nothing, unless every line is a 'cctv-vpn: ...' rule.
# If either is taken: run site-recipes.sh again with --ifname wgN (a free N), or ask before going on.
# Changing the NVR list later: paste the OLD folder's cctv-site-@@ID@@-edgeos-remove.txt first.
#
# Then copy cctv-vpn.key to /config/auth/cctv-vpn.key (mode 600) and paste these lines. /config
# survives firmware upgrades; the package itself must be re-installed after an upgrade unless it is
# in /config/data/firstboot/install-packages.
configure
delete interfaces wireguard @@TIF@@
delete firewall name CCTV_VPN_IN
delete firewall name CCTV_VPN_OUT
delete firewall name CCTV_VPN_LOCAL
delete firewall group address-group CCTV_NVRS
set interfaces wireguard @@TIF@@ description 'CCTV VPN site @@ID@@ @@NAME@@'
set interfaces wireguard @@TIF@@ address @@TIP@@/32
set interfaces wireguard @@TIF@@ mtu @@MTU@@
set interfaces wireguard @@TIF@@ private-key /config/auth/cctv-vpn.key
set interfaces wireguard @@TIF@@ route-allowed-ips true
set interfaces wireguard @@TIF@@ peer @@HUBPUB@@ endpoint @@EP@@
set interfaces wireguard @@TIF@@ peer @@HUBPUB@@ allowed-ips @@HUB@@/32
set interfaces wireguard @@TIF@@ peer @@HUBPUB@@ persistent-keepalive @@KA@@
@@PSKLINE@@
@@GROUP@@
set firewall name CCTV_VPN_IN default-action drop
set firewall name CCTV_VPN_IN rule 10 action accept
set firewall name CCTV_VPN_IN rule 10 state established enable
set firewall name CCTV_VPN_IN rule 10 state related enable
set firewall name CCTV_VPN_IN rule 20 action accept
set firewall name CCTV_VPN_IN rule 20 protocol tcp
set firewall name CCTV_VPN_IN rule 20 source address @@HUB@@
set firewall name CCTV_VPN_IN rule 20 destination group address-group CCTV_NVRS
set firewall name CCTV_VPN_IN rule 20 destination port @@PORT@@
set firewall name CCTV_VPN_IN rule 30 action accept
set firewall name CCTV_VPN_IN rule 30 protocol icmp
set firewall name CCTV_VPN_IN rule 30 icmp type-name echo-request
set firewall name CCTV_VPN_IN rule 30 source address @@HUB@@
set firewall name CCTV_VPN_IN rule 30 destination group address-group CCTV_NVRS
set firewall name CCTV_VPN_OUT default-action drop
set firewall name CCTV_VPN_OUT rule 10 action accept
set firewall name CCTV_VPN_OUT rule 10 state established enable
set firewall name CCTV_VPN_OUT rule 10 state related enable
set firewall name CCTV_VPN_LOCAL default-action drop
set firewall name CCTV_VPN_LOCAL rule 10 action accept
set firewall name CCTV_VPN_LOCAL rule 10 state established enable
set firewall name CCTV_VPN_LOCAL rule 10 state related enable
set firewall name CCTV_VPN_LOCAL rule 20 action accept
set firewall name CCTV_VPN_LOCAL rule 20 protocol icmp
set firewall name CCTV_VPN_LOCAL rule 20 icmp type-name echo-request
set firewall name CCTV_VPN_LOCAL rule 20 source address @@HUB@@
set interfaces wireguard @@TIF@@ firewall in name CCTV_VPN_IN
set interfaces wireguard @@TIF@@ firewall out name CCTV_VPN_OUT
set interfaces wireguard @@TIF@@ firewall local name CCTV_VPN_LOCAL
@@NATRULES@@
delete service nat rule @@MASQ@@
set service nat rule @@MASQ@@ description 'cctv-vpn: NVRs answer the router'
set service nat rule @@MASQ@@ type masquerade
set service nat rule @@MASQ@@ outbound-interface @@LANIF@@
set service nat rule @@MASQ@@ source address @@HUB@@
set service nat rule @@MASQ@@ destination address @@RLAN@@
@@TASK@@
commit
save
exit
EOF
  fill >"$d/cctv-site-$S_ID-edgeos-remove.txt" <<'EOF'
# CCTV VPN - remove site @@ID@@ (@@NAME@@) from this EdgeRouter: paste in an SSH session.
configure
delete interfaces wireguard @@TIF@@
delete firewall name CCTV_VPN_IN
delete firewall name CCTV_VPN_OUT
delete firewall name CCTV_VPN_LOCAL
delete firewall group address-group CCTV_NVRS
@@RMNAT@@
delete service nat rule @@MASQ@@
@@RMTASK@@
commit
save
exit
EOF
  {
    common_head "Ubiquiti EdgeRouter (EdgeOS 2.x)"
    fill <<'EOF'
EdgeOS has no WireGuard of its own: it needs the community package from the WireGuard project,
github.com/WireGuard/wireguard-vyatta-ubnt (pick the .deb for the router's model and EdgeOS
version). NVRs are mapped one by one (destination NAT per NVR): rules 44xx (TCP) and 47xx (ping),
xx = the NVR's last octet, and 7400 (masquerade); the tunnel is @@TIF@@.
Bring: SSH admin login, this folder, the package .deb for the model, the NVR addresses.

Steps
  0. FIRST check that the router does not use these already (the paste deletes and replaces them):
       show interfaces wireguard                                   (no @@TIF@@, or only this site's)
       show configuration commands | match "nat rule (@@RULES_RE@@) "   (nothing, or only cctv-vpn rules)
     If one is taken: site-recipes.sh ... edgeos --ifname wgN (a free N); rule numbers are fixed by
     the NVR addresses, so a clash there needs a look before going on.
  1. Install the package:  sudo dpkg -i <board>-<release>.deb   (see the project wiki)
  2. Key file:  scp cctv-vpn.key <router>:/tmp/ ; on the router:
                sudo install -m 600 /tmp/cctv-vpn.key /config/auth/cctv-vpn.key && rm /tmp/cctv-vpn.key
                (and cctv-vpn.psk the same way if it is in this folder)
     A DNS name for the hub: also  scp cctv-vpn-reresolve.sh <router>:/tmp/ ; on the router:
                sudo install -D -m 700 /tmp/cctv-vpn-reresolve.sh /config/scripts/cctv-vpn-reresolve.sh
                (EdgeOS resolves the name only when the tunnel is set up; this task looks it up again,
                IPv4 only, once the tunnel has been silent for 150 s)
  3. Paste cctv-site-@@ID@@-edgeos.txt into the SSH session (it ends with commit / save).
  4. Check:  sudo wg show @@TIF@@ ; show nat rules ; show firewall name CCTV_VPN_IN statistics
  The LAN interface is assumed to be @@LANIF@@ (--lan-if to change).
  Remove it all (or before pasting a new NVR list): paste cctv-site-@@ID@@-edgeos-remove.txt.
  MSS: EdgeOS cannot clamp per WireGuard interface; the tunnel MTU @@MTU@@ plus path-MTU discovery
  handle it (or set the hub's wg0 MTU to @@MTU@@).
Docs: https://github.com/WireGuard/wireguard-vyatta-ubnt/wiki/EdgeOS-and-Unifi-Gateway
      https://help.uisp.com/hc/en-us/articles/22591200002071-EdgeRouter-Destination-NAT
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

# ---------------------------------------------------------------- UniFi gateways
gen_wgconf_plain() { # $1 file, $2 extra addresses ("" or ", a/32, b/32")
  {
    echo "[Interface]"
    echo "PrivateKey = $S_KEY"
    echo "Address = $S_TUNNEL_IP/32$2"
    echo "MTU = $S_MTU"
    echo
    echo "[Peer]"
    echo "PublicKey = $S_HUB_PUB"
    [[ -z $S_PSK ]] || echo "PresharedKey = $S_PSK"
    echo "Endpoint = $S_ENDPOINT"
    echo "AllowedIPs = $S_HUB_IP/32"
    echo "PersistentKeepalive = $S_KEEPALIVE"
  } >"$1"
  chmod 600 "$1"
}
gen_unifi() {
  need_nvrs unifi
  local d h t=""
  d=$(outdir unifi)
  gen_wgconf_plain "$d/cctv-site-$S_ID.conf" ""
  for h in "${NVRS[@]}"; do t+="     DNAT  interface: the VPN client cctv-site-@@ID@@, protocol TCP, destination $VB.$h port $S_PORT -> translate to $RB.$h port $S_PORT"$'\n'; done
  V[DNATS]=$(fill <<<"${t%$'\n'}")
  {
    common_head "UniFi gateway (UDM / UCG / UXG, UniFi Network 9.x+)"
    fill <<'EOF'
What UniFi can do (Network application, Settings > VPN): a WireGuard "VPN Client" from an
uploaded config file, custom NAT rules (DNAT/SNAT/Masquerade, Network 8.3.32+) and zone-based
firewall policies (Network 9.x). There is no 1:1 subnet map, so NVRs are mapped one by one.
Whether the NAT and firewall pages let you pick the VPN client interface depends on the
firmware: if they do not, put a Raspberry Pi behind the UniFi gateway instead (site-gateway.sh):
that works with any router. Old USG / USG-Pro (EdgeOS inside) cannot do this from the UI.
Bring: UniFi admin login, this folder, the NVR addresses.

1. Settings > VPN > VPN Client > Create New > WireGuard: name cctv-site-@@ID@@, upload
   cctv-site-@@ID@@.conf (it holds the key; delete the file afterwards). Do NOT route any
   network's internet traffic through it (no "Policy-Based Route" / "Traffic Route"): the
   tunnel is only for the CCTV server.
2. Settings > Routing (or Firewall & Security) > NAT > Create, one rule per NVR:
@@DNATS@@
     Masquerade  interface: LAN (Default), source @@HUB@@, destination @@RLAN@@ (only needed if the
     NVRs' gateway is not this UniFi gateway)
3. Firewall (zone-based): policy from the zone of the VPN client (External/VPN) to Internal:
     Allow TCP @@PORT@@ and ICMP echo from @@HUB@@ to the NVR addresses, and ICMP echo from
     @@HUB@@ to the gateway itself (the hub pings the tunnel when it is idle, so that the session
     is renewed in time); everything else from that zone Block (default). Nothing from Internal
     to the VPN client.
4. Check: the VPN client shows Connected / a recent handshake.
Docs: https://help.ui.com/hc/en-us/articles/16357883221015-UniFi-Gateway-WireGuard-VPN-Client
      https://help.ui.com/hc/en-us/articles/16437942532759-DNAT-SNAT-and-Masquerading-in-UniFi
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

# ---------------------------------------------------------------- Windows PC on the site LAN
gen_windows() {
  need_nvrs windows
  local d h extra="" map=""
  d=$(outdir windows)
  for h in "${NVRS[@]}"; do
    extra+=", $VB.$h/32"
    map+="    '$VB.$h' = '$RB.$h'"$'\n'
  done
  gen_wgconf_plain "$d/cctv-site-$S_ID.conf" "$extra"
  V[MAP]=${map%$'\n'}
  V[BLOCKLO]=$((S_PORT - 1))
  V[BLOCKHI]=$((S_PORT + 1))
  fill >"$d/cctv-site-$S_ID-setup.ps1" <<'EOF'
# CCTV VPN - site @@ID@@ (@@NAME@@): this Windows PC relays the CCTV server's connections to the NVRs.
# Windows cannot 1:1-NAT a subnet, so each NVR gets its own address on the WireGuard adapter
# (@@VB@@.x, listed in cctv-site-@@ID@@.conf) and the built-in port proxy (IP Helper service) relays
# TCP @@PORT@@ on that address to the NVR (@@RB@@.x). The CCTV server still adds the NVR as @@VB@@.x.
# Run in an ADMINISTRATOR PowerShell after importing + activating cctv-site-@@ID@@.conf in WireGuard:
#   powershell -ExecutionPolicy Bypass -File .\cctv-site-@@ID@@-setup.ps1            set up (again)
#   powershell -ExecutionPolicy Bypass -File .\cctv-site-@@ID@@-setup.ps1 -NoSleep   also keep the PC awake on AC power
#   powershell -ExecutionPolicy Bypass -File .\cctv-site-@@ID@@-setup.ps1 -Remove    undo
# This script holds no secrets.
param([switch]$Remove, [switch]$NoSleep)
$ErrorActionPreference = 'Stop'
$Tunnel = 'cctv-site-@@ID@@'
$Hub = '@@HUB@@'
$Port = @@PORT@@
$Map = [ordered]@{
@@MAP@@
}
$Name = 'CCTV VPN site @@ID@@'
# earlier versions kept the watchdog as a script under ProgramData, a folder every user may write
# to: a task running as SYSTEM must never run such a file. It is removed; the task now carries
# its commands itself (-EncodedCommand).
$Legacy = Join-Path $env:ProgramData 'cctv-vpn'
$LegacyCheck = Join-Path $Legacy "portproxy-check-@@ID@@.ps1"

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an Administrator PowerShell.' }

# start from a clean slate every time
foreach ($v in $Map.Keys) { & cmd.exe /c "netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=$v >nul 2>&1" }
Get-NetFirewallRule -DisplayName "$Name*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $LegacyCheck) { Remove-Item -LiteralPath $LegacyCheck -Force }
if ((Test-Path -LiteralPath $Legacy) -and -not (Get-ChildItem -LiteralPath $Legacy -Force)) { Remove-Item -LiteralPath $Legacy -Force }
if ($Remove) { "Removed the relay for site @@ID@@ (remove the tunnel in the WireGuard app)."; return }

if (-not (Get-NetAdapter -Name $Tunnel -ErrorAction SilentlyContinue)) {
  throw "The WireGuard tunnel '$Tunnel' is not active: import cctv-site-@@ID@@.conf in WireGuard, click Activate, run this again."
}
foreach ($v in $Map.Keys) {
  if (-not (Get-NetIPAddress -IPAddress $v -InterfaceAlias $Tunnel -ErrorAction SilentlyContinue)) {
    throw "$v is not on the tunnel adapter: import the cctv-site-@@ID@@.conf made for these NVRs."
  }
}
Set-Service iphlpsvc -StartupType Automatic
Start-Service iphlpsvc
foreach ($v in $Map.Keys) {
  netsh interface portproxy add v4tov4 listenaddress=$v listenport=$Port connectaddress=$($Map[$v]) connectport=$Port | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "netsh portproxy add failed for $v" }
}

# firewall on the tunnel adapter: only the hub, only TCP @@PORT@@ to the NVR addresses, and ping
$fw = @{ Direction = 'Inbound'; InterfaceAlias = $Tunnel; Profile = 'Any' }
New-NetFirewallRule @fw -DisplayName "$Name - NVR relay" -Protocol TCP -LocalPort $Port -LocalAddress @($Map.Keys) -RemoteAddress $Hub -Action Allow | Out-Null
New-NetFirewallRule @fw -DisplayName "$Name - ping" -Protocol ICMPv4 -IcmpType 8 -RemoteAddress $Hub -Action Allow | Out-Null
New-NetFirewallRule @fw -DisplayName "$Name - block other TCP" -Protocol TCP -LocalPort @('1-@@BLOCKLO@@', '@@BLOCKHI@@-65535') -Action Block | Out-Null
New-NetFirewallRule @fw -DisplayName "$Name - block UDP" -Protocol UDP -Action Block | Out-Null

# the port proxy binds only addresses that exist when IP Helper starts: after a reboot the tunnel
# may come up later, so a SYSTEM task re-checks every 2 minutes and restarts IP Helper when needed.
# The task holds its commands itself (-EncodedCommand) and starts PowerShell by its full path, so
# nothing a normal user can write to is ever run as SYSTEM.
$CheckTemplate = @'
$want = @(__WANT__)
$have = @(Get-NetTCPConnection -State Listen -LocalPort __PORT__ -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress })
$present = @($want | Where-Object { Get-NetIPAddress -IPAddress $_ -ErrorAction SilentlyContinue })
if (@($present | Where-Object { $have -notcontains $_ }).Count -gt 0) { Restart-Service iphlpsvc -Force }
'@
$want = ($Map.Keys | ForEach-Object { "'$_'" }) -join ','
$check = $CheckTemplate.Replace('__WANT__', $want).Replace('__PORT__', "$Port")
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($check))
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded"
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)))
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $triggers -Principal $principal -Description 'CCTV VPN: keep the NVR port proxy listening' | Out-Null

if ($NoSleep) { powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0 }

Start-Sleep 2
"Relay for site @@ID@@:"
foreach ($v in $Map.Keys) {
  $ok = [bool](Get-NetTCPConnection -State Listen -LocalAddress $v -LocalPort $Port -ErrorAction SilentlyContinue)
  $nvr = Test-NetConnection -ComputerName $Map[$v] -Port $Port -WarningAction SilentlyContinue
  "  $v`:$Port (CCTV server) -> $($Map[$v]):$Port   listening: $ok   NVR reachable from this PC: $($nvr.TcpTestSucceeded)"
}
"Tunnel: & 'C:\Program Files\WireGuard\wg.exe' show $Tunnel   (latest handshake)"
EOF
  {
    common_head "a Windows PC on the site LAN (Windows 10/11)"
    fill <<'EOF'
What Windows can and cannot do
  WireGuard for Windows connects fine, but Windows cannot act as a 1:1 NAT router for a subnet:
  Internet Connection Sharing and New-NetNat only masquerade, cannot map @@VNET@@ onto @@RLAN@@,
  and Windows Firewall does not filter routed traffic (least privilege would be lost). So the PC
  RELAYS instead: every NVR gets its own address @@VB@@.x on the WireGuard adapter (in the .conf)
  and the built-in port proxy (netsh interface portproxy, IP Helper service) forwards TCP @@PORT@@
  on it to the NVR. For the CCTV server nothing changes: the NVR is still @@VB@@.x:@@PORT@@.
  Limits: TCP only; a ping to @@VB@@.x is answered by the PC, not the NVR; the relay accepts the
  connection even when the NVR is off (the app's login then fails); every NVR must be listed
  (a new NVR = run site-recipes.sh again with it and re-import); the PC must stay on and awake.
Bring: admin rights on the PC, the WireGuard installer (https://www.wireguard.com/install/),
this folder, the NVR addresses.

Steps
  1. Install WireGuard for Windows.
  2. WireGuard > Import tunnel(s) from file > cctv-site-@@ID@@.conf > Activate. Then delete the
     .conf file (WireGuard keeps its own encrypted copy). An active tunnel comes back after reboots.
  3. Administrator PowerShell in this folder:
       powershell -ExecutionPolicy Bypass -File .\cctv-site-@@ID@@-setup.ps1 -NoSleep
     It prints each relay and whether this PC reaches the NVR.
  4. Power: the PC must not sleep (-NoSleep sets that for AC power) and should restart itself
     after power loss (BIOS setting) - the tunnel and relay come back on their own.
  Undo: the same script with -Remove, then delete the tunnel in WireGuard.
Docs: https://www.wireguard.com/install/
      https://learn.microsoft.com/en-us/windows-server/networking/technologies/netsh/netsh-interface-portproxy
      https://github.com/WireGuard/wireguard-windows/blob/master/docs/enterprise.md
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

gen_linux() {
  local d
  d=$(outdir linux)
  {
    common_head "a Linux box (Raspberry Pi OS / Debian / Ubuntu)"
    fill <<'EOF'
Use site-gateway.sh from the CCTV release (deploy/vpn/site-gateway.sh) with the site's bundle:
  sudo bash site-gateway.sh check   cctv-site-@@ID@@-@@NAME@@.tar.gz     (changes nothing)
  sudo bash site-gateway.sh install cctv-site-@@ID@@-@@NAME@@.tar.gz     (sets it up; safe to re-run)
  sudo cctv-site-gateway status
It detects the LAN interface, refuses unsafe settings and prints how the NVRs' replies return.
Bring: a Raspberry Pi 3/4/5 (or any always-on Debian/Ubuntu box) with Raspberry Pi OS Lite
(64-bit), power supply, SD card, an Ethernet cable to a free LAN port on the site router,
SSH access, the bundle, and internet at the site (apt installs wireguard-tools and nftables).
Give the Pi a fixed LAN address (DHCP reservation) so the NVRs' allow-lists can name it.
EOF
    common_tests
  } >"$d/README.txt"
  echo "$d"
}

run_one() {
  case "$1" in
    mikrotik) gen_mikrotik ;;
    openwrt) gen_openwrt ;;
    rutos) gen_rutos ;;
    pfsense) gen_pfsense ;;
    opnsense) gen_opnsense ;;
    edgeos) gen_edgeos ;;
    unifi) gen_unifi ;;
    windows) gen_windows ;;
    linux) gen_linux ;;
  esac
}
if [[ $PLATFORM == all ]]; then
  for p in linux mikrotik openwrt rutos pfsense opnsense; do run_one "$p"; done
  if [[ ${#NVRS[@]} -gt 0 ]]; then for p in edgeos unifi windows; do run_one "$p"; done; else echo "(edgeos, unifi, windows need --nvr)" >&2; fi
else
  run_one "$PLATFORM"
fi
