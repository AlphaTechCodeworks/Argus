#!/usr/bin/env bash
# End-to-end simulation of the CCTV VPN. It drives the REAL cctv-vpn (hub) and site-gateway.sh
# (remote gateway, the copy inside each site bundle) inside network namespaces it creates, and
# removes everything again on exit (trap), also when a check or the script itself fails.
#
#   cvs-inet            the "internet" + a carrier NAT: sites dial out, nothing unsolicited gets in;
#                       it counts any packet addressed to the VPN ranges (must stay 0: no leaks)
#   cvs-hub             the CCTV server: cctv-vpn with CCTV_VPN_ROOT=<temp folder>, WireGuard
#                       interface cvhub0 and table inet cctv_vpn_sim (never wg0 / cctv_vpn);
#                       public 203.0.113.10, main-LAN address 192.168.3.147, a web UI stand-in on 8080
#   cvs-s1r / cvs-s1n   site "site1": gateway (the site router, site-gateway.sh) + NVR 192.168.1.10
#   cvs-s2r / cvs-s2n   site "site2": the SAME LAN 192.168.1.0/24 and the same NVR address
#   Each NVR answers its site name on TCP 6036 and "ssh-<site>" on 22 (which must stay unreachable).
#   Listeners bind high ports and nft redirects 6036/22/8080 to them: under WSL every bind() is
#   announced to Windows (even inside a namespace), and 22/8080 are in use there / by the cctv app.
#   DNS names (the hub as vpn.example.test with an A and an AAAA record) come from a hosts file
#   bind-mounted over /etc/hosts in a private mount namespace of the one command that needs it.
#
# Site ids start at 2 (10.77.0.1 is the hub, so there is no site 1): site1 = id 2 = 10.78.2.x,
# site2 = id 3 = 10.78.3.x (later id 4). Needs root, wireguard-tools, nftables, python3, gpg,
# unshare (node: optional, runs the app's own status reader). Takes about 5 minutes (one step
# waits for an idle tunnel to re-key). The main namespace (links, addresses, rules, routes, nft
# ruleset, ip_forward, namespaces, WireGuard interfaces, gnupg folders) is compared before and after.
#   sudo bash test-sim.sh        (cctv-vpn and site-gateway.sh are taken from this folder)
#   SIM_KEEP=<dir>               also copy the rendered Windows / EdgeOS / RutOS recipe files (no
#                                private keys) there, for a syntax check elsewhere
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VPN=$here/cctv-vpn
GW=$here/site-gateway.sh
NSS=(cvs-hub cvs-inet cvs-s1r cvs-s1n cvs-s2r cvs-s2n)
HIF=cvhub0
HTABLE=cctv_vpn_sim
GIF=cvgw0
GTABLE=cctv_site_sim
HUB_WAN=203.0.113.10

