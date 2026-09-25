#!/usr/bin/env bash
# CCTV VPN: make this Debian / Ubuntu / Raspberry Pi OS box the WireGuard gateway of ONE remote site.
#
# What it sets up (and nothing more):
#   - a WireGuard tunnel (interface wg-cctv) that DIALS OUT to the CCTV server (the hub) with a
#     25 s keepalive: no port forwarding at the site, works behind 4G routers and carrier NAT
#   - the hub sees this site's LAN as the virtual subnet 10.78.N.0/24, host by host
#     (10.78.N.x = <site LAN>.x), so sites that all use 192.168.1.0/24 never clash
#   - from the tunnel only TCP 6036 (the TVT SDK port) and ping reach the LAN; everything else
#     from the tunnel is dropped (also this box's own SSH etc.); nothing on the LAN or on this box
#     can open a connection INTO the tunnel; other sites are unreachable (the hub does not route)
#   - the source of each hub connection is rewritten to this box's LAN address (masquerade), so the
#     NVR's replies come straight back to this box: no route or change on the NVR or site router
#   - persistence: systemd units (firewall before the tunnel, wg-quick@, re-resolve timer for a
#     DNS hub address) and /etc/sysctl.d; survives reboots
#   - a box that did not route before (ip_forward was 0, e.g. a Pi with Wi-Fi and Ethernet) forwards
#     ONLY the tunnel's NVR traffic: everything else between its networks stays dropped
#   - a DNS hub address is resolved to its IPv4 address (A record) here and by the re-resolve timer:
#     the main site forwards only IPv4, and wg itself would prefer an AAAA address on 4G IPv6
# The box can be the site's router, or any always-on machine on the LAN (e.g. a Raspberry Pi).
#
#   sudo bash site-gateway.sh check   <bundle> [options]   validate and show the plan; changes nothing
#   sudo bash site-gateway.sh install <bundle> [options]   set up (again); safe to re-run
#   sudo cctv-site-gateway status                          tunnel, handshake, counters
#   sudo cctv-site-gateway uninstall                       remove everything this script added
#   exit codes: 0 done (install: and connected), 1 refused or failed, 2 usage,
#               5 installed but NO handshake with the hub within 20 s (see the hints it prints)
#
#   <bundle>          the folder or .tar.gz the CCTV server made for this site
#   --lan CIDR        the site LAN /24 that holds the NVRs (only if the bundle has no REAL_LAN)
#   --lan-if IF       the LAN interface (default: the one directly connected to that /24)
#   --only IP[,IP..]  allow only these NVRs (their real LAN addresses) instead of the whole /24
#   --ifname NAME     tunnel interface name (default wg-cctv)
#   --key FILE        this box's own WireGuard private key, for a site added on the hub with
#                     --pubkey (the key never left the site: umask 077; wg genkey > FILE; wg pubkey < FILE)
#   --no-packages     do not apt-get install wireguard-tools / nftables
#   --no-wait         install: do not wait for the first handshake (offline preparation; exit 0)
#   --root DIR        testing: write every file under DIR instead of /
#   --no-systemd      testing: apply in the current network namespace, no units (no persistence);
#                     refused in the main network namespace (CCTV_SITE_TABLE then renames the nft table)
#
# BUNDLE FORMAT 1 (made on the hub; a folder, or a .tar.gz of one folder, files 0600):
#   site.env   KEY=VALUE lines, no secrets, never executed (parsed field by field):
#                CCTV_VPN_BUNDLE=1   SITE_ID=3   SITE_NAME=yard-a   TUNNEL_IP=10.77.0.3
#                VIRTUAL_SUBNET=10.78.3.0/24   REAL_LAN=192.168.1.0/24 (or empty: decide at the site)
#                HUB_TUNNEL_IP=10.77.0.1   HUB_ENDPOINT=vpn.example.com:51820 (the address sites dial)
#                HUB_PUBLIC_KEY=...   SITE_PUBLIC_KEY=...   NVR_PORT=6036   KEEPALIVE=25   MTU=1280
#              (aliases: ID, NAME, LAN for REAL_LAN, HUB_PUBKEY, SITE_PUBKEY, HUB_HOST + HUB_PORT)
#   site.key   the site's WireGuard private key, one line (or private.key; or SITE_PRIVATE_KEY in
#              site.env; or only inside wg0.conf)
#   site.psk   optional WireGuard preshared key, one line (or psk; or PresharedKey in wg0.conf)
#   wg0.conf   a ready config for wg-quick / WireGuard for Windows / router import (holds the key).
#              This script never runs it: it builds its own config from the checked fields
#              (a config file can carry PostUp commands that would run as root).
set -euo pipefail
umask 077

PROG=cctv-site-gateway
TABLE=cctv_site
TUNNEL_NET=10.77.0.0/24
VIRTUAL_NET=10.78.0.0/16
REresolve_AFTER=${CCTV_SITE_RERESOLVE_AFTER:-135} # s without a handshake before re-resolving the hub name

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
say() { printf '\n== %s\n' "$*"; }

# ---------- validation helpers (no input reaches a file name, a rule or a command unchecked) ----------
RE_OCTET='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
RE_IP4="^($RE_OCTET\\.){3}$RE_OCTET\$"
RE_KEY='^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$'
RE_NAME='^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' # as the hub: 1-32 of a-z 0-9 -, no - at either end
RE_IFNAME='^[A-Za-z0-9_.-]{1,15}$'
RE_HOST='^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'
RE_IP6='^[0-9A-Fa-f:.]{2,45}$'
RE_VALUE='^[][A-Za-z0-9+/=.:_,-]*$'