[[ $(id -u) == 0 ]] || { echo "run as root" >&2; exit 1; }
for t in ip wg wg-quick nft python3 tar sha256sum flock ss awk gpg gpgconf unshare realpath; do command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done
[[ -f $VPN && -f $GW ]] || { echo "cctv-vpn and site-gateway.sh must be next to this script" >&2; exit 1; }
[[ $(readlink /proc/self/ns/net) == "$(readlink /proc/1/ns/net)" ]] || { echo "start this from the main namespace (it makes its own)" >&2; exit 1; }
if [[ -n ${SIM_KEEP:-} ]]; then [[ $SIM_KEEP == /* && -d $SIM_KEEP ]] || { echo "SIM_KEEP must be an existing absolute folder" >&2; exit 1; }; fi

main_state() { # the main namespace, without counters and lifetimes
  echo "## links"; ip -br link
  echo "## addresses"; ip -br addr
  echo "## rules"; ip rule; ip -6 rule
  echo "## routes"; ip -4 route show table all; ip -6 route show table all | sed -E 's/ expires [0-9]+sec//'
  echo "## nft"; nft list ruleset | sed -E 's/counter packets [0-9]+ bytes [0-9]+/counter/g'
  echo "## sysctl"; sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding
  echo "## netns"; ip netns list
  echo "## wireguard"; wg show interfaces
  echo "## files"; ls -d /root/.gnupg /run/user/0/gnupg /etc/netns 2>/dev/null || true; ls -a /run/user/0/gnupg 2>/dev/null || true
}
T=""
SECTION=start
BEFORE=$(mktemp /tmp/cvs-main-before.XXXXXX)
AFTER=$(mktemp /tmp/cvs-main-after.XXXXXX)
MODS_BEFORE=$(mktemp /tmp/cvs-mods-before.XXXXXX)
MODS_AFTER=$(mktemp /tmp/cvs-mods-after.XXXXXX)
cleanup() {
  local ns pids
  for ns in "${NSS[@]}"; do
    if [[ -e /run/netns/$ns ]]; then
      pids=$(ip netns pids "$ns" 2>/dev/null | tr '\n' ' ' || true)
      [[ -z ${pids// /} ]] || kill $pids 2>/dev/null || true
    fi
  done
  sleep 0.3
  for ns in "${NSS[@]}"; do
    if [[ -e /run/netns/$ns ]]; then
      pids=$(ip netns pids "$ns" 2>/dev/null | tr '\n' ' ' || true)
      [[ -z ${pids// /} ]] || kill -9 $pids 2>/dev/null || true
      ip netns del "$ns" 2>/dev/null || true
    fi
  done
  if [[ -n $T && -d $T ]]; then rm -rf -- "$T"; fi
}
finish() {
  local rc=$?
  trap - EXIT
  set +e
  if [[ $SECTION != result ]]; then printf '\nABORTED (exit %s) in section "%s": cleaning up\n' "$rc" "$SECTION"; ((rc != 0)) || rc=1; fi
  cleanup
  main_state >"$AFTER" 2>&1
  printf '\n---- cleanup\n'
  lsmod | awk 'NR > 1 {print $1}' | sort >"$MODS_AFTER"
  newmods=$(comm -13 "$MODS_BEFORE" "$MODS_AFTER" | tr '\n' ' ')
  echo "kernel modules loaded on demand during the run (no network state of their own): ${newmods:-none}"
  if cmp -s "$BEFORE" "$AFTER"; then
    echo "main namespace unchanged (links, addresses, rules, routes, nft ruleset, ip_forward, namespaces, wireguard, gnupg folders); namespaces cvs-* deleted, temp files removed"
  else
    echo "MAIN NAMESPACE CHANGED:"
    diff "$BEFORE" "$AFTER"
    rc=1
  fi
  rm -f "$BEFORE" "$AFTER" "$MODS_BEFORE" "$MODS_AFTER"
  exit "$rc"
}
# namespaces left over by a killed earlier run of this script (our names only)
cleanup
main_state >"$BEFORE" 2>&1
lsmod | awk 'NR > 1 {print $1}' | sort >"$MODS_BEFORE"
trap finish EXIT
trap 'exit 130' INT TERM HUP
T=$(mktemp -d /tmp/cvs-sim.XXXXXX)
HR=$T/hub
mkdir -m 0700 "$HR" "$T/mainroot" "$T/fakebin"
VD=$HR/etc/cctv/vpn
SF=$HR/run/cctv/vpn-status.json
NFT_BIN=$(command -v nft)

# ---------------------------------------------------------------- helpers
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
section() { SECTION=$1; printf '\n---- %s\n' "$*"; }
oneline() { tr '\n' ' ' <<<"$1" | sed -E 's/ +/ /g; s/ $//' | cut -c1-240; }
lastline() { local l; l=$(grep -v '^\s*$' <<<"$1" | tail -n1 || true); printf '%s' "${l:0:200}"; }
has() { # label text needle: the output holds the needle
  if [[ $2 == *"$3"* ]]; then ok "$1"; else bad "$1  [no '$3' in: $(oneline "$2")]"; fi
}
nx() { ip netns exec "$@"; }
hub() { ip netns exec cvs-hub env CCTV_VPN_ROOT="$HR" CCTV_VPN_IF="$HIF" CCTV_VPN_TABLE="$HTABLE" bash "$VPN" "$@"; }
# one command with a hosts file over /etc/hosts (private mount namespace: nothing outside sees it)
withhosts() { local h=$1 ns=$2; shift 2; ip netns exec "$ns" unshare -m --propagation private sh -c 'mount --bind "$0" /etc/hosts && exec "$@"' "$h" "$@"; }
hubdns() { withhosts "$T/hosts" cvs-hub env CCTV_VPN_ROOT="$HR" CCTV_VPN_IF="$HIF" CCTV_VPN_TABLE="$HTABLE" bash "$VPN" "$@"; }
# the hub with an nft that fails every load (-f): to prove the fail-closed paths
hubfail() { ip netns exec cvs-hub env PATH="$T/fakebin:$PATH" CCTV_VPN_ROOT="$HR" CCTV_VPN_IF="$HIF" CCTV_VPN_TABLE="$HTABLE" bash "$VPN" "$@"; }
check() { # label command... : must succeed
  local label=$1 out
  shift
  if out=$("$@" 2>&1); then ok "$label${out:+  [$(oneline "$out")]}"; else bad "$label  [$(oneline "$out")]"; fi
}
check_not() { # label command... : must fail
  local label=$1 out
  shift
  if out=$("$@" 2>&1); then bad "$label  [it succeeded: $(oneline "$out")]"; else ok "$label${out:+  [$(oneline "$out")]}"; fi
}
expect_rc() { # label rc command...
  local label=$1 want=$2 out rc=0
  shift 2
  out=$("$@" 2>&1) || rc=$?
  if [[ $rc == "$want" ]]; then ok "$label: exit $rc  [$(lastline "$out")]"; else bad "$label: exit $rc, want $want  [$(oneline "$out")]"; fi
  LAST_OUT=$out
}
LAST_OUT=""
probe() { nx "$1" python3 "$T/net.py" probe "$2" "$3" "${4:-3}" 2>&1 || true; }
expect_answer() { # label ns host port text
  local r
  r=$(probe "$2" "$3" "$4")
  if [[ $r == "OPEN $5 ("* ]]; then ok "$1  [$r]"; else bad "$1  [$r]"; fi
}
expect_blocked() { # label ns host port [timeout]
  local r
  r=$(probe "$2" "$3" "$4" "${5:-3}")
  if [[ $r != OPEN* ]]; then ok "$1  [$r]"; else bad "$1  [$r]"; fi
  LAST_PROBE=$r
}
LAST_PROBE=""
wait_answer() { # label ns host port text seconds [max]: retry until it answers (a PASS needs <= max s)
  local t0=$SECONDS r="" max=${7:-$6}
  while ((SECONDS - t0 < $6)); do
    r=$(probe "$2" "$3" "$4" 2)
    if [[ $r == "OPEN $5 ("* ]]; then
      if ((SECONDS - t0 <= max)); then ok "$1 after $((SECONDS - t0)) s  [$r]"; else bad "$1 only after $((SECONDS - t0)) s (want <= $max s)  [$r]"; fi
      return 0
    fi
    sleep 1
  done
  bad "$1: not back after $6 s  [$r]"
}
site_id() { # name -> id from the hub's records
  local f
  for f in "$VD"/sites/*/site.conf; do
    if [[ -f $f ]] && grep -qx "NAME=$1" "$f"; then f=${f%/site.conf}; printf '%s' "${f##*/}"; return 0; fi
  done
  return 1
}
pub_of() { sed -n 's/^PUBLIC_KEY=//p' "$VD/sites/$1/site.conf"; }
handshake_of() { nx cvs-hub wg show "$HIF" latest-handshakes | awk -v k="$1" '$1 == k {print $2}'; }
endpoint_of() { nx "$1" wg show "$2" endpoints | awk -v k="$3" '$1 == k {print $2}'; }
wait_handshake() { # pubkey seconds
  local i t
  for ((i = 0; i < $2; i++)); do
    t=$(handshake_of "$1")
    if [[ -n $t && $t != 0 ]]; then echo "handshake after ${i} s"; return 0; fi
    sleep 1
  done
  echo "no handshake in $2 s"
  return 1
}
rule_packets() { # ns family table chain regex: packets counted by the first rule matching regex
  { nx "$1" nft list chain "$2" "$3" "$4" 2>/dev/null || true; } | awk -v re="$5" '$0 ~ re {for (i = 1; i <= NF; i++) if ($i == "packets") {print $(i + 1); exit}}'
}
counter_packets() { { nx "$1" nft list counter "$2" "$3" "$4" 2>/dev/null || true; } | awk '{for (i = 1; i <= NF; i++) if ($i == "packets") {print $(i + 1); exit}}'; }
leaked() { counter_packets cvs-inet ip carrier leaked; }
bare_accepts() { { nx cvs-hub nft -s list chain inet "$HTABLE" from_sites 2>/dev/null || true; } | grep -cx '[[:space:]]*accept' || true; }
from_sites_ok() { [[ $(bare_accepts) == 0 ]] && nx cvs-hub nft -s list chain inet "$HTABLE" from_sites 2>/dev/null | grep -q 'counter drop'; }
gw_install() { # ns root bundle extra-options... (GW_HOSTS=<hosts file>: names resolve through it)
  local ns=$1 root=$2 bundle=$3 x folder
  shift 3
  x=$T/x-${bundle##*/}
  rm -rf "$x"
  mkdir -p "$x" "$root"
  tar -xzf "$bundle" -C "$x"
  folder=$(ls "$x")
  if [[ -n ${GW_HOSTS:-} ]]; then
    withhosts "$GW_HOSTS" "$ns" env CCTV_SITE_TABLE="$GTABLE" bash "$x/$folder/site-gateway.sh" install "$bundle" --root "$root" --no-systemd --no-packages --ifname "$GIF" "$@"
  else
    nx "$ns" env CCTV_SITE_TABLE="$GTABLE" bash "$x/$folder/site-gateway.sh" install "$bundle" --root "$root" --no-systemd --no-packages --ifname "$GIF" "$@"
  fi
}
windows_ok() { # the setup script never writes a file and gives SYSTEM no file to run
  local code
  code=$(grep -v '^[[:space:]]*#' "$1")
  grep -q -- '-EncodedCommand $encoded' <<<"$code" || { echo "no -EncodedCommand"; return 1; }
  grep -qF 'System32\WindowsPowerShell\v1.0\powershell.exe' <<<"$code" || { echo "no full powershell path"; return 1; }
  if grep -E 'Set-Content|Out-File|New-Item|-File ' <<<"$code"; then echo "writes or runs a file"; return 1; fi
  echo "encoded command, full path, no file"
}
edgeos_ok() { # folder id: tunnel wg77; every NAT rule deleted before it is set; the remove file deletes them
  local f=$1/cctv-site-$2-edgeos.txt rm=$1/cctv-site-$2-edgeos-remove.txt r d s
  grep -qx 'delete interfaces wireguard wg77' "$f" || { echo "no wg77"; return 1; }
  if grep -q 'wireguard wg0' "$f"; then echo "wg0 named"; return 1; fi
  for r in 4410 4420 4710 4720 7400; do
    d=$(grep -n -x "delete service nat rule $r" "$f" | cut -d: -f1 | sed -n 1p)
    s=$(grep -n "^set service nat rule $r " "$f" | cut -d: -f1 | sed -n 1p)
    [[ -n $d && -n $s ]] && ((d < s)) || { echo "rule $r: delete at ${d:-?}, first set at ${s:-?}"; return 1; }
    grep -qx "delete service nat rule $r" "$rm" || { echo "the remove file lacks rule $r"; return 1; }
  done
  grep -q 'task-scheduler task cctv-vpn-reresolve' "$f" && [[ -f $1/cctv-vpn-reresolve.sh ]] || { echo "no DNS follow-up task"; return 1; }
  echo "wg77; rules 4410 4420 4710 4720 7400 each deleted before set; remove file; DNS task"
}
hub_state() { # everything cctv-vpn keeps (not the status file or saved endpoints) + the live peers
  (cd "$HR" && find etc usr -type f | sort | xargs sha256sum)
  nx cvs-hub wg show "$HIF" peers | sort
}

# the lab's tiny TCP tools (standard library only)
cat >"$T/net.py" <<'PY'
import errno, socket, sys, time

def serve(port, text):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    s.listen(16)
    while True:
        c, _ = s.accept()
        try:
            c.sendall((text + "\n").encode())
        except OSError:
            pass
        finally:
            c.close()

def probe(host, port, timeout):
    t0 = time.monotonic()
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        try:
            data = s.recv(200).decode(errors="replace").strip()
        except socket.timeout:
            data = "(connected, no data)"
        print("OPEN %s (%.2fs)" % (data, time.monotonic() - t0))
        return 0
    except socket.timeout:
        print("TIMEOUT (%.1fs)" % (time.monotonic() - t0))
        return 1
    except OSError as e:
        print("%s (%.2fs)" % (errno.errorcode.get(e.errno, str(e)), time.monotonic() - t0))
        return 2
    finally:
        s.close()

if sys.argv[1] == "serve":
    serve(int(sys.argv[2]), sys.argv[3])
else:
    sys.exit(probe(sys.argv[2], int(sys.argv[3]), float(sys.argv[4])))
PY
cat >"$T/checkjson.py" <<'PY'
import json, os, re, stat, sys, time
path, spec = sys.argv[1], json.loads(sys.argv[2])
bad = []
mode = stat.S_IMODE(os.stat(path).st_mode)
if mode != 0o644:
    bad.append("mode %o" % mode)
d = json.load(open(path))
KEY = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")
if list(d) != ["at", "hub", "sites"]:
    bad.append("top-level keys %s" % list(d))
if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", str(d.get("at"))):
    bad.append("at %r" % d.get("at"))
h = d.get("hub") or {}
if list(h) != ["publicKey", "listenPort", "address", "endpointHint"]:
    bad.append("hub keys %s" % list(h))
if not KEY.match(str(h.get("publicKey"))) or h.get("publicKey") != spec["hubPub"]:
    bad.append("hub publicKey %r" % h.get("publicKey"))
if (h.get("listenPort"), h.get("address"), h.get("endpointHint")) != (51820, "10.77.0.1/24", spec["hint"]):
    bad.append("hub values %s" % h)
sites = d.get("sites") or []
want = spec["sites"]
if [s.get("id") for s in sites] != [w["id"] for w in want]:
    bad.append("site ids %s, want %s" % ([s.get("id") for s in sites], [w["id"] for w in want]))
now = time.time()
for s, w in zip(sites, want):
    i = w["id"]
    if list(s) != ["id", "name", "tunnelIp", "virtualSubnet", "realLan", "endpoint", "latestHandshake", "rxBytes", "txBytes"]:
        bad.append("site %s keys %s" % (i, list(s)))
    for k, v in {"id": i, "name": w["name"], "tunnelIp": "10.77.0.%d" % i, "virtualSubnet": "10.78.%d.0/24" % i, "realLan": w["lan"]}.items():
        if s.get(k) != v:
            bad.append("site %s %s=%r, want %r" % (i, k, s.get(k), v))
    if not (isinstance(s.get("endpoint"), str) and re.fullmatch(r"\d+\.\d+\.\d+\.\d+:\d+", s["endpoint"])):
        bad.append("site %s endpoint %r" % (i, s.get("endpoint")))
    hs = s.get("latestHandshake")
    if not (type(hs) is int and 0 < hs <= now + 5):
        bad.append("site %s latestHandshake %r" % (i, hs))
    for k in ("rxBytes", "txBytes"):
        if not (type(s.get(k)) is int and s[k] > 0):
            bad.append("site %s %s %r" % (i, k, s.get(k)))
if bad:
    print("; ".join(bad))
    sys.exit(1)
print("mode 644, keys in the agreed order; " + ", ".join("id %d %s %s %s handshake %ds ago endpoint %s" % (
    s["id"], s["name"], s["tunnelIp"], s["virtualSubnet"], int(now - s["latestHandshake"]), s["endpoint"]) for s in sites))
PY
# an nft that refuses every load (-f), for the fail-closed checks; everything else is the real one
cat >"$T/fakebin/nft" <<EOF
#!/bin/sh
for a in "\$@"; do if [ "\$a" = "-f" ]; then echo "nft: simulated load failure" >&2; exit 1; fi; done
exec $NFT_BIN "\$@"
EOF
chmod 755 "$T/fakebin/nft"
printf '127.0.0.1 localhost\n203.0.113.10 vpn.example.test\n2001:db8:1::10 vpn.example.test\n' >"$T/hosts"
printf '127.0.0.1 localhost\n203.0.113.99 vpn.example.test\n2001:db8:1::10 vpn.example.test\n' >"$T/hosts-moved"
(umask 077; printf 'correct horse battery staple 42\n' >"$T/pass"; printf 'short\n' >"$T/shortpass"; printf 'not the right passphrase\n' >"$T/wrongpass")

# ---------------------------------------------------------------- topology
section "topology (namespaces ${NSS[*]})"
for ns in "${NSS[@]}"; do
  ip netns add "$ns"
  ip -n "$ns" link set lo up
done
link() { # nsA ifA nsB ifB: a veth pair made inside the namespaces (nothing in the main one)
  ip -n "$1" link add "$2" type veth peer name "$4" netns "$3"
  ip -n "$1" link set "$2" up
  ip -n "$3" link set "$4" up
}
link cvs-inet ih cvs-hub eth0
link cvs-inet i1 cvs-s1r wan
link cvs-inet i2 cvs-s2r wan
ip -n cvs-inet addr add 203.0.113.1/24 dev ih
ip -n cvs-inet addr add 100.64.1.1/24 dev i1
ip -n cvs-inet addr add 100.64.2.1/24 dev i2
nx cvs-inet sysctl -qw net.ipv4.ip_forward=1
nx cvs-inet nft -f - <<'EOF'
table ip carrier {
  counter leaked {
  }
  chain carrier_forward { type filter hook forward priority filter; policy accept;
    ip daddr { 10.77.0.0/24, 10.78.0.0/16 } counter name "leaked" drop
    ip saddr { 10.77.0.0/24, 10.78.0.0/16 } counter name "leaked" drop
    iifname "ih" ct state established,related accept
    iifname "ih" drop comment "carrier NAT: nothing unsolicited reaches a site"
  }
  chain carrier_input { type filter hook input priority filter; policy accept;
    ip daddr { 10.77.0.0/24, 10.78.0.0/16 } counter name "leaked" drop
  }
  chain post { type nat hook postrouting priority srcnat; policy accept;
    oifname "ih" ip saddr 100.64.0.0/16 masquerade
  }
}
EOF
ip -n cvs-hub addr add "$HUB_WAN/24" dev eth0
ip -n cvs-hub route add default via 203.0.113.1
# the hub's main-LAN side: a veth (never a dummy: loading the dummy module creates dummy0 in the
# MAIN namespace)
link cvs-hub lan0 cvs-inet hublan
ip -n cvs-hub addr add 192.168.3.147/22 dev lan0
nx cvs-hub nft -f - <<'EOF'
table ip sim_web {
  chain pre { type nat hook prerouting priority dstnat; policy accept;
    tcp dport 8080 redirect to :18080 comment "the web UI stand-in listens on 18080"
  }
}
EOF
nx cvs-hub setsid python3 "$T/net.py" serve 18080 hub-web </dev/null >/dev/null 2>&1 &
for s in 1 2; do
  r=cvs-s${s}r
  n=cvs-s${s}n
  ip -n "$r" addr add "100.64.$s.2/24" dev wan
  ip -n "$r" route add default via "100.64.$s.1"
  link "$r" lan "$n" eth0
  ip -n "$r" addr add 192.168.1.1/24 dev lan
  ip -n "$n" addr add 192.168.1.10/24 dev eth0
  ip -n "$n" route add default via 192.168.1.1
  nx "$n" nft -f - <<'EOF'
table ip sim_nvr {
  chain pre { type nat hook prerouting priority dstnat; policy accept;
    tcp dport 6036 redirect to :16036
    tcp dport 22 redirect to :10022
  }
}
EOF
  nx "$n" setsid python3 "$T/net.py" serve 16036 "site$s" </dev/null >/dev/null 2>&1 &
  nx "$n" setsid python3 "$T/net.py" serve 10022 "ssh-site$s" </dev/null >/dev/null 2>&1 &
done
sleep 0.7
echo "internet 203.0.113.1 / 100.64.1.1 / 100.64.2.1 (carrier NAT); hub $HUB_WAN + LAN 192.168.3.147; site1 and site2: router 192.168.1.1, NVR 192.168.1.10"

# ---------------------------------------------------------------- hub
section "hub: cctv-vpn hub-init inside cvs-hub (files under a temp root; interface $HIF, table inet $HTABLE)"
expect_rc "hub-init --endpoint $HUB_WAN" 0 hub hub-init --endpoint "$HUB_WAN"
sed -n '/^== checks/,/^== 1\./p' <<<"$LAST_OUT" | sed 's/^/  | /'
has "  it says there is no backup yet" "$LAST_OUT" "no backup of this hub yet"
check "$HIF is up in cvs-hub" ip -n cvs-hub -br link show "$HIF"
check "table inet $HTABLE is loaded in cvs-hub" nx cvs-hub nft list table inet "$HTABLE"
check "hub does not forward (ip_forward 0)" test "$(nx cvs-hub sysctl -n net.ipv4.ip_forward)" = 0
check_not "main namespace untouched: no $HIF, no wg0, no table inet cctv_vpn or $HTABLE there" \
  bash -c "ip link show $HIF || ip link show wg0 || nft list table inet cctv_vpn || nft list table inet $HTABLE"
expect_rc "hub-init again (idempotent)" 0 hub hub-init
check "the hub key survived the re-run" cmp "$VD/hub.pub" <(nx cvs-hub wg show "$HIF" public-key)
HUBPUB=$(cat "$VD/hub.pub")

section "sites: site-add, site-bundle"
expect_rc "site-add site1 --lan 192.168.1.0/24" 0 hub site-add site1 --lan 192.168.1.0/24
grep -E '^  (id|virtual|in the app)' <<<"$LAST_OUT" | sed 's/^/  | /'
expect_rc "site-add site2 --lan 192.168.1.0/24 (the same LAN)" 0 hub site-add site2 --lan 192.168.1.0/24
ID1=$(site_id site1)
ID2=$(site_id site2)
check "ids: site1 = 2, site2 = 3 (lowest free ids from 2; 1 would be the hub)" test "$ID1:$ID2" = 2:3
PUB1=$(pub_of "$ID1")
PUB2=$(pub_of "$ID2")
expect_rc "site-bundle site1" 0 hub site-bundle site1 --out "$T/b1.tar.gz"
has "  it warns that whoever copies it can stand in for the site" "$LAST_OUT" "can stand in for this site's gateway"
expect_rc "site-bundle site2 --forget-key without --out (the bundle would stay under /etc/cctv/vpn) is refused" 2 hub site-bundle site2 --forget-key
expect_rc "site-bundle site2 --forget-key --out into /etc/cctv/vpn is refused" 2 hub site-bundle site2 --forget-key --out "$VD/bundles/x.tar.gz"
expect_rc "site-bundle site2 --forget-key --out <transfer folder>" 0 hub site-bundle site2 --out "$T/b2.tar.gz" --forget-key
check "site2's private key is gone from the hub (KEY_ON_HUB=no, KEY_ORIGIN=forgotten)" bash -c "[ ! -e '$VD/sites/$ID2/private.key' ] && grep -x KEY_ON_HUB=no '$VD/sites/$ID2/site.conf' && grep -x KEY_ORIGIN=forgotten '$VD/sites/$ID2/site.conf'"
check "and no bundle holding it is left on the hub" bash -c "! ls '$VD'/bundles/*.tar.gz 2>/dev/null"
expect_rc "site-bundle site2 again: refused, the key was exported and forgotten" 3 hub site-bundle site2 --out "$T/b2x.tar.gz"
has "  it says what to do instead" "$LAST_OUT" "site-rekey site2 --yes"
expect_rc "site-bundle site2 --no-key (for a gateway that still has its key)" 0 hub site-bundle site2 --no-key --out "$T/b2n.tar.gz"
check "  that bundle holds no site.key and says where the key is" bash -c "! tar -tzf '$T/b2n.tar.gz' | grep site.key && tar -xzOf '$T/b2n.tar.gz' cctv-site-$ID2-site2/README.txt | grep -F 'forgotten on'"
check "bundles are 0600" test "$(stat -c %a "$T/b1.tar.gz"):$(stat -c %a "$T/b2.tar.gz")" = 600:600
check "bundle contents (one folder, plain files)" bash -c "tar -tvzf '$T/b1.tar.gz' | awk '{print \$1, \$6}' | tr '\n' ' '"
check "bundle's site-gateway.sh = the one next to cctv-vpn" bash -c "tar -xzOf '$T/b1.tar.gz' cctv-site-$ID1-site1/site-gateway.sh | cmp - '$GW'"
S2KEY=$(tar -xzOf "$T/b2.tar.gz" "cctv-site-$ID2-site2/site.key")
(umask 077; tar -xzOf "$T/b2.tar.gz" "cctv-site-$ID2-site2/site.psk" >"$T/b2.psk")

section "remote gateways: the bundle's own site-gateway.sh install (inside cvs-s1r / cvs-s2r)"
for s in 1 2; do
  out=$(gw_install "cvs-s${s}r" "$T/g$s" "$T/b$s.tar.gz" 2>&1) || true
  grep -E '^  (tunnel|site LAN|mapping|allowed|routing|handshake)' <<<"$out" | sed 's/^/  | /'
  if [[ $out == *"tunnel UP"* && $out == *"done: site"* ]]; then ok "site$s gateway installed, tunnel up"; else bad "site$s gateway install  [$(oneline "$(tail -n 5 <<<"$out")")]"; fi
done
check "hub sees site1's handshake" wait_handshake "$PUB1" 20
check "hub sees site2's handshake" wait_handshake "$PUB2" 20
check "status --write" hub status --write

section "(1) overlapping site LANs are kept apart"
expect_answer "hub -> 10.78.$ID1.10:6036 answers site1" cvs-hub "10.78.$ID1.10" 6036 site1
expect_answer "hub -> 10.78.$ID2.10:6036 answers site2" cvs-hub "10.78.$ID2.10" 6036 site2
check "hub pings site1's NVR 10.78.$ID1.10" nx cvs-hub ping -c1 -W2 "10.78.$ID1.10"
check "hub pings site2's gateway 10.77.0.$ID2" nx cvs-hub ping -c1 -W2 "10.77.0.$ID2"
check "hub route: 10.78.$ID1.10 via $HIF from 10.77.0.1" bash -c "ip -n cvs-hub -4 route get 10.78.$ID1.10 | grep -E 'dev $HIF .*src 10\.77\.0\.1'"

section "(2) the NVR's port 22 is not reachable"
expect_answer "control: on site1's LAN, 192.168.1.10:22 IS listening" cvs-s1r 192.168.1.10 22 ssh-site1
expect_blocked "hub -> 10.78.$ID1.10:22 (site1 NVR)" cvs-hub "10.78.$ID1.10" 22
[[ $LAST_PROBE == EHOSTUNREACH* ]] && ok "  refused by the hub at once (reject, not a timeout)" || bad "  expected an immediate EHOSTUNREACH from the hub's reject: $LAST_PROBE"
expect_blocked "hub -> 10.78.$ID2.10:22 (site2 NVR)" cvs-hub "10.78.$ID2.10" 22
expect_blocked "hub -> 10.78.$ID1.10:80" cvs-hub "10.78.$ID1.10" 80
nx cvs-hub nft insert rule inet "$HTABLE" to_sites tcp dport 22 accept
expect_blocked "defence in depth: with the hub's rule lifted, site1's GATEWAY still drops 10.78.$ID1.10:22" cvs-hub "10.78.$ID1.10" 22
expect_rc "firewall-reload restores the generated table" 0 hub firewall-reload
check "the lifted rule is gone again" test "$(nx cvs-hub nft list chain inet "$HTABLE" to_sites | grep -c 'dport 22 accept' || true)" = 0
expect_answer "the tunnel kept working through the reload" cvs-hub "10.78.$ID1.10" 6036 site1

section "(3) a site cannot reach the hub's own services through the tunnel"
expect_answer "control: the hub's web stand-in answers on 8080 (from the internet side)" cvs-inet "$HUB_WAN" 8080 hub-web
expect_blocked "site1 gateway -> hub 10.77.0.1:8080" cvs-s1r 10.77.0.1 8080
expect_blocked "site2 gateway -> hub 10.77.0.1:8080" cvs-s2r 10.77.0.1 8080
expect_blocked "site1 gateway -> hub 10.77.0.1:22" cvs-s1r 10.77.0.1 22
check_not "site1 gateway pings the hub: no reply" nx cvs-s1r ping -c1 -W2 10.77.0.1
expect_blocked "a device on site1's LAN (the NVR) -> hub 10.77.0.1:8080" cvs-s1n 10.77.0.1 8080
nx cvs-s1r wg set "$GIF" peer "$HUBPUB" allowed-ips 10.77.0.1/32,192.168.3.147/32
nx cvs-s1r ip route add 192.168.3.147/32 dev "$GIF"
expect_blocked "tampered site1 gateway -> the hub's main-LAN address 192.168.3.147:8080 through the tunnel" cvs-s1r 192.168.3.147 8080
nx cvs-s1r ip route del 192.168.3.147/32 dev "$GIF"
nx cvs-s1r wg set "$GIF" peer "$HUBPUB" allowed-ips 10.77.0.1/32
DROPS=$(rule_packets cvs-hub inet "$HTABLE" from_sites 'counter packets [0-9]+ bytes [0-9]+ drop')
check "the hub's from_sites chain dropped them (drop counter ${DROPS:-?})" test "${DROPS:-0}" -gt 0

section "(4) site1 cannot reach site2's virtual subnet"
expect_blocked "site1 gateway -> 10.78.$ID2.10:6036 (as installed: the tunnel only carries 10.77.0.1)" cvs-s1r "10.78.$ID2.10" 6036
expect_blocked "a device on site1's LAN -> 10.78.$ID2.10:6036" cvs-s1n "10.78.$ID2.10" 6036
nx cvs-s1r wg set "$GIF" peer "$HUBPUB" allowed-ips "10.77.0.1/32,10.78.$ID2.0/24"
nx cvs-s1r ip route add "10.78.$ID2.0/24" dev "$GIF"
expect_blocked "tampered site1 gateway sends 10.78.$ID2.10:6036 into the tunnel (hub ip_forward 0)" cvs-s1r "10.78.$ID2.10" 6036
nx cvs-hub sysctl -qw net.ipv4.ip_forward=1
expect_blocked "the same with the hub's ip_forward switched ON" cvs-s1r "10.78.$ID2.10" 6036
FWD=$(rule_packets cvs-hub inet "$HTABLE" forward "iifname \"$HIF\"")
check "the hub's forward chain dropped it (counter ${FWD:-?})" test "${FWD:-0}" -gt 0
nx cvs-hub sysctl -qw net.ipv4.ip_forward=0
nx cvs-s1r ip route del "10.78.$ID2.0/24" dev "$GIF"
nx cvs-s1r wg set "$GIF" peer "$HUBPUB" allowed-ips 10.77.0.1/32
expect_answer "site2 unaffected" cvs-hub "10.78.$ID2.10" 6036 site2
check "the carrier network never saw a VPN address (leak counter $(leaked))" test "$(leaked)" = 0

section "(5) status JSON for the app"
expect_rc "status --write" 0 hub status --write
check "vpn-status.json: both sites, ids, subnets, handshakes > 0" python3 "$T/checkjson.py" "$SF" \
  "{\"hubPub\":\"$HUBPUB\",\"hint\":\"$HUB_WAN:51820\",\"sites\":[{\"id\":$ID1,\"name\":\"site1\",\"lan\":\"192.168.1.0/24\"},{\"id\":$ID2,\"name\":\"site2\",\"lan\":\"192.168.1.0/24\"}]}"
leak=""
for k in $(cat "$VD/hub.key" "$VD"/sites/*/private.key "$VD"/sites/*/psk) "$S2KEY" $(tar -xzOf "$T/b1.tar.gz" "cctv-site-$ID1-site1/site.psk") $(tar -xzOf "$T/b2.tar.gz" "cctv-site-$ID2-site2/site.psk"); do
  if grep -qF -- "$k" "$SF"; then leak+=" ${k:0:6}..."; fi
done
[[ -z $leak ]] && ok "no private or preshared key in the status file (hub key, 2 site keys, 2 PSKs checked)" || bad "secrets in the status file:$leak"
echo "  | $(cat "$SF")"
APP=""
for c in "$here/../../cctv/vpn.mjs" "$here/vpn.mjs" "$here/../vpn.mjs"; do if [[ -f $c ]]; then APP=$(readlink -f "$c"); break; fi; done
if [[ -n $APP ]] && command -v node >/dev/null 2>&1; then
  check "the app's own reader (cctv/vpn.mjs readVpn) shows both sites connected" env VPN_STATUS_FILE="$SF" node --input-type=module -e "
    import { readVpn } from '$APP'
    const v = readVpn()
    if (!v.available || v.stale || v.sites.length !== 2 || !v.sites.every((s) => s.connected)) { console.log(JSON.stringify(v)); process.exit(1) }
    console.log(v.sites.map((s) => s.name + ' ' + s.virtualSubnet + ' connected, handshake ' + s.lastHandshakeAgoS + ' s ago').join('; '))"
else
  echo "  (app reader check skipped: no cctv/vpn.mjs or node)"
fi
expect_rc "cctv-vpn check (every hub item)" 0 hub check
sed 's/^/  | /' <<<"$LAST_OUT"
{ hub status || true; } | sed 's/^/  | /'

section "(9) the hub firewall is kept exactly as generated (flush, delete, edits, boot, fail closed)"
expect_rc "fw-verify: the table is as generated" 0 hub fw-verify
nx cvs-hub nft insert rule inet "$HTABLE" from_sites accept # what a debugging session might leave behind
expect_rc "one 'accept' inserted into from_sites: cctv-vpn check now FAILS" 1 hub check
has "  item 2 says the table was changed outside cctv-vpn" "$(grep '^FAIL  2' <<<"$LAST_OUT" || true)" "changed outside cctv-vpn"
expect_blocked "  (the output chain still refuses the hub's answers: site1's gateway -> hub 8080 does not open)" cvs-s1r 10.77.0.1 8080
expect_rc "status --write (the 15 s timer job) puts the generated table back" 0 hub status --write
has "  and says so" "$LAST_OUT" "was changed outside cctv-vpn"
check "  the inserted accept is gone" from_sites_ok
nx cvs-hub nft flush table inet "$HTABLE"
expect_answer "control: after 'nft flush table' site1's gateway DOES reach the hub's 8080 (the hole the guard must close)" cvs-s1r 10.77.0.1 8080 hub-web
expect_rc "  cctv-vpn check FAILS" 1 hub check
expect_rc "  status --write loads the table again" 0 hub status --write
check "  from_sites drops again" from_sites_ok
expect_blocked "  site1's gateway -> hub 8080 is blocked again" cvs-s1r 10.77.0.1 8080
nx cvs-hub nft delete table inet "$HTABLE"
expect_rc "after 'nft delete table': status --write loads it again" 0 hub status --write
has "  and says the table was missing" "$LAST_OUT" "is missing"
check "  the table is back and as generated" hub fw-verify
echo 'add rule inet cctv_vpn_sim from_sites accept' >>"$VD/cctv_vpn.nft"
expect_rc "an edited cctv_vpn.nft (the file the boot unit loads) makes check FAIL" 1 hub check
has "  item 2 names the file" "$LAST_OUT" "cctv_vpn.nft was edited"
expect_rc "status --write never loads the edited file (it loads the generated text)" 0 hub status --write
check "  the live table is still the generated one" from_sites_ok
expect_rc "firewall-reload writes the file again" 0 hub firewall-reload
expect_rc "check passes again" 0 hub check
# the watcher unit's job, run by hand: it follows 'nft monitor'
nx cvs-hub setsid bash -c 'echo $$ >"$0"; exec env CCTV_VPN_ROOT="$1" CCTV_VPN_IF="$2" CCTV_VPN_TABLE="$3" bash "$4" fw-watch' \
  "$T/watch.pid" "$HR" "$HIF" "$HTABLE" "$VPN" </dev/null >"$T/watch.log" 2>&1 &
sleep 1.5
nx cvs-hub nft insert rule inet "$HTABLE" from_sites accept
t0=$(date +%s%N)
for ((i = 0; i < 50; i++)); do from_sites_ok && break; sleep 0.1; done
if from_sites_ok; then ok "fw-watch (the watcher unit) put the table back after $((($(date +%s%N) - t0) / 1000000)) ms"; else bad "fw-watch did not restore the table within 5 s  [$(oneline "$(cat "$T/watch.log")")]"; fi
nx cvs-hub nft flush table inet "$HTABLE"
t0=$(date +%s%N)
for ((i = 0; i < 50; i++)); do from_sites_ok && break; sleep 0.1; done
if from_sites_ok; then ok "  and after 'nft flush table' after $((($(date +%s%N) - t0) / 1000000)) ms"; else bad "  fw-watch did not restore a flushed table within 5 s"; fi
sleep 1
g1=$(nx cvs-hub nft -a -s list table inet "$HTABLE" | md5sum)
sleep 2
g2=$(nx cvs-hub nft -a -s list table inet "$HTABLE" | md5sum)
check "  no reload loop: the table (rule handles) stays the same afterwards" test "$g1" = "$g2"
has "  its log names the change" "$(cat "$T/watch.log")" "was changed outside cctv-vpn"
kill -TERM -- "-$(cat "$T/watch.pid")" 2>/dev/null || true
sleep 0.3
expect_answer "site1 still answers" cvs-hub "10.78.$ID1.10" 6036 site1
# the boot order: the firewall unit loads the file, then wg-quick@wg0 runs PreUp = fw-verify --preup
expect_rc "hub-down" 0 hub hub-down
nx cvs-hub nft insert rule inet "$HTABLE" from_sites accept
check "wg-quick up (as systemd starts wg0 at boot): its PreUp puts the table back first" nx cvs-hub wg-quick up "$HR/etc/wireguard/$HIF.conf"
if from_sites_ok && ip -n cvs-hub link show "$HIF" >/dev/null 2>&1; then ok "  from_sites drops again, $HIF is up"; else bad "  after wg-quick up: table or $HIF wrong"; fi
nx cvs-hub wg-quick down "$HR/etc/wireguard/$HIF.conf" >/dev/null 2>&1 || true
nx cvs-hub nft insert rule inet "$HTABLE" from_sites accept
check_not "PreUp when the table cannot be loaded (nft -f fails): wg-quick up refuses to start $HIF" nx cvs-hub env PATH="$T/fakebin:$PATH" wg-quick up "$HR/etc/wireguard/$HIF.conf"
check_not "  $HIF does not exist" ip -n cvs-hub link show "$HIF"
expect_rc "hub-up" 0 hub hub-up
wait_answer "site1 reachable again (hub restart: it dials the saved endpoint)" cvs-hub "10.78.$ID1.10" 6036 site1 30 3
nx cvs-hub nft insert rule inet "$HTABLE" from_sites accept
expect_rc "the 15 s job when the table cannot be loaded (nft -f fails)" 1 hubfail status --write
has "  it takes $HIF down (fail closed)" "$LAST_OUT" "taking $HIF down"
check "  $HIF is down" bash -c "! ip -n cvs-hub -o link show $HIF | grep -q '[<,]UP[,>]'"
expect_blocked "  site1's gateway -> hub 8080 (the table still has the hole, but $HIF is down)" cvs-s1r 10.77.0.1 8080
expect_rc "hub-up (the firewall loads again)" 0 hub hub-up
check "  table as generated" from_sites_ok
wait_answer "site1 reachable again (hub restart: it dials the saved endpoint)" cvs-hub "10.78.$ID1.10" 6036 site1 30 3
wait_answer "site2 reachable again (hub restart: it dials the saved endpoint)" cvs-hub "10.78.$ID2.10" 6036 site2 30 3

section "(10) a gateway box that did not route before forwards only the tunnel"
check "site1's gateway recorded that it did not route (PREV_IP_FORWARD=0)" grep -x PREV_IP_FORWARD=0 "$T/g1/etc/cctv-site/site.env"
ip -n cvs-inet route add 192.168.1.0/24 via 100.64.1.2
expect_blocked "a host on its other network (the uplink side) -> through the gateway -> NVR 192.168.1.10:22" cvs-inet 192.168.1.10 22
expect_blocked "the same -> NVR 192.168.1.10:6036 (only the tunnel may)" cvs-inet 192.168.1.10 6036
FD=$(counter_packets cvs-s1r ip "$GTABLE" forward_dropped)
check "  the gateway's forward_dropped counter took them (${FD:-?})" test "${FD:-0}" -gt 0
nx cvs-s1r nft insert rule ip "$GTABLE" forward accept
expect_answer "control: without that last drop the gateway would route to the NVR's ssh" cvs-inet 192.168.1.10 22 ssh-site1
nx cvs-s1r nft -f "$T/g1/etc/cctv-site/firewall.nft"
expect_blocked "  blocked again once the gateway's table is reloaded" cvs-inet 192.168.1.10 22
ip -n cvs-inet route del 192.168.1.0/24 via 100.64.1.2
expect_answer "the tunnel to site1 is unaffected" cvs-hub "10.78.$ID1.10" 6036 site1

section "(7) site-add for an existing name; site notes"
REC1=$(sha256sum "$VD/sites/$ID1/site.conf")
HS1=$(handshake_of "$PUB1")
expect_rc "site-add site1 --lan 192.168.1.0/24 again" 0 hub site-add site1 --lan 192.168.1.0/24
[[ $LAST_OUT == *"already exists: nothing changed"* ]] && ok "  reported as existing, nothing changed" || bad "  output: $(oneline "$LAST_OUT")"
check "same record (id $ID1, same key), same live peers" bash -c "[ '$REC1' = \"\$(sha256sum '$VD/sites/$ID1/site.conf')\" ] && [ \$(ip netns exec cvs-hub wg show $HIF peers | wc -l) = 2 ]"
check "site1's session untouched (same handshake time $HS1)" test "$(handshake_of "$PUB1")" = "$HS1"
expect_rc "site-add site1 with another LAN is refused" 3 hub site-add site1 --lan 192.168.7.0/24
expect_rc "site-add site1 with another id is refused" 3 hub site-add site1 --lan 192.168.1.0/24 --id 9
expect_rc "hub-init again while both sites are connected" 0 hub hub-init
check "the sessions survived it (same handshake time $HS1, same peers)" bash -c "[ '$(handshake_of "$PUB1")' = '$HS1' ] && [ \$(ip netns exec cvs-hub wg show $HIF peers | wc -l) = 2 ]"
expect_answer "site1 still answers" cvs-hub "10.78.$ID1.10" 6036 site1
expect_rc "site-set site1 --note 'Pi 4 at the gate, admin: RMS (Teltonika)'" 0 hub site-set site1 --note "Pi 4 at the gate, admin: RMS (Teltonika)"
check "  site-list shows the note" bash -c "ip netns exec cvs-hub env CCTV_VPN_ROOT='$HR' CCTV_VPN_IF=$HIF CCTV_VPN_TABLE=$HTABLE bash '$VPN' site-list | grep -F 'Pi 4 at the gate, admin: RMS (Teltonika)'"

section "(8) bad inputs are refused and change nothing"
STATE0=$(hub_state)
long=$(printf 'a%.0s' {1..33})
for n in "bad name" "a/b" "a;b" "../x" "-x" "x-" "Site1" "x_y" "a.b" "$long" "" "12" 'a$(id)' "a b;reboot"; do
  expect_rc "site name $(printf '%q' "$n")" 2 hub site-add "$n" --lan 192.168.1.0/24
done
for c in 192.168.1.1/24 192.168.1.0/33 300.1.1.0/24 192.168.1.0 192.168.1.0/ 8.8.8.0/24 10.78.5.0/24 10.77.0.0/24 192.168.0.0/22 192.168.1.128/25 "192.168.1.0/24;x" abc ""; do
  expect_rc "site LAN $(printf '%q' "$c")" 2 hub site-add newsite --lan "$c"
done
expect_rc "--id 1 (would be the hub's 10.77.0.1)" 2 hub site-add newsite --lan 192.168.1.0/24 --id 1
expect_rc "--id 251" 2 hub site-add newsite --lan 192.168.1.0/24 --id 251
expect_rc "--id 02" 2 hub site-add newsite --lan 192.168.1.0/24 --id 02
expect_rc "--id x" 2 hub site-add newsite --lan 192.168.1.0/24 --id x
expect_rc "--id $ID1 (overlaps site1's virtual subnet 10.78.$ID1.0/24)" 3 hub site-add newsite --lan 192.168.1.0/24 --id "$ID1"
expect_rc "--reuse-id without --id" 2 hub site-add newsite --lan 192.168.1.0/24 --reuse-id
expect_rc "--lan missing" 2 hub site-add newsite
expect_rc "--pubkey not a key" 2 hub site-add newsite --lan 192.168.1.0/24 --pubkey notakey
expect_rc "--pubkey = the hub's key" 3 hub site-add newsite --lan 192.168.1.0/24 --pubkey "$HUBPUB"
expect_rc "--pubkey = site1's key" 3 hub site-add newsite --lan 192.168.1.0/24 --pubkey "$PUB1"
SPARE=$(wg genkey | wg pubkey)
expect_rc "--psk-file without --pubkey" 2 hub site-add newsite --lan 192.168.1.0/24 --psk-file "$T/b2.psk"
expect_rc "--psk-file that is not a key" 2 hub site-add newsite --lan 192.168.1.0/24 --pubkey "$SPARE" --psk-file "$T/hosts"
expect_rc "--psk-file with --no-psk" 2 hub site-add newsite --lan 192.168.1.0/24 --pubkey "$SPARE" --psk-file "$T/b2.psk" --no-psk
expect_rc "--note with a quote" 2 hub site-add newsite --lan 192.168.1.0/24 --note 'a"b'
expect_rc "--note with \$(...)" 2 hub site-add newsite --lan 192.168.1.0/24 --note 'x $(id)'
expect_rc "unknown option" 2 hub site-add newsite --lan 192.168.1.0/24 --bogus
expect_rc "hub-init --endpoint 'hub;reboot'" 2 hub hub-init --endpoint 'hub;reboot'
expect_rc "hub-init --endpoint vpn.example.com:99999" 2 hub hub-init --endpoint vpn.example.com:99999
expect_rc "hub-init --port 80" 2 hub hub-init --port 80
expect_rc "hub-init --mtu 1500" 2 hub hub-init --mtu 1500
expect_rc "hub-init --endpoint 203.0.113.99 while 2 sites dial $HUB_WAN (no --yes)" 2 hub hub-init --endpoint 203.0.113.99
has "  it lists what each site would need" "$LAST_OUT" "site $ID1 site1: cctv-vpn site-bundle site1"
expect_rc "site-bundle --out x.zip" 2 hub site-bundle site1 --out "$T/x.zip"
expect_rc "site-bundle --out with a space" 2 hub site-bundle site1 --out "$T/a b.tar.gz"
expect_rc "site-bundle --endpoint 'x;y'" 2 hub site-bundle site1 --endpoint 'x;y' --out "$T/x.tar.gz"
expect_rc "site-bundle --forget-key --no-key" 2 hub site-bundle site1 --forget-key --no-key --out "$T/x.tar.gz"
expect_rc "site-set with no change" 2 hub site-set site1
expect_rc "site-set --rename to site2's name" 3 hub site-set site1 --rename site2
expect_rc "site-remove of an unknown site" 4 hub site-remove nosuch --yes
expect_rc "site-remove 'a;b'" 2 hub site-remove 'a;b' --yes
expect_rc "backup --out inside /etc/cctv/vpn" 2 hub backup --out "$VD/hub.tar.gz.gpg" --passphrase-file "$T/pass"
expect_rc "backup --out not ending in .tar.gz.gpg" 2 hub backup --out "$T/hub.tar.gz" --passphrase-file "$T/pass"
expect_rc "backup with a passphrase shorter than 12" 2 hub backup --out "$T/short.tar.gz.gpg" --passphrase-file "$T/shortpass"
expect_rc "restore onto a machine that has a hub" 3 hub restore "$T/b1.tar.gz"
expect_rc "restore of a missing file" 4 hub restore "$T/nosuch.tar.gz.gpg"
expect_rc "unknown command" 2 hub frobnicate
check "nothing changed by any refused input (files and live peers)" test "$(hub_state)" = "$STATE0"
check "no backup file was written" bash -c "! ls '$T'/*.gpg '$VD'/*.gpg 2>/dev/null"
mkdir -p "$T/evil"
tar -xzf "$T/b1.tar.gz" -C "$T/evil"
sed -i 's/^SITE_NAME=.*/SITE_NAME=a;reboot/' "$T/evil/cctv-site-$ID1-site1/site.env"
check_not "site-gateway.sh refuses a bundle whose site name holds a ';'" nx cvs-s1r bash "$GW" check "$T/evil/cctv-site-$ID1-site1" --no-packages --root "$T/g1"
check_not "cctv-vpn refuses CCTV_VPN_ROOT (test mode) in the main namespace" env CCTV_VPN_ROOT="$T/mainroot" bash "$VPN" status --json
check_not "site-gateway.sh refuses --no-systemd in the main namespace" bash "$GW" check "$T/b1.tar.gz" --no-systemd --no-packages

section "(11) a site whose address jumps back and forth is reported (two holders of one key?)"
expect_rc "status --write" 0 hub status --write
REAL1=$(endpoint_of cvs-hub "$HIF" "$PUB1")
for p in 40001 40002 40003; do
  nx cvs-hub wg set "$HIF" peer "$PUB1" endpoint "203.0.113.1:$p"
  out=$(hub status --write 2>&1) || true
done
has "each change is logged" "$out" "site $ID1 (site1) now dials from 203.0.113.1:40003"
has "the third change within 10 minutes is a warning that names the site" "$out" "site $ID1 (site1): its address changed"
has "  and says what it may mean" "$out" "Two devices may hold this site's key"
nx cvs-hub wg set "$HIF" peer "$PUB1" endpoint "$REAL1"
hub status --write >/dev/null 2>&1 || true
expect_answer "site1 answers at its real address again" cvs-hub "10.78.$ID1.10" 6036 site1

section "leak guard and hub restart (hub-down / hub-up); a gateway install that gets no handshake"
expect_rc "status --write (saves the site endpoints)" 0 hub status --write
check "2 endpoints saved" test "$(wc -l <"$HR/var/lib/cctv-vpn/endpoints")" = 2
expect_rc "hub-down" 0 hub hub-down
check_not "$HIF is gone" ip -n cvs-hub link show "$HIF"
expect_blocked "10.78.$ID1.10:6036 with $HIF down" cvs-hub "10.78.$ID1.10" 6036
[[ $LAST_PROBE == EHOSTUNREACH* ]] && ok "  fails at once: the leak guard rejects VPN addresses on every other interface" || bad "  expected EHOSTUNREACH at once: $LAST_PROBE"
check "the carrier network saw nothing for 10.77/10.78 (leak counter $(leaked))" test "$(leaked)" = 0
check "site1's gateway uninstalls" nx cvs-s1r env CCTV_SITE_TABLE="$GTABLE" bash "$GW" uninstall --root "$T/g1"
expect_rc "site1's gateway installed again while the hub is down (no handshake possible)" 5 gw_install cvs-s1r "$T/g1" "$T/b1.tar.gz"
has "  it says installed, but NOT connected" "$LAST_OUT" "installed, but NOT connected"
expect_rc "the same with --no-wait (offline preparation)" 0 gw_install cvs-s1r "$T/g1" "$T/b1.tar.gz" --no-wait
expect_rc "hub-up (PostUp restores the saved endpoints)" 0 hub hub-up
wait_answer "site1 reachable again (its gateway retried by itself)" cvs-hub "10.78.$ID1.10" 6036 site1 30
wait_answer "site2 reachable again (hub restart: it dials the saved endpoint)" cvs-hub "10.78.$ID2.10" 6036 site2 30 3

section "(6) site-remove cuts the site off; an accidental removal is undone without a site visit"
expect_rc "site-remove site2 without --yes only shows the plan" 2 hub site-remove site2
expect_answer "  site2 still reachable" cvs-hub "10.78.$ID2.10" 6036 site2
expect_rc "site-remove site2 --yes" 0 hub site-remove site2 --yes
expect_blocked "hub -> 10.78.$ID2.10:6036 after the removal" cvs-hub "10.78.$ID2.10" 6036
expect_answer "site1 unaffected" cvs-hub "10.78.$ID1.10" 6036 site1
check_not "site2's peer is gone from $HIF" bash -c "ip netns exec cvs-hub wg show $HIF peers | grep -xF '$PUB2'"
check "retired/$ID2.conf written (with its last endpoint); sites/$ID2 and its keys deleted" bash -c "[ -f '$VD/retired/$ID2.conf' ] && [ ! -e '$VD/sites/$ID2' ] && grep -x NAME=site2 '$VD/retired/$ID2.conf' && grep -E '^LAST_ENDPOINT=[0-9.]+:[0-9]+$' '$VD/retired/$ID2.conf'"
expect_rc "status --write" 0 hub status --write
check "the status JSON lists only site1 now" python3 -c "import json,sys; d=json.load(open('$SF')); s=d['sites']; sys.exit(0 if [x['name'] for x in s]==['site1'] else 1)"
expect_rc "undo: site-add site2 --id $ID2 --reuse-id --pubkey <its key> --psk-file <its psk>" 0 hub site-add site2 --lan 192.168.1.0/24 --id "$ID2" --reuse-id --pubkey "$PUB2" --psk-file "$T/b2.psk"
wait_answer "  site2 is back at once, nothing changed at the site" cvs-hub "10.78.$ID2.10" 6036 site2 30 3
expect_rc "site-remove site2 --yes (again: the steps below want it removed)" 0 hub site-remove site2 --yes

section "removed ids are never handed out again; a gateway that made its own key (--pubkey)"
expect_rc "site-add --id $ID2 (retired) without --reuse-id is refused" 3 hub site-add newsite --lan 192.168.1.0/24 --id "$ID2"
nx cvs-s2r bash -c "umask 077; wg genkey > '$T/s2own.key'"
OWNPUB=$(wg pubkey <"$T/s2own.key")
check "the old site2 gateway uninstalls" nx cvs-s2r env CCTV_SITE_TABLE="$GTABLE" bash "$GW" uninstall --root "$T/g2"
expect_rc "site-add site2 again with --pubkey (key made at the site)" 0 hub site-add site2 --lan 192.168.1.0/24 --pubkey "$OWNPUB"
ID3=$(site_id site2)
check "it gets a NEW id ($ID3), not the retired $ID2" test "$ID3" = 4
check "no private key for it on the hub (KEY_ON_HUB=no, KEY_ORIGIN=site)" bash -c "[ ! -e '$VD/sites/$ID3/private.key' ] && grep -x KEY_ON_HUB=no '$VD/sites/$ID3/site.conf' && grep -x KEY_ORIGIN=site '$VD/sites/$ID3/site.conf'"
expect_rc "site-bundle site2" 0 hub site-bundle site2 --out "$T/b3.tar.gz"
check_not "the bundle holds no site.key" bash -c "tar -tzf '$T/b3.tar.gz' | grep site.key"
out=$(gw_install cvs-s2r "$T/g3" "$T/b3.tar.gz" --key "$T/s2own.key" 2>&1) || true
if [[ $out == *"tunnel UP"* ]]; then ok "gateway installed with its own key (--key), tunnel up"; else bad "install with --key  [$(oneline "$(tail -n 5 <<<"$out")")]"; fi
wait_answer "hub -> 10.78.$ID3.10:6036 answers site2 (new id $ID3)" cvs-hub "10.78.$ID3.10" 6036 site2 15
expect_blocked "the old 10.78.$ID2.10 stays dead" cvs-hub "10.78.$ID2.10" 6036

section "key rotation: site-rekey site1, new bundle, re-install"
expect_rc "site-rekey site1 without --yes only shows the plan" 2 hub site-rekey site1
expect_rc "site-rekey site1 --yes" 0 hub site-rekey site1 --yes
has "  it says to change the NVR passwords if a bundle may have leaked" "$LAST_OUT" "change the passwords"
expect_blocked "site1 with its OLD key is cut off" cvs-hub "10.78.$ID1.10" 6036
expect_rc "site-bundle site1 (the new key)" 0 hub site-bundle site1 --out "$T/b1b.tar.gz"
out=$(gw_install cvs-s1r "$T/g1" "$T/b1b.tar.gz" 2>&1) || true
if [[ $out == *"tunnel UP"* ]]; then ok "site1 gateway re-installed with the new bundle (idempotent install), tunnel up"; else bad "re-install  [$(oneline "$(tail -n 5 <<<"$out")")]"; fi
wait_answer "site1 back with its new key" cvs-hub "10.78.$ID1.10" 6036 site1 15
expect_rc "site-reset site1 (clears the handshake state, keeps keys and endpoint)" 0 hub site-reset site1
wait_answer "site1 reachable after site-reset" cvs-hub "10.78.$ID1.10" 6036 site1 15 3
expect_rc "site-set site1 --rename yard-1 --lan 192.168.1.0/24" 0 hub site-set site1 --rename yard-1 --lan 192.168.1.0/24
check "renamed in the status JSON, same id" bash -c "ip netns exec cvs-hub env CCTV_VPN_ROOT='$HR' CCTV_VPN_IF=$HIF CCTV_VPN_TABLE=$HTABLE bash '$VPN' status --json | grep -F '\"id\":$ID1,\"name\":\"yard-1\"'"
{ hub site-list --retired || true; } | sed 's/^/  | /'

section "hub key rotation: hub-rekey, then a new bundle for every site"
expect_rc "hub-rekey without --yes only shows the plan" 2 hub hub-rekey
expect_rc "hub-rekey --yes" 0 hub hub-rekey --yes
grep -E '^  site ' <<<"$LAST_OUT" | sed 's/^/  | /'
check "the hub has a new key pair" test "$(cat "$VD/hub.pub")" != "$HUBPUB"
HUBPUB2=$(cat "$VD/hub.pub")
expect_blocked "yard-1 is cut off until its gateway knows the new hub key" cvs-hub "10.78.$ID1.10" 6036
expect_rc "site-bundle yard-1" 0 hub site-bundle yard-1 --out "$T/b1c.tar.gz"
expect_rc "site-bundle site2" 0 hub site-bundle site2 --out "$T/b3c.tar.gz"
out=$(gw_install cvs-s1r "$T/g1" "$T/b1c.tar.gz" 2>&1) || true
if [[ $out == *"tunnel UP"* ]]; then ok "yard-1 gateway re-installed, tunnel up"; else bad "yard-1 re-install  [$(oneline "$(tail -n 5 <<<"$out")")]"; fi
out=$(gw_install cvs-s2r "$T/g3" "$T/b3c.tar.gz" --key "$T/s2own.key" 2>&1) || true
if [[ $out == *"tunnel UP"* ]]; then ok "site2 gateway re-installed (own key), tunnel up"; else bad "site2 re-install  [$(oneline "$(tail -n 5 <<<"$out")")]"; fi
wait_answer "yard-1 back" cvs-hub "10.78.$ID1.10" 6036 site1 15
wait_answer "site2 back" cvs-hub "10.78.$ID3.10" 6036 site2 15

section "(12) the hub as a DNS name with an A and an AAAA record; a gateway on a network with IPv6"
expect_rc "hub-init --endpoint vpn.example.test while 2 sites dial $HUB_WAN:51820 (no --yes)" 2 hubdns hub-init --endpoint vpn.example.test
has "  it lists every site and what it needs" "$LAST_OUT" "site $ID3 site2: set Endpoint = vpn.example.test:51820"
check "  hub.conf unchanged" grep -x "ENDPOINT=$HUB_WAN" "$VD/hub.conf"
expect_rc "the same with --yes" 0 hubdns hub-init --endpoint vpn.example.test --yes
has "  it warns about the AAAA record" "$LAST_OUT" "also has an IPv6 (AAAA) address (2001:db8:1::10)"
has "  and lists what each site now needs" "$LAST_OUT" "the sites still dial $HUB_WAN:51820"
expect_answer "the installed gateways keep working meanwhile (they dial the old address)" cvs-hub "10.78.$ID1.10" 6036 site1
expect_rc "site-bundle site2 (now dials vpn.example.test)" 0 hubdns site-bundle site2 --out "$T/b3d.tar.gz"
check "  its site.env: HUB_ENDPOINT=vpn.example.test:51820" bash -c "tar -xzOf '$T/b3d.tar.gz' cctv-site-$ID3-site2/site.env | grep -x HUB_ENDPOINT=vpn.example.test:51820"
ip -n cvs-s2r -6 addr add 2001:db8:2::2/64 dev wan nodad
ip -n cvs-s2r -6 route add default via 2001:db8:2::1 dev wan
ip -n cvs-s2r link add cvtmp type wireguard
(umask 077; wg genkey >"$T/tmp.key")
nx cvs-s2r wg set cvtmp private-key "$T/tmp.key"
withhosts "$T/hosts" cvs-s2r wg set cvtmp peer "$HUBPUB2" endpoint vpn.example.test:51820 allowed-ips 10.77.0.1/32 || true
has "control: given the name, wg itself picks the IPv6 address at a site with IPv6" "$(endpoint_of cvs-s2r cvtmp "$HUBPUB2")" "[2001:db8:1::10]:51820"
ip -n cvs-s2r link del cvtmp
out=$(GW_HOSTS=$T/hosts gw_install cvs-s2r "$T/g3" "$T/b3d.tar.gz" --key "$T/s2own.key" 2>&1) || true
grep -E '^  tunnel' <<<"$out" | sed 's/^/  | /'
if [[ $out == *"tunnel UP"* ]]; then ok "site2's gateway installed from the DNS bundle, tunnel up"; else bad "DNS install  [$(oneline "$(tail -n 5 <<<"$out")")]"; fi
has "  its tunnel dials the IPv4 address" "$(endpoint_of cvs-s2r "$GIF" "$HUBPUB2")" "$HUB_WAN:51820"
check "  and its config keeps the name for later" grep -x "HUB_ENDPOINT=vpn.example.test:51820" "$T/g3/etc/cctv-site/site.env"
wait_answer "hub -> site2 through it" cvs-hub "10.78.$ID3.10" 6036 site2 15
RR=$T/g3/usr/local/sbin/cctv-site-gateway
expect_rc "reresolve (timer) while the tunnel is fresh: leaves it alone" 0 withhosts "$T/hosts" cvs-s2r bash "$RR" reresolve --root "$T/g3"
check "  still $HUB_WAN:51820" test "$(endpoint_of cvs-s2r "$GIF" "$HUBPUB2")" = "$HUB_WAN:51820"
expect_rc "the name moves to 203.0.113.99: reresolve --force (as at tunnel start) follows it" 0 withhosts "$T/hosts-moved" cvs-s2r bash "$RR" reresolve --force --root "$T/g3"
has "  the tunnel now dials 203.0.113.99:51820 (IPv4, not the AAAA)" "$(endpoint_of cvs-s2r "$GIF" "$HUBPUB2")" "203.0.113.99:51820"
expect_rc "and back to $HUB_WAN" 0 withhosts "$T/hosts" cvs-s2r bash "$RR" reresolve --force --root "$T/g3"
wait_answer "site2 answers again" cvs-hub "10.78.$ID3.10" 6036 site2 15
ip -n cvs-s2r -6 route del default via 2001:db8:2::1 dev wan
ip -n cvs-s2r -6 addr del 2001:db8:2::2/64 dev wan
expect_rc "site-bundle yard-1 --endpoint $HUB_WAN:443 (a site whose network blocks UDP 51820)" 0 hub site-bundle yard-1 --endpoint "$HUB_WAN:443" --out "$T/b1e.tar.gz"
check "  that bundle alone dials port 443" bash -c "tar -xzOf '$T/b1e.tar.gz' cctv-site-$ID1-yard-1/site.env | grep -x HUB_ENDPOINT=$HUB_WAN:443 && tar -xzOf '$T/b1e.tar.gz' cctv-site-$ID1-yard-1/wg0.conf | grep -x 'Endpoint = $HUB_WAN:443' && grep -x ENDPOINT=vpn.example.test '$VD/hub.conf'"
expect_rc "site-bundle yard-1 (DNS endpoint, for the router recipes)" 0 hubdns site-bundle yard-1 --out "$T/b1d.tar.gz"

section "a site without a recorded LAN (--lan none); router recipes from a hub bundle"
expect_rc "site-add lanless --lan none" 0 hub site-add lanless --lan none
check "status JSON: realLan null, next free id 5" bash -c "ip netns exec cvs-hub env CCTV_VPN_ROOT='$HR' CCTV_VPN_IF=$HIF CCTV_VPN_TABLE=$HTABLE bash '$VPN' status --json | grep -F '\"id\":5,\"name\":\"lanless\",\"tunnelIp\":\"10.77.0.5\",\"virtualSubnet\":\"10.78.5.0/24\",\"realLan\":null'"
expect_rc "site-bundle lanless" 0 hub site-bundle lanless --out "$T/b5.tar.gz"
check "its site.env has an empty REAL_LAN (the Linux gateway then uses its own /24)" bash -c "tar -xzOf '$T/b5.tar.gz' cctv-site-5-lanless/site.env | grep -x 'REAL_LAN='"
expect_rc "site-remove lanless --yes" 0 hub site-remove lanless --yes
if [[ -f $here/site-recipes.sh ]]; then
  check "site-recipes.sh renders every platform from a hub-made bundle (IP endpoint)" nx cvs-hub bash "$here/site-recipes.sh" "$T/b1c.tar.gz" all --nvr 192.168.1.10 --out "$T/rec"
  check "site-recipes.sh renders every platform from a bundle with a DNS endpoint" nx cvs-hub bash "$here/site-recipes.sh" "$T/b1d.tar.gz" all --nvr 192.168.1.10,192.168.1.20 --out "$T/rec2"
  check "  no unfilled placeholders, every file 0600" bash -c "! grep -rl '@@' '$T/rec' '$T/rec2' && [ -z \"\$(find '$T/rec' '$T/rec2' -type f ! -perm 600)\" ] && find '$T/rec' '$T/rec2' -type f | wc -l"
  W=$T/rec2/cctv-site-$ID1-windows/cctv-site-$ID1-setup.ps1
  check "  Windows: the SYSTEM task runs an encoded command by the full PowerShell path; nothing is written to a file" windows_ok "$W"
  E=$T/rec2/cctv-site-$ID1-edgeos
  check "  EdgeOS: tunnel wg77, NAT rules deleted before they are set, a remove file, the DNS task" edgeos_ok "$E" "$ID1"
  check_not "  EdgeOS refuses a tunnel name that is not wgN" nx cvs-hub bash "$here/site-recipes.sh" "$T/b1d.tar.gz" edgeos --nvr 192.168.1.10 --ifname cctv --out "$T/rec3"
  check "  the DNS follow-up script (EdgeOS, RutOS) is valid sh" bash -c "sh -n '$E/cctv-vpn-reresolve.sh' && sh -n '$T/rec2/cctv-site-$ID1-rutos/cctv-vpn-reresolve.sh' && echo ok"
  if [[ -n ${SIM_KEEP:-} ]]; then
    cp "$W" "$E/cctv-site-$ID1-edgeos.txt" "$E/cctv-site-$ID1-edgeos-remove.txt" "$E/cctv-vpn-reresolve.sh" "$SIM_KEEP/"
    cp "$T/rec2/cctv-site-$ID1-rutos/README.txt" "$SIM_KEEP/rutos-README.txt"
    cp "$T/rec2/cctv-site-$ID1-opnsense/README.txt" "$SIM_KEEP/opnsense-README.txt"
    cp "$T/rec2/cctv-site-$ID1-pfsense/README.txt" "$SIM_KEEP/pfsense-README.txt"
    chmod 644 "$SIM_KEEP"/*
    echo "  (kept the Windows, EdgeOS and RutOS/OPNsense/pfSense recipe texts in $SIM_KEEP: no private keys)"
  fi
fi

section "(13) backup, loss of the hub, restore: no site needs a visit"
GNUPG_BEFORE=$(ls -d /root/.gnupg /run/user/0/gnupg 2>/dev/null | tr '\n' ' ' || true)
expect_rc "backup --out <another machine / USB stick> --passphrase-file" 0 hub backup --out "$T/hub.tar.gz.gpg" --passphrase-file "$T/pass"
check "  the file is 0600 and no key is readable in it" bash -c "[ \$(stat -c %a '$T/hub.tar.gz.gpg') = 600 ] && ! grep -qF -- \"\$(cat '$VD/hub.key')\" '$T/hub.tar.gz.gpg' && ! gzip -dc <'$T/hub.tar.gz.gpg' >/dev/null 2>&1 && echo encrypted"
check "  no gpg-agent left running, no gnupg folder left behind" bash -c "! pgrep -f '[c]ctv-vpn-gpg' >/dev/null && [ \"\$(ls -d /root/.gnupg /run/user/0/gnupg 2>/dev/null | tr '\n' ' ' || true)\" = '$GNUPG_BEFORE' ] && echo clean"
expect_rc "check: item 14 says the backup is up to date" 0 hub check
has "  item 14" "$LAST_OUT" "PASS 14  backup"
expect_rc "a second backup to the same name is refused" 3 hub backup --out "$T/hub.tar.gz.gpg" --passphrase-file "$T/pass"
mv "$VD/hub.key" "$T/hub.key.aside"
expect_rc "hub-init with hub.key missing while sites exist does NOT make a new key" 3 hub hub-init
mv "$T/hub.key.aside" "$VD/hub.key"
mkdir -p "$T/evilb/etc/cctv/vpn" "$T/evilc/etc/cron.d"
ln -s /etc/shadow "$T/evilb/etc/cctv/vpn/hub.key"
printf 'BACKUP=1\n' >"$T/evilb/cctv-vpn-backup.conf"
cp "$T/evilb/cctv-vpn-backup.conf" "$T/evilc/"
printf '* * * * * root true\n' >"$T/evilc/etc/cron.d/x"
tar -C "$T/evilb" -czf "$T/evil-link.tar.gz" cctv-vpn-backup.conf etc
tar -C "$T/evilc" -czf "$T/evil-path.tar.gz" cctv-vpn-backup.conf etc
PUB_BEFORE=$(cat "$VD/hub.pub")
LIST_BEFORE=$(hub site-list 2>&1)
expect_rc "the disaster: hub-purge --yes --delete-keys (this machine's disk is gone)" 0 hub hub-purge --yes --delete-keys
check "  nothing left: no /etc/cctv/vpn, no $HIF" bash -c "[ ! -e '$VD' ] && ! ip -n cvs-hub link show $HIF 2>/dev/null"
expect_rc "restore of an archive with a symlink as hub.key is refused" 2 hub restore "$T/evil-link.tar.gz"
expect_rc "restore of an archive with a file outside the hub folders is refused" 2 hub restore "$T/evil-path.tar.gz"
expect_rc "restore with a wrong passphrase" 1 hub restore "$T/hub.tar.gz.gpg" --passphrase-file "$T/wrongpass"
check "  none of them wrote anything" test ! -e "$VD/hub.key"
TR=$(date +%s)
expect_rc "restore <backup> --passphrase-file" 0 hubdns restore "$T/hub.tar.gz.gpg" --passphrase-file "$T/pass"
P1=$(pub_of "$ID1")
P3=$(pub_of "$ID3")
for ((i = 0; i < 30; i++)); do
  h1=$(handshake_of "$P1")
  h3=$(handshake_of "$P3")
  ((${h1:-0} >= TR && ${h3:-0} >= TR)) && break
  sleep 0.1
done
if ((${h1:-0} >= TR && ${h3:-0} >= TR)); then ok "  the hub dialed both sites by itself (saved endpoints + keepalive), $((i * 100)) ms after the restore, before any traffic"; else bad "  no handshake started by the hub within 3 s (yard-1 ${h1:-0}, site2 ${h3:-0}, restore at $TR)"; fi
check "  the same hub key" test "$(cat "$VD/hub.pub")" = "$PUB_BEFORE"
check "  the same sites, ids, keys and notes" test "$(hub site-list 2>&1)" = "$LIST_BEFORE"
wait_answer "  yard-1 is back without anything done at the site" cvs-hub "10.78.$ID1.10" 6036 site1 30 3
wait_answer "  site2 is back" cvs-hub "10.78.$ID3.10" 6036 site2 30 3
check "  no gpg-agent left running" bash -c "! pgrep -f '[c]ctv-vpn-gpg' >/dev/null && echo none"

section "(14) idle tunnels are re-keyed before the app's 180 s limit, whichever side started them"
# Only the side that started a session re-keys it, and only when it sends after 120 s; with
# keepalives at both ends only one end sends them. The status job (the 15 s timer, run here by
# hand) pings a gateway whose handshake is 118-178 s old, so that the starting side sends.
check "the hub's peers have a 25 s keepalive (set at runtime)" test "$(nx cvs-hub wg show "$HIF" persistent-keepalive | awk '{print $2}' | sort -u | tr '\n' ' ')" = "25 "
check "  and wg0.conf itself has none (see ensure_keepalive)" bash -c "! grep -q PersistentKeepalive '$HR/etc/wireguard/$HIF.conf' && echo none"
PA=$(pub_of "$ID1")
PB=$(pub_of "$ID3")
a0=$(handshake_of "$PA")
b0=$(handshake_of "$PB")
echo "  waiting up to 200 s (no traffic but keepalives; status --write every 15 s like the timer) for the next handshakes; yard-1 at $a0, site2 at $b0"
a1=$a0 b1=$b0 last=$((SECONDS - 15))
for ((i = 0; i < 100; i++)); do
  if ((SECONDS - last >= 15)); then hub status --write >/dev/null 2>&1 || true; last=$SECONDS; fi
  sleep 2
  a1=$(handshake_of "$PA")
  b1=$(handshake_of "$PB")
  [[ $a1 != "$a0" && $b1 != "$b0" ]] && break
done
for x in "yard-1 $a0 $a1" "site2 $b0 $b1"; do
  read -r nm t0 t1 <<<"$x"
  gap=$((t1 - t0))
  if ((t1 != t0 && gap <= 150)); then ok "$nm re-keyed after $gap s (the app counts a site connected below 180 s)"; else bad "$nm: no re-key within 150 s (gap $gap s)"; fi
done
expect_answer "yard-1 answers" cvs-hub "10.78.$ID1.10" 6036 site1
expect_answer "site2 answers" cvs-hub "10.78.$ID3.10" 6036 site2

section "files, permissions, units"
check "/etc/cctv/vpn is 0700, keys / psk / wg config 0600" bash -c "
  [ \$(stat -c %a '$VD') = 700 ] || exit 1
  for f in '$VD'/hub.key '$VD'/sites/*/private.key '$VD'/sites/*/psk '$HR/etc/wireguard/$HIF.conf'; do [ -e \"\$f\" ] || continue; [ \$(stat -c %a \"\$f\") = 600 ] || { echo \"\$f\"; exit 1; }; done; echo ok"
if command -v systemd-analyze >/dev/null 2>&1; then
  u=$HR/etc/systemd/system
  out=$(systemd-analyze verify "$u/cctv-vpn-firewall.service" "$u/cctv-vpn-status.service" "$u/cctv-vpn-status.timer" "$u/cctv-vpn-fwwatch.service" 2>&1 || true)
  rest=$(grep -v -E '/usr/local/sbin/cctv-vpn.*(not executable|No such file)|^$' <<<"$out" || true)
  [[ -z $rest ]] && ok "systemd-analyze verify: the generated units are clean, the watcher unit too (only the not-yet-installed /usr/local/sbin/cctv-vpn is missing)" || bad "systemd-analyze verify  [$(oneline "$rest")]"
fi

section "hub-purge"
expect_rc "hub-purge --yes" 0 hub hub-purge --yes
check_not "$HIF gone" ip -n cvs-hub link show "$HIF"
check_not "table inet $HTABLE gone" nx cvs-hub nft list table inet "$HTABLE"
check "wg config, status file, state and units (the watcher too) removed; /etc/cctv/vpn kept" bash -c "[ ! -e '$HR/etc/wireguard/$HIF.conf' ] && [ ! -e '$SF' ] && [ ! -e '$HR/var/lib/cctv-vpn' ] && [ ! -e '$HR/etc/systemd/system/cctv-vpn-firewall.service' ] && [ ! -e '$HR/etc/systemd/system/cctv-vpn-fwwatch.service' ] && [ -f '$VD/hub.key' ]"
expect_rc "the guard does nothing once the hub is purged (status --write)" 0 bash -c "ip netns exec cvs-hub env CCTV_VPN_ROOT='$HR' CCTV_VPN_IF=$HIF CCTV_VPN_TABLE=$HTABLE bash '$VPN' status --write; ! ip netns exec cvs-hub nft list table inet $HTABLE >/dev/null 2>&1"
for s in 1 2; do
  root=$T/g$s
  [[ $s == 2 ]] && root=$T/g3
  check "site$s gateway uninstall" nx "cvs-s${s}r" bash "$GW" uninstall --root "$root"
done
check "gateways: tunnel, table gone, ip_forward back to 0" bash -c "for r in cvs-s1r cvs-s2r; do ip -n \$r link show $GIF 2>/dev/null && exit 1; ip netns exec \$r nft list table ip $GTABLE 2>/dev/null && exit 1; [ \$(ip netns exec \$r sysctl -n net.ipv4.ip_forward) = 0 ] || exit 1; done; echo ok"
if command -v systemd-analyze >/dev/null 2>&1; then
  # the gateway's units as a real (systemd) install writes them: with --root nothing is started
  x=$T/x-units
  mkdir -p "$x" "$T/gu"
  tar -xzf "$T/b1d.tar.gz" -C "$x"
  expect_rc "site-gateway.sh install in systemd mode with --root (units written, nothing started)" 0 withhosts "$T/hosts" cvs-s1r env CCTV_SITE_TABLE=cctv_site_units bash "$x/cctv-site-$ID1-yard-1/site-gateway.sh" install "$T/b1d.tar.gz" --root "$T/gu" --no-packages
  check "  nothing was started: no wg-cctv, no table, ip_forward 0" bash -c "! ip -n cvs-s1r link show wg-cctv 2>/dev/null && ! ip netns exec cvs-s1r nft list table ip cctv_site_units 2>/dev/null && [ \$(ip netns exec cvs-s1r sysctl -n net.ipv4.ip_forward) = 0 ] && echo ok"
  g=$T/gu/etc/systemd/system
  out=$(systemd-analyze verify "$g/cctv-site-gateway-firewall.service" "$g/cctv-site-gateway-reresolve.service" "$g/cctv-site-gateway-reresolve.timer" 2>&1 || true)
  rest=$(grep -v -E '/usr/local/sbin/cctv-site-gateway.*(not executable|No such file)|^$' <<<"$out" || true)
  [[ -z $rest ]] && ok "systemd-analyze verify: the gateway's units are clean" || bad "gateway units  [$(oneline "$rest")]"
  check "  the tunnel's drop-in looks the hub name up again (IPv4) when the tunnel starts" grep -x 'ExecStartPost=-/usr/local/sbin/cctv-site-gateway reresolve --force' "$g/wg-quick@wg-cctv.service.d/cctv-site-gateway.conf"
  check "  its wg config dials the IPv4 address and names the DNS name" bash -c "grep -x 'Endpoint = $HUB_WAN:51820' '$T/gu/etc/wireguard/wg-cctv.conf' && grep -F 'vpn.example.test:51820, resolved to IPv4' '$T/gu/etc/wireguard/wg-cctv.conf'"
fi

section "result"
echo "passed $PASS, failed $FAIL"
((FAIL == 0))