netns_is_main() { # 0 = the main network namespace (or unknown: then assume the main one)
  local a b
  a=$(readlink /proc/self/ns/net 2>/dev/null) || return 0
  b=$(readlink /proc/1/ns/net 2>/dev/null) || return 0
  [[ $a == "$b" ]]
}
is_ip4() { [[ $1 =~ $RE_IP4 ]]; }
is_key() { [[ $1 =~ $RE_KEY ]]; }
is_name() { [[ $1 =~ $RE_NAME ]]; }
is_ifname() { [[ $1 =~ $RE_IFNAME && $1 != . && $1 != .. && $1 != all && $1 != default && $1 != lo ]]; }
is_port() { [[ $1 =~ ^[1-9][0-9]{0,4}$ ]] && (($1 <= 65535)); }
is_hostname() { ((${#1} <= 253)) && [[ $1 =~ $RE_HOST ]]; }
ip2int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  echo $(((a << 24) + (b << 16) + (c << 8) + d))
}
int2ip() { echo "$((($1 >> 24) & 255)).$((($1 >> 16) & 255)).$((($1 >> 8) & 255)).$(($1 & 255))"; }
mask_of() { if (($1 == 0)); then echo 0; else echo $(((0xFFFFFFFF << (32 - $1)) & 0xFFFFFFFF)); fi; }
is_cidr() { # a.b.c.d/len with the host bits zero
  [[ $1 =~ ^([0-9.]+)/([0-9]|[12][0-9]|3[0-2])$ ]] || return 1
  local ip=${BASH_REMATCH[1]} len=${BASH_REMATCH[2]} n m
  is_ip4 "$ip" || return 1
  n=$(ip2int "$ip")
  m=$(mask_of "$len")
  (((n & m) == n))
}
cidr_contains() { # outer-cidr inner-cidr-or-ip
  local o=${1%/*} ol=${1#*/} i=${2%/*} il=32 m
  [[ $2 == */* ]] && il=${2#*/}
  ((il >= ol)) || return 1
  m=$(mask_of "$ol")
  ((($(ip2int "$i") & m) == ($(ip2int "$o") & m)))
}
cidr_overlap() { cidr_contains "$1" "$2" || cidr_contains "$2" "$1"; }
is_private_24() {
  is_cidr "$1" && [[ ${1#*/} == 24 ]] || return 1
  cidr_contains 10.0.0.0/8 "$1" || cidr_contains 172.16.0.0/12 "$1" || cidr_contains 192.168.0.0/16 "$1"
}

# ---------- bundle ----------
declare -A ENV=()
WORK=""
cleanup() { if [[ -n $WORK && -d $WORK ]]; then rm -rf -- "$WORK"; fi; }
trap cleanup EXIT

parse_env() { # strict KEY=VALUE; never sourced
  local file=$1 line key val n=0
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ $line =~ ^([A-Z][A-Z0-9_]{0,40})=(.*)$ ]] || die "site.env line $n is not KEY=VALUE"
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    if [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
    [[ $val =~ $RE_VALUE ]] || die "site.env line $n ($key): unexpected characters in the value"
    ((${#val} <= 300)) || die "site.env line $n ($key): value too long"
    [[ -z ${ENV[$key]+x} ]] || die "site.env: $key is given twice"
    ENV[$key]=$val
  done <"$file"
}
env_get() { # first non-empty of the given keys
  local k v
  for k in "$@"; do
    if [[ -n ${ENV[$k]:-} ]]; then
      printf '%s' "${ENV[$k]}"
      return 0
    fi
  done
  return 0
}
read_one_line() { # a key file: exactly one non-empty line
  local f=$1 v
  (($(wc -c <"$f") <= 200)) || die "$(basename "$f") is too big to be a key"
  v=$(tr -d ' \t\r' <"$f" | sed '/^$/d')
  [[ $(printf '%s\n' "$v" | wc -l) == 1 ]] || die "$(basename "$f") must hold one key on one line"
  printf '%s' "$v"
}
declare -A WG=()
parse_wgconf() { # only the fields we need; one [Peer]
  local file=$1 line sect="" key val peers=0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    line=${line%%#*}
    [[ $line =~ ^[[:space:]]*$ ]] && continue
    if [[ $line =~ ^[[:space:]]*\[(Interface|Peer)\][[:space:]]*$ ]]; then
      sect=${BASH_REMATCH[1]}
      [[ $sect == Peer ]] && peers=$((peers + 1))
      continue
    fi
    [[ $line =~ ^[[:space:]]*([A-Za-z]+)[[:space:]]*=[[:space:]]*(.*[^[:space:]])[[:space:]]*$ ]] || die "wg0.conf: cannot read a line (not Key = Value)"
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    case "$sect/$key" in
      Interface/PrivateKey | Interface/Address | Interface/MTU | Peer/PublicKey | Peer/PresharedKey | Peer/Endpoint | Peer/AllowedIPs | Peer/PersistentKeepalive)
        WG[$sect/$key]=$val
        ;;
    esac
  done <"$file"
  ((peers <= 1)) || die "wg0.conf has $peers [Peer] sections; a site talks only to the hub"
}

load_bundle() { # $1: folder or .tar.gz -> fills ENV / WG / B_* (checked later)
  local src=$1 dir names types
  if [[ -d $src ]]; then
    dir=$src
  elif [[ -f $src ]]; then
    case $src in *.tar.gz | *.tgz) ;; *) die "a bundle is a folder or a .tar.gz file: $src" ;; esac
    (($(wc -c <"$src") <= 1048576)) || die "bundle is bigger than 1 MB: not a site bundle"
    names=$(tar -tzf "$src") || die "cannot read $src"
    types=$(tar -tvzf "$src" | cut -c1 | sort -u | tr -d '\n')
    [[ $types =~ ^[-d]+$ ]] || die "bundle holds links or special files: refused"
    while IFS= read -r n; do
      [[ $n =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]*)?$ && $n != *..* ]] || die "unexpected file name in the bundle: $n"
    done <<<"$names"
    WORK=$(mktemp -d /tmp/cctv-site.XXXXXX)
    tar -xzf "$src" -C "$WORK" --no-same-owner --no-same-permissions
    dir=$WORK
  else
    die "bundle not found: $src"
  fi
  # a folder that holds only one folder: the bundle is inside it
  if [[ ! -e $dir/site.env && ! -e $dir/wg0.conf ]]; then
    local sub=("$dir"/*/)
    [[ ${#sub[@]} == 1 && -d ${sub[0]} ]] && dir=${sub[0]%/}
  fi
  [[ -f $dir/site.env || -f $dir/wg0.conf ]] || die "no site.env or wg0.conf in $src"
  local f
  for f in site.env site.key private.key site.psk psk wg0.conf; do
    if [[ -e $dir/$f ]]; then
      [[ -f $dir/$f && ! -L $dir/$f ]] || die "$f in the bundle is not a plain file"
      (($(wc -c <"$dir/$f") <= 65536)) || die "$f in the bundle is too big"
    fi
  done
  [[ -f $dir/site.env ]] && parse_env "$dir/site.env"
  [[ -f $dir/wg0.conf ]] && parse_wgconf "$dir/wg0.conf"
  B_KEY_FILE=""
  B_PSK_FILE=""
  local k v
  for k in site.key private.key; do
    [[ -f $dir/$k ]] || continue
    v=$(read_one_line "$dir/$k")
    [[ -z $B_KEY_FILE || $B_KEY_FILE == "$v" ]] || die "site.key and private.key in the bundle differ"
    B_KEY_FILE=$v
  done
  for k in site.psk psk; do
    [[ -f $dir/$k ]] || continue
    v=$(read_one_line "$dir/$k")
    [[ -z $B_PSK_FILE || $B_PSK_FILE == "$v" ]] || die "site.psk and psk in the bundle differ"
    B_PSK_FILE=$v
  done
  return 0
}

# the checked site settings (from the bundle + options) -> S_* globals
check_bundle() {
  local v
  [[ -z ${ENV[CCTV_VPN_BUNDLE]:-} || ${ENV[CCTV_VPN_BUNDLE]} == 1 ]] || die "bundle format ${ENV[CCTV_VPN_BUNDLE]} is newer than this script (1): update it"

  # id: site.env, else from wg0.conf Address 10.77.0.N
  S_ID=$(env_get SITE_ID ID)
  if [[ -z $S_ID && ${WG[Interface/Address]:-} =~ ^10\.77\.0\.([0-9]{1,3})(/32|/24)?$ ]]; then S_ID=${BASH_REMATCH[1]}; fi
  [[ $S_ID =~ ^[1-9][0-9]{0,2}$ ]] && ((S_ID <= 250)) || die "site id must be 2..250 (got '${S_ID}')"
  ((S_ID >= 2)) || die "site id 1 would get the hub's own tunnel address 10.77.0.1: site ids are 2..250"
  S_NAME=$(env_get SITE_NAME NAME)
  [[ -n $S_NAME ]] || S_NAME="site-$S_ID"
  is_name "$S_NAME" || die "site name must be 1-32 of a-z 0-9 - without a - at either end (got '$S_NAME')"

  S_TUNNEL_IP=$(env_get TUNNEL_IP)
  [[ -n $S_TUNNEL_IP ]] || S_TUNNEL_IP="10.77.0.$S_ID"
  [[ $S_TUNNEL_IP == "10.77.0.$S_ID" ]] || die "TUNNEL_IP $S_TUNNEL_IP does not belong to site $S_ID (10.77.0.$S_ID)"
  S_VIRTUAL=$(env_get VIRTUAL_SUBNET)
  [[ -n $S_VIRTUAL ]] || S_VIRTUAL="10.78.$S_ID.0/24"
  [[ $S_VIRTUAL == "10.78.$S_ID.0/24" ]] || die "VIRTUAL_SUBNET $S_VIRTUAL does not belong to site $S_ID (10.78.$S_ID.0/24)"
  if [[ -n ${WG[Interface/Address]:-} ]]; then
    v=${WG[Interface/Address]%%,*}
    [[ ${v%/*} == "$S_TUNNEL_IP" ]] || die "wg0.conf Address ($v) and site.env TUNNEL_IP ($S_TUNNEL_IP) differ"
  fi

  S_HUB_IP=$(env_get HUB_TUNNEL_IP)
  [[ -n $S_HUB_IP ]] || S_HUB_IP=10.77.0.1
  [[ $S_HUB_IP == 10.77.0.1 ]] || die "HUB_TUNNEL_IP must be 10.77.0.1 (got $S_HUB_IP)"

  S_HUB_PUB=$(env_get HUB_PUBLIC_KEY HUB_PUBKEY)
  [[ -n $S_HUB_PUB ]] || S_HUB_PUB=${WG[Peer/PublicKey]:-}
  is_key "$S_HUB_PUB" || die "hub public key missing or not a WireGuard key"
  [[ -z ${WG[Peer/PublicKey]:-} || ${WG[Peer/PublicKey]} == "$S_HUB_PUB" ]] || die "wg0.conf and site.env name different hub keys"

  S_ENDPOINT=$(env_get HUB_ENDPOINT)
  if [[ -z $S_ENDPOINT && -n $(env_get HUB_HOST) && -n $(env_get HUB_PORT) ]]; then S_ENDPOINT="$(env_get HUB_HOST):$(env_get HUB_PORT)"; fi
  [[ -n $S_ENDPOINT ]] || S_ENDPOINT=${WG[Peer/Endpoint]:-}
  [[ -n $S_ENDPOINT ]] || die "HUB_ENDPOINT (the address sites dial, host:port) is missing"
  [[ -z ${WG[Peer/Endpoint]:-} || ${WG[Peer/Endpoint]} == "$S_ENDPOINT" ]] || die "wg0.conf and site.env name different hub endpoints"
  if [[ $S_ENDPOINT =~ ^\[([^]]+)\]:([0-9]+)$ ]]; then
    S_EP_HOST=${BASH_REMATCH[1]}
    S_EP_PORT=${BASH_REMATCH[2]}
    [[ $S_EP_HOST =~ $RE_IP6 && $S_EP_HOST == *:* ]] || die "hub endpoint: bad IPv6 address"
    S_EP_KIND=ip6
  elif [[ $S_ENDPOINT =~ ^([^:]+):([0-9]+)$ ]]; then
    S_EP_HOST=${BASH_REMATCH[1]}
    S_EP_PORT=${BASH_REMATCH[2]}
    if is_ip4 "$S_EP_HOST"; then
      S_EP_KIND=ip4
    elif is_hostname "$S_EP_HOST"; then
      S_EP_KIND=name
    else
      die "hub endpoint host is neither an IPv4 address nor a DNS name: $S_EP_HOST"
    fi
  else
    die "hub endpoint must be host:port (got $S_ENDPOINT)"
  fi
  is_port "$S_EP_PORT" || die "hub endpoint port must be 1..65535"

  # private key: site.key, SITE_PRIVATE_KEY, wg0.conf or --key FILE; all that are present must agree
  local own_key=""
  if [[ -n $OPT_KEY ]]; then
    [[ -f $OPT_KEY && ! -L $OPT_KEY ]] || die "--key: $OPT_KEY is not a plain file"
    own_key=$(read_one_line "$OPT_KEY")
    is_key "$own_key" || die "--key: $OPT_KEY does not hold a WireGuard private key"
  fi
  S_KEY=""
  for v in "$B_KEY_FILE" "$(env_get SITE_PRIVATE_KEY PRIVATE_KEY)" "${WG[Interface/PrivateKey]:-}" "$own_key"; do
    [[ -z $v ]] && continue
    is_key "$v" || die "the site private key in the bundle is not a WireGuard key"
    [[ -z $S_KEY || $S_KEY == "$v" ]] || die "the bundle and --key hold two different site private keys"
    S_KEY=$v
  done
  [[ -n $S_KEY ]] || die "the bundle has no site private key (site.key). If this box made its own key (site-add --pubkey on the hub), give it with --key FILE; otherwise the key was exported and forgotten on the hub: ask for a new bundle (cctv-vpn site-rekey)"
  S_PUB=$(printf '%s' "$S_KEY" | wg pubkey)
  v=$(env_get SITE_PUBLIC_KEY SITE_PUBKEY)
  if [[ -n $v ]]; then
    is_key "$v" || die "SITE_PUBLIC_KEY is not a WireGuard key"
    [[ $v == "$S_PUB" ]] || die "the private key does not match SITE_PUBLIC_KEY: wrong bundle?"
  fi
  [[ $S_PUB != "$S_HUB_PUB" ]] || die "site and hub keys are the same"
  S_PSK=""
  for v in "$B_PSK_FILE" "$(env_get PRESHARED_KEY SITE_PSK)" "${WG[Peer/PresharedKey]:-}"; do
    [[ -z $v ]] && continue
    is_key "$v" || die "the preshared key in the bundle is not a WireGuard key"
    [[ -z $S_PSK || $S_PSK == "$v" ]] || die "the bundle holds two different preshared keys"
    S_PSK=$v
  done

  S_PORT=$(env_get NVR_PORT)
  [[ -n $S_PORT ]] || S_PORT=6036
  is_port "$S_PORT" || die "NVR_PORT must be 1..65535"
  S_KEEPALIVE=$(env_get KEEPALIVE)
  [[ -n $S_KEEPALIVE ]] || S_KEEPALIVE=${WG[Peer/PersistentKeepalive]:-25}
  [[ $S_KEEPALIVE =~ ^[1-9][0-9]?$ ]] && ((S_KEEPALIVE >= 10 && S_KEEPALIVE <= 60)) || die "KEEPALIVE must be 10..60 s (the site dials out; 0 would let 4G NAT forget the tunnel)"
  S_MTU=$(env_get MTU)
  [[ -n $S_MTU ]] || S_MTU=${WG[Interface/MTU]:-1280}
  [[ $S_MTU =~ ^[1-9][0-9]{3}$ ]] && ((S_MTU >= 1200 && S_MTU <= 1420)) || die "MTU must be 1200..1420"
  S_MSS=$((S_MTU - 40))

  S_REAL_LAN=$(env_get REAL_LAN LAN)
  if [[ -n $OPT_LAN ]]; then
    [[ -z $S_REAL_LAN || $S_REAL_LAN == "$OPT_LAN" ]] || die "--lan $OPT_LAN differs from the bundle's REAL_LAN $S_REAL_LAN: fix it on the CCTV server and make a new bundle"
    S_REAL_LAN=$OPT_LAN
  fi
  [[ -n $S_REAL_LAN ]] || S_REAL_LAN=auto
  if [[ $S_REAL_LAN != auto ]]; then check_real_lan "$S_REAL_LAN"; fi
  return 0
}

check_real_lan() {
  is_cidr "$1" || die "real LAN must be a network like 192.168.1.0/24 (got $1)"
  [[ ${1#*/} == 24 ]] || die "real LAN must be one /24 (the virtual subnet 10.78.N.0/24 maps host by host); for a bigger LAN give the /24 that holds the NVRs"
  is_private_24 "$1" || die "real LAN $1 is not a private network (10/8, 172.16/12, 192.168/16): refused"
  cidr_overlap "$1" "$TUNNEL_NET" && die "real LAN $1 overlaps the VPN tunnel network $TUNNEL_NET"
  cidr_overlap "$1" "$VIRTUAL_NET" && die "real LAN $1 overlaps the VPN virtual networks $VIRTUAL_NET"
  return 0
}

# ---------- this box ----------
route_dev() { sed -n 's/.* dev \([^ ]*\).*/\1/p' <<<"$1" | head -1; }
route_src() { sed -n 's/.* src \([^ ]*\).*/\1/p' <<<"$1" | head -1; }

detect_lan() { # -> L_IF L_NET L_ADDR ; S_REAL_LAN when auto
  local line pfx dev src cands=() c
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    pfx=${line%% *}
    [[ $pfx == */* ]] || pfx="$pfx/32"
    is_cidr "$pfx" || continue
    dev=$(route_dev "$line")
    src=$(route_src "$line")
    [[ -n $dev && $dev != "$IFNAME" && $dev != lo ]] || continue
    [[ -n $OPT_LAN_IF && $dev != "$OPT_LAN_IF" ]] && continue
    if [[ $S_REAL_LAN == auto ]]; then
      is_ip4 "$src" && is_private_24 "${src%.*}.0/24" || continue
      ((${pfx#*/} <= 24)) || continue
    else
      cidr_contains "$pfx" "$S_REAL_LAN" || continue
    fi
    cands+=("$dev $pfx $src")
  done < <(ip -4 route show table main proto kernel scope link 2>/dev/null)
  if [[ ${#cands[@]} == 0 ]]; then
    if [[ $S_REAL_LAN == auto ]]; then die "no LAN found on this box: give --lan <the /24 with the NVRs>"; fi
    die "this box has no interface directly on $S_REAL_LAN${OPT_LAN_IF:+ (checked $OPT_LAN_IF)}: it must sit on the NVRs' LAN"
  fi
  if [[ ${#cands[@]} -gt 1 ]]; then
    for c in "${cands[@]}"; do echo "  candidate: $c" >&2; done
    die "more than one LAN interface fits: choose one with --lan-if"
  fi
  read -r L_IF L_NET L_ADDR <<<"${cands[0]}"
  is_ifname "$L_IF" || die "unexpected LAN interface name: $L_IF"
  if [[ -z $L_ADDR ]]; then L_ADDR=$(ip -4 -o addr show dev "$L_IF" | awk '{print $4}' | cut -d/ -f1 | head -1); fi
  is_ip4 "$L_ADDR" || die "cannot find this box's address on $L_IF"
  if [[ $S_REAL_LAN == auto ]]; then
    S_REAL_LAN="$(int2ip $(($(ip2int "$L_ADDR") & 0xFFFFFF00)))/24"
    check_real_lan "$S_REAL_LAN"
    S_LAN_DETECTED=1
  fi
  case "$L_IF" in wg* | tun* | tap* | ppp* | wwan* | "$IFNAME") die "LAN interface $L_IF looks like a tunnel/WAN link: give --lan-if" ;; esac
  return 0
}

hosts_of_lan() { # the real host addresses the tunnel may reach -> S_HOSTS (last octets)
  local base h
  base=${S_REAL_LAN%.*}
  S_HOSTS=()
  if [[ -n $OPT_ONLY ]]; then
    local IFS=,
    for h in $OPT_ONLY; do
      is_ip4 "$h" || die "--only: not an IPv4 address: $h"
      cidr_contains "$S_REAL_LAN" "$h" || die "--only: $h is not in the site LAN $S_REAL_LAN"
      [[ $h != "$L_ADDR" ]] || die "--only: $h is this box itself"
      [[ ${h##*.} != 0 && ${h##*.} != 255 ]] || die "--only: $h is not a host address"
      S_HOSTS+=("${h##*.}")
    done
    unset IFS
  else
    for h in $(seq 1 254); do
      [[ "$base.$h" == "$L_ADDR" ]] && continue # never map the box itself
      S_HOSTS+=("$h")
    done
  fi
  [[ ${#S_HOSTS[@]} -gt 0 ]] || die "no NVR addresses to allow"
}

check_box() {
  local line pfx dev a
  # the VPN ranges must be free here
  while read -r a dev; do
    [[ $dev == "$IFNAME" ]] && continue
    if cidr_overlap "$a" "$TUNNEL_NET" || cidr_overlap "$a" "$VIRTUAL_NET"; then
      die "$dev already has $a, inside the VPN ranges ($TUNNEL_NET / $VIRTUAL_NET): refused"
    fi
  done < <(ip -4 -o addr show | awk '{print $4, $2}')
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    pfx=${line%% *}
    [[ $pfx == default ]] && continue
    [[ $pfx == */* ]] || pfx="$pfx/32"
    is_cidr "$pfx" || continue
    dev=$(route_dev "$line")
    [[ $dev == "$IFNAME" ]] && continue
    if (( ${pfx#*/} >= 16 )) && { cidr_overlap "$pfx" "$TUNNEL_NET" || cidr_overlap "$pfx" "$VIRTUAL_NET"; }; then
      die "route '$line' already uses the VPN ranges: refused"
    fi
    if (( ${pfx#*/} < 16 )) && cidr_contains "$pfx" "$S_HUB_IP"; then
      warn "route '$line' also covers the VPN ranges; the tunnel's own more specific route wins"
    fi
  done < <(ip -4 route show table main 2>/dev/null)
  # the NVR addresses must be reached directly on the LAN interface
  local h r
  for h in "${S_HOSTS[0]}" "${S_HOSTS[-1]}"; do
    r=$(ip -4 route get "${S_REAL_LAN%.*}.$h" 2>/dev/null | head -1) || true
    [[ $(route_dev "$r") == "$L_IF" && $r != *" via "* ]] || die "${S_REAL_LAN%.*}.$h is not reached directly on $L_IF ($r): refused"
  done
  # the hub address. A DNS name is resolved to IPv4 here and the tunnel gets that literal address:
  # given the name, wg would take an AAAA address first on a site with IPv6 (common on 4G), and
  # the main site forwards only IPv4. The re-resolve timer follows later DNS changes (A only).
  if [[ $S_EP_KIND == name ]]; then
    S_EP_ADDR=$(getent ahostsv4 "$S_EP_HOST" 2>/dev/null | awk '{print $1; exit}') || true
    [[ -n $S_EP_ADDR ]] || die "cannot resolve the hub address $S_EP_HOST to IPv4 here (DNS, A record): check the internet connection and the name"
    S_WG_ENDPOINT="$S_EP_ADDR:$S_EP_PORT"
  elif [[ $S_EP_KIND == ip6 ]]; then
    S_EP_ADDR=$S_EP_HOST
    S_WG_ENDPOINT="[$S_EP_HOST]:$S_EP_PORT"
  else
    S_EP_ADDR=$S_EP_HOST
    S_WG_ENDPOINT="$S_EP_HOST:$S_EP_PORT"
  fi
  if [[ $S_EP_KIND != ip6 ]]; then
    is_ip4 "$S_EP_ADDR" || die "hub address resolved to something odd: $S_EP_ADDR"
    cidr_contains "$S_REAL_LAN" "$S_EP_ADDR" && die "the hub address $S_EP_ADDR is inside the site LAN: wrong HUB_ENDPOINT"
    { cidr_contains "$TUNNEL_NET" "$S_EP_ADDR" || cidr_contains "$VIRTUAL_NET" "$S_EP_ADDR"; } && die "the hub address $S_EP_ADDR is inside the VPN ranges"
    r=$(ip -4 route get "$S_EP_ADDR" 2>/dev/null | head -1) || true
    [[ -n $r ]] || die "no route to the hub $S_EP_ADDR: no internet here?"
    S_EP_DEV=$(route_dev "$r")
    [[ $S_EP_DEV != "$IFNAME" ]] || die "the hub address would be routed into the tunnel itself"
  else
    S_EP_DEV="(IPv6)"
  fi
  # an earlier install of another site, or a foreign interface with our name
  if [[ -f $R/etc/cctv-site/site.env ]]; then
    local old
    old=$(sed -n 's/^SITE_ID=//p' "$R/etc/cctv-site/site.env")
    [[ $old == "$S_ID" ]] || die "this box is already the gateway of site $old: run '$PROG uninstall' first"
  elif ip link show dev "$IFNAME" >/dev/null 2>&1; then
    die "an interface named $IFNAME already exists and was not made by this script: use --ifname"
  fi
}

other_firewalls() { # warnings only: another firewall can silently block the forwarded NVR traffic
  local t
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    warn "ufw is active and blocks forwarding by default. Allow the NVR traffic with:"
    echo "  ufw route allow in on $IFNAME out on $L_IF to $S_REAL_LAN port $S_PORT proto tcp" >&2
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    warn "firewalld is running: its zones may drop the forwarded traffic (put $IFNAME in a zone that allows forwarding to $L_IF)"
  fi
  t=$(nft list chains 2>/dev/null | awk '/^table /{tb=$2" "$3} /hook forward/ && /policy drop/ {print tb}' | grep -v " $TABLE\$" | sort -u | tr '\n' ',' || true)
  if [[ -n $t ]]; then
    warn "another firewall drops forwarded packets by default (nft tables: ${t%,}); e.g. Docker does. Allow it with:"
    echo "  iptables -I FORWARD -i $IFNAME -o $L_IF -d $S_REAL_LAN -p tcp --dport $S_PORT -j ACCEPT" >&2
    echo "  iptables -I FORWARD -i $L_IF -o $IFNAME -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT" >&2
    echo "  (this script's own table still does the filtering; a dedicated box avoids this)" >&2
  fi
  return 0
}

# ---------- files ----------
render_wgconf() {
  echo "# CCTV VPN: site $S_ID ($S_NAME) -> the CCTV server. Written by $PROG: re-run its install to change."
  echo "# No PostUp/DNS on purpose; the firewall is the $PROG-firewall unit (nft table ip $TABLE)."
  echo "[Interface]"
  echo "Address = $S_TUNNEL_IP/32"
  echo "PrivateKey = $S_KEY"
  echo "MTU = $S_MTU"
  echo
  echo "[Peer]"
  echo "# the CCTV server (hub)"
  echo "PublicKey = $S_HUB_PUB"
  [[ -n $S_PSK ]] && echo "PresharedKey = $S_PSK"
  [[ $S_EP_KIND != name ]] || echo "# $S_ENDPOINT, resolved to IPv4 at install; $PROG reresolve follows DNS changes"
  echo "Endpoint = $S_WG_ENDPOINT"
  echo "AllowedIPs = $S_HUB_IP/32"
  echo "PersistentKeepalive = $S_KEEPALIVE"
}

render_nft() {
  local base=${S_REAL_LAN%.*} vbase="10.78.$S_ID" h elems=() i
  for h in "${S_HOSTS[@]}"; do elems+=("$vbase.$h : $base.$h"); done
  echo "# CCTV VPN site $S_ID ($S_NAME), written by $PROG: re-run its install to change."
  echo "# $S_VIRTUAL (what the CCTV server uses) <-> $S_REAL_LAN on $L_IF; from the tunnel only TCP $S_PORT + ping."
  echo "table ip $TABLE"
  echo "delete table ip $TABLE"
  echo "table ip $TABLE {"
  echo "  # virtual address (10.78.$S_ID.x) -> real NVR address; nothing else is translated"
  echo "  map nvr_hosts {"
  echo "    type ipv4_addr : ipv4_addr"
  printf '    elements = {'
  for ((i = 0; i < ${#elems[@]}; i++)); do
    ((i % 4 == 0)) && printf '\n     '
    printf ' %s' "${elems[$i]}"
    ((i < ${#elems[@]} - 1)) && printf ','
  done
  printf '\n    }\n  }\n'
  echo "  counter nvr_connections {}"
  echo "  counter tunnel_dropped {}"
  [[ $PREV_FWD != 0 ]] || echo "  counter forward_dropped {}"
  echo "  chain prerouting {"
  echo "    type nat hook prerouting priority dstnat; policy accept;"
  echo "    iifname \"$IFNAME\" ip saddr $S_HUB_IP tcp dport $S_PORT dnat to ip daddr map @nvr_hosts"
  echo "    iifname \"$IFNAME\" ip saddr $S_HUB_IP icmp type echo-request dnat to ip daddr map @nvr_hosts"
  echo "  }"
  echo "  chain postrouting {"
  echo "    type nat hook postrouting priority srcnat; policy accept;"
  echo "    # the NVR sees this box ($L_ADDR) as the client, so its replies come back here"
  echo "    oifname \"$L_IF\" ip saddr $S_HUB_IP ct status dnat masquerade"
  echo "  }"
  echo "  chain input {"
  echo "    type filter hook input priority filter; policy accept;"
  echo "    iifname \"$IFNAME\" jump from_tunnel_to_me"
  echo "  }"
  echo "  chain from_tunnel_to_me {"
  echo "    ct state established,related accept"
  echo "    ip saddr $S_HUB_IP ip daddr $S_TUNNEL_IP icmp type echo-request limit rate 5/second accept"
  echo "    counter name tunnel_dropped drop"
  echo "  }"
  echo "  chain forward {"
  echo "    type filter hook forward priority filter; policy accept;"
  echo "    iifname \"$IFNAME\" jump from_tunnel"
  echo "    oifname \"$IFNAME\" jump to_tunnel"
  if [[ $PREV_FWD == 0 ]]; then
    echo "    # this box did not route before the install (ip_forward was 0): it forwards nothing but the"
    echo "    # tunnel's traffic above, so it does not become a router between its other networks"
    echo "    counter name forward_dropped drop"
  fi
  echo "  }"
  echo "  chain from_tunnel {"
  echo "    tcp flags & (syn | rst) == syn tcp option maxseg size > $S_MSS tcp option maxseg size set $S_MSS"
  echo "    ct state established,related accept"
  echo "    oifname \"$L_IF\" ip saddr $S_HUB_IP ip daddr $S_REAL_LAN ct status dnat ct state new tcp dport $S_PORT counter name nvr_connections accept"
  echo "    oifname \"$L_IF\" ip saddr $S_HUB_IP ip daddr $S_REAL_LAN ct status dnat ct state new icmp type echo-request accept"
  echo "    counter name tunnel_dropped drop"
  echo "  }"
  echo "  chain to_tunnel {"
  echo "    tcp flags & (syn | rst) == syn tcp option maxseg size > $S_MSS tcp option maxseg size set $S_MSS"
  echo "    ct state established,related accept"
  echo "    counter name tunnel_dropped drop"
  echo "  }"
  echo "}"
}

render_site_env() { # what this box was set up with (no secrets)
  echo "# CCTV VPN site gateway settings, written by $PROG (no secrets; the key is in /etc/wireguard/$IFNAME.conf)"
  echo "CCTV_VPN_BUNDLE=1"
  echo "SITE_ID=$S_ID"
  echo "SITE_NAME=$S_NAME"
  echo "TUNNEL_IP=$S_TUNNEL_IP"
  echo "VIRTUAL_SUBNET=$S_VIRTUAL"
  echo "REAL_LAN=$S_REAL_LAN"
  echo "HUB_TUNNEL_IP=$S_HUB_IP"
  echo "HUB_ENDPOINT=$S_ENDPOINT"
  echo "HUB_WG_ENDPOINT=$S_WG_ENDPOINT"
  echo "HUB_PUBLIC_KEY=$S_HUB_PUB"
  echo "SITE_PUBLIC_KEY=$S_PUB"
  echo "NVR_PORT=$S_PORT"
  echo "KEEPALIVE=$S_KEEPALIVE"
  echo "MTU=$S_MTU"
  echo "IFNAME=$IFNAME"
  echo "LAN_IF=$L_IF"
  echo "LAN_ADDR=$L_ADDR"
  echo "ONLY=$OPT_ONLY"
  echo "MODE=$MODE"
  echo "TABLE=$TABLE"
  echo "PREV_IP_FORWARD=$PREV_FWD"
}

render_units() { # -> files under $R/etc/systemd/system
  local d=$R/etc/systemd/system nft
  nft=$(command -v nft)
  [[ $nft == /* ]] || nft=/usr/sbin/nft
  install -d -m 755 "$d" "$d/wg-quick@$IFNAME.service.d"
  cat >"$d/$PROG-firewall.service" <<EOF
# CCTV VPN site gateway: firewall + NAT (nft table ip $TABLE). Written by $PROG.
# Loaded before the tunnel; stopping it also stops the tunnel (see wg-quick@$IFNAME drop-in).
# PartOf nftables.service: a restart of that one ("flush ruleset" in /etc/nftables.conf) reloads this.
[Unit]
Description=CCTV VPN site gateway firewall (nft table ip $TABLE)
DefaultDependencies=no
After=nftables.service
PartOf=nftables.service
Before=network-pre.target wg-quick@$IFNAME.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$nft -f /etc/cctv-site/firewall.nft
ExecStop=-$nft delete table ip $TABLE

[Install]
WantedBy=multi-user.target
EOF
  cat >"$d/wg-quick@$IFNAME.service.d/$PROG.conf" <<EOF
# CCTV VPN: the tunnel only runs with its firewall loaded. Written by $PROG.
[Unit]
Requires=$PROG-firewall.service
After=$PROG-firewall.service network-online.target
Wants=network-online.target

[Service]
Restart=on-failure
RestartSec=30
# a DNS hub address: look it up again (IPv4) right after the tunnel starts, in case it moved while
# this box was off (the config holds the address found at install)
ExecStartPost=-/usr/local/sbin/$PROG reresolve --force
EOF
  cat >"$d/$PROG-reresolve.service" <<EOF
# CCTV VPN: look the hub's DNS name up again when the tunnel has been silent. Written by $PROG.
[Unit]
Description=CCTV VPN: re-resolve the hub address when the tunnel is silent
After=wg-quick@$IFNAME.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/$PROG reresolve
EOF
  cat >"$d/$PROG-reresolve.timer" <<EOF
[Unit]
Description=CCTV VPN: check the hub address every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF
  chmod 644 "$d/$PROG-firewall.service" "$d/wg-quick@$IFNAME.service.d/$PROG.conf" "$d/$PROG-reresolve.service" "$d/$PROG-reresolve.timer"
}

# ---------- commands ----------
OPT_LAN=""
OPT_LAN_IF=""
OPT_ONLY=""
OPT_KEY=""
OPT_PACKAGES=1
OPT_NO_WAIT=0
OPT_FORCE=0
PREV_FWD=0
S_WG_ENDPOINT=""
IFNAME=wg-cctv
R=""
MODE=systemd
S_LAN_DETECTED=0

parse_opts() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --lan) OPT_LAN=${2:?--lan needs a value}; shift ;;
      --lan-if) OPT_LAN_IF=${2:?--lan-if needs a value}; shift ;;
      --only) OPT_ONLY=${2:?--only needs a value}; shift ;;
      --ifname) IFNAME=${2:?--ifname needs a value}; shift ;;
      --key) OPT_KEY=${2:?--key needs a value}; shift ;;
      --no-packages) OPT_PACKAGES=0 ;;
      --no-wait) OPT_NO_WAIT=1 ;;
      --root) R=${2:?--root needs a value}; shift ;;
      --no-systemd) MODE=direct ;;
      *) die "unknown option $1 (see the top of this script)" ;;
    esac
    shift
  done
  # --no-systemd changes the network of the namespace it runs in: tests only, never the real one
  if [[ $MODE == direct ]] && netns_is_main; then die "--no-systemd is for tests inside a network namespace (ip netns exec ...): refused here"; fi
  if [[ -n ${CCTV_SITE_TABLE:-} ]]; then
    [[ -n $R ]] || die "CCTV_SITE_TABLE is for tests with --root only"
    [[ $CCTV_SITE_TABLE =~ ^[a-z][a-z0-9_]{0,31}$ ]] || die "CCTV_SITE_TABLE: bad table name"
    TABLE=$CCTV_SITE_TABLE
  fi
  is_ifname "$IFNAME" || die "--ifname: bad interface name"
  [[ -z $OPT_LAN_IF ]] || is_ifname "$OPT_LAN_IF" || die "--lan-if: bad interface name"
  [[ -z $OPT_LAN_IF ]] || ip link show dev "$OPT_LAN_IF" >/dev/null 2>&1 || die "--lan-if: no interface $OPT_LAN_IF here"
  [[ -z $OPT_ONLY || $OPT_ONLY =~ ^[0-9.,]{7,}$ ]] || die "--only: comma-separated IPv4 addresses"
  if [[ -n $R ]]; then
    [[ $R == /* && $R != / && -d $R ]] || die "--root must be an existing absolute folder"
    R=${R%/}
  fi
  return 0
}

need_tools() {
  local missing=()
  command -v wg >/dev/null 2>&1 || missing+=(wireguard-tools)
  command -v nft >/dev/null 2>&1 || missing+=(nftables)
  command -v ip >/dev/null 2>&1 || missing+=(iproute2)
  if [[ ${#missing[@]} -gt 0 ]]; then
    if [[ $1 == install && $OPT_PACKAGES == 1 ]] && command -v apt-get >/dev/null 2>&1; then
      say "installing ${missing[*]}"
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}"
    else
      die "missing: ${missing[*]} (apt-get install ${missing[*]})"
    fi
  fi
  command -v wg-quick >/dev/null 2>&1 || die "wg-quick missing (package wireguard-tools)"
}

plan() {
  local only="the whole /24"
  [[ -n $OPT_ONLY ]] && only="only $OPT_ONLY"
  say "CCTV VPN site $S_ID ($S_NAME)"
  echo "  tunnel:      $IFNAME $S_TUNNEL_IP -> hub $S_HUB_IP at $S_ENDPOINT$([[ $S_EP_KIND == name ]] && echo " = $S_WG_ENDPOINT (IPv4)") (via $S_EP_DEV; keepalive $S_KEEPALIVE s, MTU $S_MTU)"
  echo "  site LAN:    $S_REAL_LAN on $L_IF (this box: $L_ADDR, connected network $L_NET)"
  echo "  mapping:     $S_VIRTUAL on the CCTV server <-> $S_REAL_LAN here, host by host (10.78.$S_ID.x = ${S_REAL_LAN%.*}.x)"
  echo "  allowed:     from the hub to $only: TCP $S_PORT and ping. Nothing else, and nothing into the tunnel"
  if [[ $PREV_FWD == 0 ]]; then
    echo "  routing:     this box did not route before (ip_forward 0): it forwards ONLY the tunnel's NVR traffic;"
    echo "               everything else between its networks stays dropped (uninstall puts ip_forward back to 0)"
  else
    echo "  routing:     this box already routed (ip_forward 1, e.g. it is the site router): its own routing and"
    echo "               firewall stay as they are; only the tunnel's traffic is filtered here"
  fi
  if [[ $S_LAN_DETECTED == 1 ]]; then
    echo "  NOTE:        the bundle had no REAL_LAN; this box is on $S_REAL_LAN. Record that for site $S_ID on the CCTV server."
  fi
  if [[ $S_EP_DEV == "$L_IF" ]]; then
    echo "  layout:      one network port (the hub is reached through the site router on $L_IF): fine"
  fi
}

print_return_path() {
  local gw who
  gw=$(ip -4 route show default dev "$L_IF" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}') || true
  if [[ -n $gw ]]; then
    who="The NVR's default gateway (probably the site router $gw) needs no route or change."
  else
    who="Whatever default gateway the NVR uses (often this box, when it is the site router) needs no route or change."
  fi
  say "how the NVR's replies come back"
  echo "  The CCTV server's connection arrives here from $S_HUB_IP for 10.78.$S_ID.x; this box sends it on"
  echo "  to ${S_REAL_LAN%.*}.x with ITS OWN LAN address $L_ADDR as the source (masquerade). The NVR"
  echo "  therefore answers $L_ADDR directly on the LAN, and this box passes the answer back into the"
  echo "  tunnel. $who"
  echo "  If the NVR has an IP allow-list (TVT: Network > Security / IP filter), allow $L_ADDR."
  echo "  The NVRs need fixed addresses (static or a DHCP reservation): the CCTV server adds them by address."
}

print_tests() {
  local ex=${S_REAL_LAN%.*}.10
  [[ -n $OPT_ONLY ]] && ex=${OPT_ONLY%%,*}
  say "tests"
  echo "  here:            wg show $IFNAME          ('latest handshake' under ~2 min = tunnel up)"
  echo "                   $PROG status"
  echo "                   timeout 3 bash -c '</dev/tcp/$ex/$S_PORT' && echo open   (this box reaches the NVR)"
  echo "                   ping 10.77.0.1 is NOT answered by design (the hub accepts no new traffic from sites)"
  echo "  on the server:   ping -c3 $S_TUNNEL_IP          (this gateway)"
  echo "                   ping -c3 10.78.$S_ID.${ex##*.}; nc -zv 10.78.$S_ID.${ex##*.} $S_PORT   (the NVR through the tunnel)"
  echo "  in the app:      add the NVR at 10.78.$S_ID.${ex##*.} port $S_PORT (real address $ex)"
}

wait_handshake() { # 0 = a handshake less than 180 s old within 20 s
  local i ts now
  for i in $(seq 1 20); do
    ts=$(wg show "$IFNAME" latest-handshakes 2>/dev/null | awk -v k="$S_HUB_PUB" '$1==k {print $2}') || true
    now=$(date +%s)
    if [[ $ts =~ ^[0-9]+$ ]] && ((ts > 0 && now - ts < 180)); then
      echo "  handshake with the hub: $((now - ts)) s ago -> tunnel UP"
      return 0
    fi
    sleep 1
  done
  echo "  no handshake with the hub within 20 s. Check: internet here; HUB_ENDPOINT $S_ENDPOINT;"
  echo "  the main site's router forwards UDP $S_EP_PORT to the CCTV server; the server knows this site's key;"
  echo "  this site's network lets UDP $S_EP_PORT out (some 4G APNs block it: ask for a bundle on UDP 443)."
  return 1
}

cmd_check_or_install() {
  local what=$1 bundle=${2:-}
  shift 2 || die "usage: $what <bundle folder or .tar.gz> [options]"
  [[ -n $bundle ]] || die "usage: $what <bundle folder or .tar.gz> [options]"
  parse_opts "$@"
  [[ $(id -u) == 0 ]] || die "run as root (sudo)"
  need_tools "$what"
  load_bundle "$bundle"
  check_bundle
  detect_lan
  hosts_of_lan
  check_box
  PREV_FWD=$(sysctl -n net.ipv4.ip_forward)
  if [[ -f $R/etc/cctv-site/site.env ]]; then # keep what the box had before the first install
    local p
    p=$(sed -n 's/^PREV_IP_FORWARD=//p' "$R/etc/cctv-site/site.env")
    [[ $p == 0 || $p == 1 ]] && PREV_FWD=$p
  fi
  plan
  other_firewalls
  if [[ $what == check ]]; then
    say "check passed: nothing was changed. Run the same command with 'install' to set it up."
    return 0
  fi

  say "writing files"
  install -d -m 700 "$R/etc/cctv-site" "$R/etc/wireguard"
  render_site_env >"$R/etc/cctv-site/site.env.new" && mv "$R/etc/cctv-site/site.env.new" "$R/etc/cctv-site/site.env"
  render_nft >"$R/etc/cctv-site/firewall.nft.new"
  nft -c -f "$R/etc/cctv-site/firewall.nft.new" || die "the generated firewall does not load (nft too old?): nothing changed"
  mv "$R/etc/cctv-site/firewall.nft.new" "$R/etc/cctv-site/firewall.nft"
  local conf=$R/etc/wireguard/$IFNAME.conf changed=1
  render_wgconf >"$conf.new"
  chmod 600 "$conf.new"
  if [[ -f $conf ]] && cmp -s "$conf" "$conf.new"; then changed=0; fi
  mv "$conf.new" "$conf"
  install -d -m 755 "$R/usr/local/sbin"
  local self
  self=$(readlink -f "${BASH_SOURCE[0]}")
  [[ $self == "$(readlink -f "$R/usr/local/sbin/$PROG" 2>/dev/null || true)" ]] || install -m 755 "$self" "$R/usr/local/sbin/$PROG"
  echo "  $R/etc/cctv-site/{site.env,firewall.nft}, $conf (0600, holds the key), $R/usr/local/sbin/$PROG"

  if [[ $MODE == systemd ]]; then
    [[ -z $R ]] || { render_units; echo "  units written under $R (not started: --root)"; return 0; }
    render_units
    if [[ $PREV_FWD == 0 ]]; then
      printf '# CCTV VPN site gateway (%s); removed by "%s uninstall"\nnet.ipv4.ip_forward = 1\n' "$PROG" "$PROG" >/etc/sysctl.d/90-cctv-site.conf
      chmod 644 /etc/sysctl.d/90-cctv-site.conf
    fi
    systemctl daemon-reload
    say "firewall, forwarding, tunnel"
    systemctl enable "$PROG-firewall.service" >/dev/null 2>&1
    systemctl restart "$PROG-firewall.service" # loads the new table first
    sysctl -q -w net.ipv4.ip_forward=1
    systemctl enable "wg-quick@$IFNAME.service" >/dev/null 2>&1
    if [[ $changed == 1 ]] || ! systemctl is-active --quiet "wg-quick@$IFNAME.service"; then
      systemctl restart "wg-quick@$IFNAME.service"
    fi
    if [[ $S_EP_KIND == name ]]; then
      systemctl enable --now "$PROG-reresolve.timer" >/dev/null 2>&1
    else
      systemctl disable --now "$PROG-reresolve.timer" >/dev/null 2>&1 || true
    fi
  else
    say "firewall, forwarding, tunnel (no systemd: this network namespace only, not persistent)"
    nft -f "$R/etc/cctv-site/firewall.nft"
    sysctl -q -w net.ipv4.ip_forward=1
    if ip link show dev "$IFNAME" >/dev/null 2>&1; then
      if [[ $changed == 1 ]]; then
        wg-quick down "$conf" >/dev/null 2>&1 || ip link del dev "$IFNAME"
        wg-quick up "$conf" 2>&1 | sed "s/^/  /"
      fi
    else
      wg-quick up "$conf" 2>&1 | sed "s/^/  /"
    fi
  fi
  local up=1
  if ((OPT_NO_WAIT)); then
    echo "  (--no-wait: not waiting for the first handshake; check later with: $PROG status)"
  elif ! wait_handshake; then
    up=0
  fi
  print_return_path
  print_tests
  if ((up == 0)); then
    say "installed, but NOT connected: site $S_ID ($S_NAME) has no handshake with the CCTV server (see above)"
    echo "  The tunnel keeps trying by itself; fix the cause, then: $PROG status"
    exit 5
  fi
  say "done: site $S_ID ($S_NAME) is set up"
}

load_installed() {
  [[ -f $R/etc/cctv-site/site.env ]] || die "this box is not set up as a CCTV VPN site gateway (no $R/etc/cctv-site/site.env)"
  ENV=()
  parse_env "$R/etc/cctv-site/site.env"
  IFNAME=${ENV[IFNAME]:-wg-cctv}
  is_ifname "$IFNAME" || die "bad IFNAME in site.env"
  MODE=${ENV[MODE]:-systemd}
  [[ $MODE == systemd || $MODE == direct ]] || die "bad MODE in site.env"
  TABLE=${ENV[TABLE]:-cctv_site}
  [[ $TABLE =~ ^[a-z][a-z0-9_]{0,31}$ ]] || die "bad TABLE in site.env"
  if [[ $MODE == direct ]] && netns_is_main; then die "this was a test install (--no-systemd) and this is the main network namespace: refused"; fi
}

cmd_status() {
  parse_opts "$@"
  load_installed
  local ts now age=never
  say "CCTV VPN site ${ENV[SITE_ID]} (${ENV[SITE_NAME]})"
  echo "  mapping:   ${ENV[VIRTUAL_SUBNET]} <-> ${ENV[REAL_LAN]} on ${ENV[LAN_IF]} (${ENV[ONLY]:-whole /24}); hub ${ENV[HUB_ENDPOINT]}"
  if ip link show dev "$IFNAME" >/dev/null 2>&1; then
    ts=$(wg show "$IFNAME" latest-handshakes 2>/dev/null | awk '{print $2; exit}') || true
    now=$(date +%s)
    if [[ -n $ts && $ts != 0 ]]; then age="$((now - ts)) s ago"; fi
    echo "  tunnel:    $IFNAME up; latest handshake: $age$([[ -n $ts && $ts != 0 && $((now - ts)) -lt 180 ]] && echo ' (connected)' || echo ' (NOT connected)')"
    wg show "$IFNAME" transfer 2>/dev/null | awk '{printf "  transfer:  received %d B, sent %d B\n", $2, $3}'
    wg show "$IFNAME" endpoints 2>/dev/null | awk '{print "  hub now:   " $2}'
  else
    echo "  tunnel:    $IFNAME is DOWN"
  fi
  if nft list table ip "$TABLE" >/dev/null 2>&1; then
    echo "  firewall:  table ip $TABLE loaded; NVR connections allowed: $(nft list counter ip "$TABLE" nvr_connections 2>/dev/null | awk '/packets/ {print $2; exit}'), tunnel packets dropped: $(nft list counter ip "$TABLE" tunnel_dropped 2>/dev/null | awk '/packets/ {print $2; exit}')"
  else
    echo "  firewall:  NOT loaded (the tunnel must not run without it)"
  fi
  echo "  forwarding: net.ipv4.ip_forward = $(sysctl -n net.ipv4.ip_forward)$([[ ${ENV[PREV_IP_FORWARD]:-} == 0 ]] && echo " (tunnel traffic only; other forwarded packets dropped: $(nft list counter ip "$TABLE" forward_dropped 2>/dev/null | awk '/packets/ {print $2; exit}'))")"
  if [[ ${ENV[MODE]:-} == systemd && -z $R ]]; then
    systemctl --no-pager --plain list-units "$PROG-firewall.service" "wg-quick@$IFNAME.service" "$PROG-reresolve.timer" 2>/dev/null | sed -n '1,4p' | sed 's/^/  /'
  fi
}

cmd_reresolve() { # timer (and tunnel start, --force): follow the hub's DNS name, IPv4 only
  local args=() a
  for a in "$@"; do if [[ $a == --force ]]; then OPT_FORCE=1; else args+=("$a"); fi; done
  parse_opts "${args[@]}"
  load_installed
  local ep=${ENV[HUB_ENDPOINT]} pub=${ENV[HUB_PUBLIC_KEY]} ts now addr cur
  is_key "$pub" || die "bad HUB_PUBLIC_KEY in site.env"
  [[ $ep =~ ^([^:]+):([0-9]+)$ ]] || exit 0
  local host=${BASH_REMATCH[1]} port=${BASH_REMATCH[2]} # (is_hostname overwrites BASH_REMATCH)
  is_hostname "$host" && is_port "$port" || exit 0      # an IP address: nothing to re-resolve
  ip link show dev "$IFNAME" >/dev/null 2>&1 || exit 0
  ts=$(wg show "$IFNAME" latest-handshakes 2>/dev/null | awk -v k="$pub" '$1==k {print $2}') || true
  now=$(date +%s)
  # a working tunnel is left alone (unless --force); a silent one gets the name looked up again
  if ((OPT_FORCE == 0)) && [[ $ts =~ ^[0-9]+$ ]] && ((ts > 0 && now - ts < REresolve_AFTER)); then exit 0; fi
  addr=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1; exit}') || true
  if ! is_ip4 "${addr:-x}"; then
    echo "cannot resolve $host to IPv4 right now: the tunnel keeps dialing $(wg show "$IFNAME" endpoints 2>/dev/null | awk '{print $2}')"
    exit 0
  fi
  cur=$(wg show "$IFNAME" endpoints 2>/dev/null | awk -v k="$pub" '$1==k {print $2}') || true
  [[ $cur != "$addr:$port" ]] || exit 0
  wg set "$IFNAME" peer "$pub" endpoint "$addr:$port" && echo "hub $host now $addr:$port (was ${cur:-none})"
}

cmd_uninstall() {
  parse_opts "$@"
  [[ $(id -u) == 0 ]] || die "run as root (sudo)"
  load_installed
  local prev=${ENV[PREV_IP_FORWARD]:-0} conf=$R/etc/wireguard/$IFNAME.conf
  say "removing the CCTV VPN site gateway (site ${ENV[SITE_ID]})"
  if [[ $MODE == systemd && -z $R ]]; then
    systemctl disable --now "$PROG-reresolve.timer" >/dev/null 2>&1 || true
    systemctl disable --now "wg-quick@$IFNAME.service" >/dev/null 2>&1 || true
    systemctl disable --now "$PROG-firewall.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$PROG-firewall.service" "/etc/systemd/system/$PROG-reresolve.service" "/etc/systemd/system/$PROG-reresolve.timer"
    rm -rf "/etc/systemd/system/wg-quick@$IFNAME.service.d"
    rm -f /etc/sysctl.d/90-cctv-site.conf
    systemctl daemon-reload
  else
    if ip link show dev "$IFNAME" >/dev/null 2>&1; then wg-quick down "$conf" >/dev/null 2>&1 || ip link del dev "$IFNAME"; fi
    rm -rf "$R/etc/systemd/system/$PROG-firewall.service" "$R/etc/systemd/system/$PROG-reresolve.service" "$R/etc/systemd/system/$PROG-reresolve.timer" "$R/etc/systemd/system/wg-quick@$IFNAME.service.d"
  fi
  nft delete table ip "$TABLE" 2>/dev/null || true
  if [[ $prev == 0 ]]; then sysctl -q -w net.ipv4.ip_forward=0; fi
  rm -f "$conf"
  rm -rf "$R/etc/cctv-site"
  [[ -z $R ]] || rm -f "$R/usr/local/sbin/$PROG"
  echo "  removed: tunnel $IFNAME, its key, nft table ip $TABLE, units; ip_forward back to $prev"
  [[ -n $R ]] || echo "  (the program /usr/local/sbin/$PROG stays; delete it by hand if you like)"
}

main() {
  local cmd=${1:-}
  shift || true
  case "$cmd" in
    check | install) cmd_check_or_install "$cmd" "$@" ;;
    status) cmd_status "$@" ;;
    reresolve) cmd_reresolve "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    *) sed -n '2,41p' "${BASH_SOURCE[0]}"; exit 2 ;;
  esac
}

# site-recipes.sh sources this file for the bundle checks; run main only when executed
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
