# CCTV VPN: remote NVRs through a WireGuard hub

Remote NVRs are reached through a self-hosted WireGuard hub-and-spoke VPN, and then added in the
app by address. TVT P2P is not used. The hub is the CCTV server itself. Each remote site has one
small gateway, for example a Raspberry Pi, the site's router or a Windows PC. The gateway dials
out to the hub, so remote sites need no port forward and can sit behind 4G or carrier NAT. Many
sites can use the same LAN range.

```
  remote site "yard-a" (id 2)                                 main site 192.168.0.0/22
 +-------------------------------+                         +---------------------------------------+
 | NVR 192.168.1.10  TCP 6036    |                         | router 192.168.1.5                    |
 |   |  LAN 192.168.1.0/24       |   WireGuard, UDP        |   forwards UDP 51820 only --------+   |
 | gateway: Pi / router / PC     |   dials OUT, keepalive  |                                   v   |
 |   tunnel 10.77.0.2/32         | ======================> | CCTV server 192.168.3.147 (the hub)   |
 |   10.78.2.x  <->  192.168.1.x |   25 s (4G/CGNAT ok)    |   wg0 10.77.0.1/24, UDP 51820         |
 +-------------------------------+                         |   app -> 10.78.2.10:6036 = yard-a NVR |
  remote site "depot" (id 3), SAME LAN 192.168.1.0/24      |   app -> 10.78.3.10:6036 = depot NVR  |
 +-------------------------------+ ======================> |   no forwarding, own firewall table   |
 | NVR 192.168.1.10 = 10.78.3.10 |                         +---------------------------------------+
 +-------------------------------+
```

## Addresses

| what | address |
|---|---|
| hub (CCTV server) in the tunnel | `10.77.0.1/24`, UDP **51820** (`--port` to change; on WSL see below) |
| site N gateway (N = 2..250) | `10.77.0.N/32` |
| site N's LAN, as the CCTV server sees it | `10.78.N.0/24` (virtual; the gateway maps it 1:1 onto the real LAN) |
| an NVR at `192.168.1.10` at site 3 | **`10.78.3.10`**, port 6036, in the app |

- **There is no site 1.** Its tunnel address would be the hub's own `10.77.0.1`. Site ids run
  from 2 to 250, and `10.78.1.0/24` stays unused.
- A site's LAN must be one private /24: 10/8, 172.16/12 or 192.168/16, and not 10.77.0.0/24 or
  10.78.0.0/16. For a bigger LAN, give the /24 that holds the NVRs.
- **NVRs in more than one /24 at one site** (for example 192.168.0.x and 192.168.2.x, laid out like
  the main site) cannot share one site id: the virtual /24 keeps the last octet. Either give each
  /24 its own site (its own id and its own gateway box: one box is the gateway of one site only),
  or re-address the NVRs into one /24.
- The site's LAN may overlap the main site or other sites. That overlap is the reason for the
  mapping.
- **Removed site ids are never handed out again automatically.** Otherwise the app's old NVR
  entries (and their passwords) would reach a different site. See `--reuse-id`.

## What can talk to what (least privilege)

- **Only the CCTV server opens connections, and only to TCP 6036 and ping.** Any other port
  into the tunnel is refused at once (`EHOSTUNREACH`). The site gateway also drops it, as a
  second layer. This is enforced by port, not by program: **any process or user on the CCTV
  server** can reach TCP 6036 of every remote NVR (see *Security notes*).
- **Nothing from a site can open a connection to the CCTV server.** That covers the web UI,
  SSH and ping: from `wg0`, only replies to the hub's own connections get in. The hub's output
  side is closed as well: it sends nothing into the tunnel but TCP 6036 and ping, so it could not
  even answer a connection that got in.
- **The firewall is kept exactly as generated.** `cctv-vpn` remembers the table it loaded. A
  watcher (`cctv-vpn-fwwatch.service`, following `nft monitor`) puts it back within about half a
  second when anything flushes, deletes or edits it (for example an `nft insert ... accept` left
  over from debugging, or `nft flush ruleset`); the 15 s status timer does the same as a backstop.
  If the table cannot be loaded, `wg0` is taken down (fail closed). `wg0` never starts unless the
  table is exactly right (its PreUp checks), and `cctv-vpn check` fails on any difference.
- **The hub never forwards.** `net.ipv4.ip_forward` stays 0, and the firewall also drops
  anything routed through `wg0`. So a site cannot reach another site or the main LAN, even from
  a tampered gateway.
- **Each site's peer list holds only the hub (`10.77.0.1/32`).**
- **At the site, only TCP 6036 and ping from `10.77.0.1` reach the LAN.** They must arrive
  through the mapping. The gateway itself, its SSH and anything else are dropped. Nothing on the
  site LAN can start a connection into the tunnel.
- **A gateway box does not become a router.** A Linux box that did not route before the install
  (for example a Pi with Ethernet on the NVR LAN and Wi-Fi on another network) forwards only the
  tunnel's NVR traffic; everything else between its networks stays dropped.
- **The NVR's replies come back without changes at the site.** The gateway rewrites the source
  to its own LAN address, so the NVR and the site router need no route or change. If an NVR has
  an IP allow-list, allow the gateway's LAN address.
- **Leak guard: VPN addresses never leave the hub by another interface.** While `wg0` is down,
  `10.78.x.x` fails at once instead of going to the main router.

## Files here

| file | runs on | what |
|---|---|---|
| `cctv-vpn` | the CCTV server, as root | the hub: keys, sites, `wg0`, firewall, status for the app, bundles, backup |
| `site-gateway.sh` | a Linux box at the site (Raspberry Pi OS, Debian, Ubuntu) | makes it the site's gateway from a bundle |
| `site-recipes.sh` | any Linux/WSL machine | writes filled-in setup files for MikroTik, OpenWrt, RutOS, pfSense, OPNsense, EdgeOS, UniFi, Windows |
| `test-sim.sh` | the test PC, as root | end-to-end simulation in network namespaces (see *Testing*) |
| `test/site-sim.sh` | the test PC, as root | the gateway-side simulation (3 site types, 22 bad bundles) |

## 1. Set up the hub (once)

On the CCTV server: the test PC's Ubuntu in WSL, or later the production Ubuntu Server.
`wireguard-tools` and `nftables` must be installed (`sudo apt install wireguard-tools nftables`).
They are already on the test PC.

```
# production (native Ubuntu):
sudo bash /opt/cctv/current/deploy/vpn/cctv-vpn hub-init --endpoint <public IP or DNS name of the main site>
# the test PC (WSL): listen outside Windows' dynamic port range, keep 51820 as the public port
sudo bash /opt/cctv/current/deploy/vpn/cctv-vpn hub-init --port 41820 --endpoint <public IP or DNS name>:51820
```

- **Idempotent.** Run it again to change `--port` or `--mtu`, or after an app update: it also
  refreshes `/usr/local/sbin/cctv-vpn` and the gateway scripts it puts into bundles.
- **Changing `--endpoint` (or the public port) while sites exist needs `--yes`.** Every gateway
  keeps dialing the old address, and there is no remote way into them: without `--yes` the tool
  only lists what each site will need (a new bundle, or a changed `Endpoint`). Keep the old address
  working until every site is changed.
- **The endpoint:** what the sites dial. Prefer a DNS name you control, so that a new public IP
  means changing one DNS record instead of visiting every site. The name must have an **A
  record only** (no AAAA): routers on 4G with IPv6 would otherwise dial the IPv6 address, and the
  main site forwards only IPv4. `hub-init` warns when the name has an AAAA record. (Linux gateways
  resolve IPv4 only, so they are safe either way.) Without an endpoint the hub still runs, but
  `site-bundle` refuses until one is set.
- **WSL (the test PC): use `--port 41820`.** In mirrored mode Windows and Linux share one port
  space, and 51820 lies in Windows' dynamic range (49152-65535): any Windows program could take it
  as a temporary port, and WireGuard would then get nothing. 41820 is outside that range and
  outside WSL's own range (44620-48715). The router then forwards external UDP 51820 to port
  41820. `hub-init` reads the ranges (read-only, `netsh`) and warns. Native Ubuntu keeps 51820.
- **Checks first.** It stops (exit 3), without changing anything, if:
  - the VPN ranges are already used;
  - the UDP port is taken;
  - a foreign `wg0` or `wg0.conf` exists;
  - on WSL, the networking mode is not `mirrored`;
  - `hub.key` is missing while sites are recorded (a new key would cut every site off: restore the
    backup instead, or give `--new-hub-key` if the old key is truly lost).
- **What it creates:**
  - `/etc/cctv/vpn/` (0700), holding the hub key, the site records and `cctv_vpn.nft`;
  - `/etc/wireguard/wg0.conf` (0600, generated: do not edit);
  - the units `cctv-vpn-firewall.service` (the nft table `inet cctv_vpn`), `wg-quick@wg0`
    (with a drop-in: no firewall, no `wg0`), `cctv-vpn-status.timer` (every 15 s) and
    `cctv-vpn-fwwatch.service` (puts the table back at once);
  - `/var/lib/cctv-vpn/` (the sites' last addresses, the table as loaded) and
    `/run/cctv/vpn-status.json` for the app.
- **What it prints:** checks 1 to 6, then the steps below with this machine's values filled in.
  `cctv-vpn hub-info` prints them again later.

**The main-site router (192.168.1.5), once.** Both of these are yours to set up; the tools never
change the router.

- Add a port forward ("virtual server"): **UDP** (not TCP), external port 51820 to the CCTV
  server's LAN address (for example 192.168.3.147), port 51820 (on the test PC: port 41820).
  Nothing else: no other port and no DMZ.
- Give the CCTV server a DHCP reservation, or the forward breaks when its address changes.
- Check the router's WAN address. If it starts with 10., 100.64 to 100.127., 172.16 to 172.31.
  or 192.168., the main site is behind carrier-grade NAT. See *Troubleshooting*.

**Windows on the test PC (WSL only), PowerShell as Administrator, once** (`hub-init` prints these
with the port it listens on; shown here for `--port 41820`):
```
New-NetFirewallRule -Name cctv-vpn-wg -DisplayName "CCTV VPN hub (WireGuard UDP 41820)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 41820 -Profile Any
New-NetFirewallHyperVRule -Name cctv-vpn-wg-wsl -DisplayName "CCTV VPN hub (WireGuard UDP 41820) for WSL" -Direction Inbound -Action Allow -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol UDP -LocalPorts 41820
```
- The PC must not sleep: `powercfg /change standby-timeout-ac 0`. WSL must be running, and
  `.wslconfig` must keep `networkingMode=mirrored`.
- WSL passes inbound UDP to Linux only for ports a normal program has bound. Kernel WireGuard
  binds inside the kernel, so `cctv-vpn` makes a deliberately failing bind on the port after
  `wg0` is up, which makes WSL register it. The outside test below proves whether this works.
- On native Ubuntu this block is replaced by `ufw allow 51820/udp`, and only if ufw is active.
  The same goes for firewalld.

**Test from outside the main site** (for example a laptop on a phone hotspot), in PowerShell:
```
$u = New-Object System.Net.Sockets.UdpClient; [void]$u.Send([byte[]](1,2,3), 3, '<endpoint>', 51820)
```
Then run `sudo cctv-vpn status` on the server: "UDP ... packets received" must have gone up.
That one counter proves the router forward, the Windows rules and the WSL claim together. Then
run `sudo cctv-vpn check`.

**Then make the first backup** (see *Back up the hub*): without it, losing this machine means
visiting every site.

## 2. Add a site

```
sudo cctv-vpn site-add yard-a --lan 192.168.1.0/24 --note "Pi 4 behind the Teltonika, RMS"   # -> id 2
sudo cctv-vpn site-bundle yard-a --out /media/usb/cctv-site-2-yard-a.tar.gz
```

- **Name:** 1 to 32 of `a-z 0-9 -`, not starting or ending with `-`, and not only digits.
- **`--note TEXT`:** what is there and how to reach it (device, remote access such as Teltonika
  RMS, MikroTik or UniFi cloud, a phone number). Shown by `site-list` and in the lists the tool
  prints when every site needs a visit. `site-set NAME --note ...` changes it.
- **`--lan none`:** the site's LAN is not known yet. The Linux gateway then uses its own /24,
  and you record it later with `site-set yard-a --lan ...`.
- **Adding the same name again** with the same LAN changes nothing. With another LAN it is
  refused: use `site-set`.
- **`--pubkey KEY`:** the site's device makes its own key, so the private key never exists on
  the hub. Make it on the device with `umask 077; wg genkey > /root/cctv-site.key; wg pubkey < /root/cctv-site.key`,
  or with the router's own "generate" button. The bundle then holds no key: install it with
  `site-gateway.sh ... --key /root/cctv-site.key`, or paste the router's own key.
- **`--no-psk`:** no preshared key. By default the tool adds one (extra protection).
- **`--id N`:** choose the id yourself. For an id that belonged to a removed site, also give
  `--reuse-id`, and remove that site's old NVRs from the app first.
- **Undo an accidental `site-remove`** without a visit, while the gateway still has its keys:
  `site-add NAME --lan CIDR --id N --reuse-id --pubkey <its public key> --psk-file <its site.psk>`.
  The public key is in `/etc/cctv/vpn/retired/N.conf`; the preshared key was deleted with the
  site, so it must come from the site's bundle (`site.psk`) or the device's own config (or from a
  backup, restored elsewhere). The hub then dials the site's last address at once.

**The bundle:**

- Contents: `site.env` (no secrets), `site.key` and `site.psk`, `wg0.conf` (for routers and
  Windows), `README.txt`, `site-gateway.sh` and `site-recipes.sh`.
- `site-bundle` prints the sha256 of the archive.
- **It holds the site's private key.** Whoever has a copy can stand in for that site's gateway
  from anywhere and receive the app's NVR logins for that site. Copy it to the site over a
  secure channel (scp, or a USB stick you keep), then delete every copy. Without `--out` it is
  written to `/etc/cctv/vpn/bundles/` (root only).
- `--forget-key` removes the private key from the hub once the archive is written; the bundle is
  then the only copy. It needs `--out` pointing outside `/etc/cctv/vpn` (a bundle kept there
  would still hold the key). Afterwards `site-bundle` refuses to make a bundle for that site
  (it cannot hold the key any more); `--no-key` makes one without the key, for a gateway that
  still has it, and `site-rekey` gives the site a new key.
- `--endpoint HOST:PORT` makes this one bundle dial another address, for example a site whose
  network blocks UDP 51820 (see *Operating many sites*).
- `--out -` writes it to stdout.

### At the site: pick the recipe for the equipment there

**A. Linux box: Raspberry Pi, Debian or Ubuntu (recommended; works behind any router).**
A Pi 3/4/5 with Raspberry Pi OS Lite 64-bit and ONE LAN cable to a free port of the site
router is enough. It does not have to be the router.
```
tar -xzf cctv-site-2-yard-a.tar.gz
sudo bash cctv-site-2-yard-a/site-gateway.sh check   cctv-site-2-yard-a.tar.gz   # the plan; changes nothing
sudo bash cctv-site-2-yard-a/site-gateway.sh install cctv-site-2-yard-a.tar.gz   # safe to re-run
sudo cctv-site-gateway status                                                     # later
```
- **Options:**
  - `--only 192.168.1.10,192.168.1.11` allows only these NVRs, instead of the whole /24;
  - `--lan-if eth0` picks the LAN interface when more than one fits;
  - `--key FILE` gives the box's own key, for `--pubkey` sites;
  - `--no-wait` does not wait for the first handshake (preparing a box before it goes to the site).
- **Exit code 5 = installed, but NOT connected** (no handshake within 20 s). It prints the likely
  causes: no internet, the main-site forward missing, a wrong endpoint, UDP blocked at the site.
  Do not leave the site on exit 5. Exit 0 means the tunnel is up.
- **What `install` sets up:**
  - apt-installs `wireguard-tools` and `nftables` if missing;
  - interface `wg-cctv`, nft table `ip cctv_site`, systemd units (the firewall starts before
    the tunnel, and the tunnel needs it);
  - `net.ipv4.ip_forward=1`, restored by `uninstall`. If the box did not route before, its
    firewall forwards nothing but the tunnel's NVR traffic (the plan says which case applies);
  - for a DNS hub address: the name is resolved to its IPv4 address (A record) at install, again
    when the tunnel starts, and by a timer once the tunnel has been silent for 135 s.
- **It refuses rather than guesses:** a LAN that is not directly attached, VPN ranges already
  in use, a bundle with odd names or links, keys that do not match, and so on.
- **It warns about other firewalls** (ufw, firewalld, Docker's FORWARD drop) and prints the
  fix.

**B. MikroTik (RouterOS 7.1+)**
```
bash site-recipes.sh cctv-site-2-yard-a.tar.gz mikrotik [--lan-if bridge] [--nvr 192.168.1.10]
```
- Upload `cctv-site-2.rsc` in WinBox > Files, then run `/import file-name=cctv-site-2.rsc` and
  `/file remove cctv-site-2.rsc`.
- **What the import adds:**
  - interface `wg-cctv`, MTU 1280, one peer, the hub (`10.77.0.1/32`, keepalive 25 s);
  - `action=netmap` from `10.78.2.0/24` to `192.168.1.0/24`, TCP 6036 and ICMP only;
  - masquerade towards the LAN and an MSS clamp of 1240;
  - own filter chains placed before fasttrack;
  - for a DNS hub name, a re-resolve scheduler (every minute).
- Importing again is safe (everything is tagged `cctv-vpn`). `cctv-site-2-remove.rsc` undoes it.
- Check with `/interface wireguard peers print detail`.

**C. OpenWrt 19.07 or newer (fw3 or fw4)**
```
bash site-recipes.sh cctv-site-2-yard-a.tar.gz openwrt
scp -O cctv-site-2-openwrt/cctv-site-2-openwrt.sh root@<router>:/tmp/ && ssh root@<router> 'sh /tmp/cctv-site-2-openwrt.sh && rm /tmp/cctv-site-2-openwrt.sh'
```
(19.07 and 21.02 have no `scp -O`: leave it out there.)
- The same script works on every version from 19.07. It checks for firewall4 (22.03 and newer, nftables) or firewall3 (19.07 and 21.02, iptables) and prints which it found. It refuses 18.06 and older.
- **What the script adds:**
  - uci interface `cctv` and zone `cctv` (input and forward drop);
  - rules for TCP 6036 and ping from `10.77.0.1` only;
  - the 1:1 map and MSS, kept over sysupgrade:
    - fw4: `/etc/nftables.d/50-cctv-vpn.nft`;
    - fw3: `/etc/firewall.cctv-vpn`, iptables NETMAP rules that the firewall runs at every start and reload (include `cctv_inc`). It also installs `iptables-mod-nat-extra`, and stops with a message if the map did not load.
  - `wireguard_watchdog` (every minute) for a DNS hub name.
- Check with `wg show cctv`. A remove script is included; it also takes the fw3 chains out.
- After upgrading a router from 21.02 to 22.03 or newer, run the script again.
- Tested: the fw4 map loads under `nft -c` in the simulation. The fw3 map is checked for syntax and by review only (the test PC's kernel would have to load iptables modules for more); no real OpenWrt router has run either yet.

**D. Teltonika RutOS (built-in WireGuard)**
Run `bash site-recipes.sh ... rutos --nvr 192.168.1.10,192.168.1.20` and follow its
`README.txt`:
1. Services > VPN > WireGuard: instance `cctv`. Paste the key, IP `10.77.0.2/32`, MTU 1280.
2. Add the peer: the hub key, the endpoint, Allowed IPs `10.77.0.1/32`, keepalive 25.
3. Firewall zone `cctv`: input and forward drop, no forwardings.
4. Mapping: **one Port forward per NVR** (source zone cctv, source IP 10.77.0.1, external IP
   `10.78.2.x` port 6036, to `192.168.1.x:6036`). This carries TCP only, so a ping to
   `10.78.2.x` gets no answer. The iptables NETMAP variant needs the "IPtables NAT extra"
   package.
5. For a DNS hub name: RutOS resolves it only when the instance starts. The folder has
   `cctv-vpn-reresolve.sh` and the crontab line that runs it every minute.

**E. pfSense / OPNsense**
Run `bash site-recipes.sh ... pfsense` (or `opnsense`); its README has every field filled in:
1. Add the WireGuard tunnel and peer (keepalive 25, Allowed IPs `10.77.0.1/32`).
2. Assign the interface: `10.77.0.2/24`, MTU 1280, MSS 1240.
3. Firewall > NAT > 1:1 (OPNsense: One-to-One, BINAT): external `10.78.2.0`, internal
   `192.168.1.0/24`.
4. Rules on the tunnel interface: pass TCP 6036 and ICMP echo from 10.77.0.1 only, using the
   **real** addresses (NAT is applied first).
5. On the WireGuard group tab: no rules.
6. On LAN: block traffic to 10.77.0.1.
7. A DNS hub name: pfSense looks it up again every 300 s by default (leave that setting on);
   OPNsense needs the cron job "Renew DNS for WireGuard on stale connections" (the README says
   where).

**F. Ubiquiti**
- **EdgeOS:** needs the WireGuard package (wireguard-vyatta-ubnt). `site-recipes.sh ... edgeos
  --nvr ...` writes the `set ...` commands: a DNAT rule per NVR, and firewalls CCTV_VPN_IN, OUT
  and LOCAL. The tunnel is `wg77` (`--ifname wgN` for another) and the NAT rules are 4400+x
  (TCP) and 4700+x (ping), x = the NVR's last octet, and 7400 (masquerade). **Before pasting,**
  check that the router does not use that interface or those rule numbers already (the file's
  first lines give the two `show` commands): the paste deletes and replaces them. A remove file is
  included; paste the old one first when the NVR list changes. For a DNS hub name it adds a
  task-scheduler job with `cctv-vpn-reresolve.sh` (EdgeOS resolves the name only once).
- **UniFi (Network 9.x):** VPN Client > WireGuard, uploading `wg0.conf` with no traffic routes.
  Then one custom DNAT per NVR, plus a zone-firewall allow for TCP 6036 from 10.77.0.1.
- If the firmware will not let you pick the VPN client in NAT and firewall, put a Raspberry Pi
  (recipe A) behind the gateway instead.

**G. Windows PC on the site LAN (when nothing else is possible)**
Windows cannot 1:1-map a subnet, so the PC relays each NVR instead:
1. Run `bash site-recipes.sh ... windows --nvr 192.168.1.10,192.168.1.20`.
2. Install WireGuard for Windows, then Import tunnel(s) from file, `cctv-site-2.conf`, Activate.
   That config gives the adapter one extra address per NVR (`10.78.2.10/32`, ...).
3. In an Administrator PowerShell, run
   `powershell -ExecutionPolicy Bypass -File .\cctv-site-2-setup.ps1 -NoSleep`.
   It sets up a `netsh interface portproxy` from `10.78.2.x:6036` to `192.168.1.x:6036`, firewall
   rules on the tunnel adapter only, and a watchdog task. The task runs as SYSTEM and carries its
   commands itself (`-EncodedCommand`, PowerShell by its full path): it never runs a file that a
   normal user could change. `-Remove` undoes it.

Limits: TCP only, the PC must stay on, and every NVR must be listed. A ping to `10.78.2.x` is
answered by the PC, not by the NVR. For the app nothing changes: the NVR is still
`10.78.2.x:6036`.

**H. The NVR itself:** TVT NVRs have no WireGuard, OpenVPN or IPsec client, so every site needs
one of the gateways above.

**Test the site.** First, at the site:
- the device shows a WireGuard handshake less than 2 minutes old
  (`sudo cctv-site-gateway status`, or `wg show wg-cctv`);
- `ping 10.77.0.1` from the site is **not** answered. That is by design.

Then on the server:
```
sudo cctv-vpn status                                     # site "connected", handshake age
ping -c3 10.77.0.2                                       # the gateway (Linux, MikroTik, OpenWrt answer)
timeout 5 bash -c '</dev/tcp/10.78.2.10/6036' && echo open    # the NVR through the tunnel: the real test
```

## 3. Add the NVRs in the app

- **Adding an NVR.** On Sites, add the NVR with host `10.78.<site id>.<last octet of its LAN
  address>`, port 6036, and its own user and password. Example: 192.168.1.10 at site 2 is
  `10.78.2.10`. The NVRs need fixed addresses at the site (static, or a DHCP reservation).
- **Finding NVRs.** Sites > Find NVRs with a range such as `10.78.2.0/24` sweeps a site over
  the VPN (TCP 6036 is allowed). The TVT multicast search does not cross the tunnel.
- **The Sites page status.** The page shows each VPN site from `/run/cctv/vpn-status.json`
  (written every 15 s; no secrets). A site counts as connected when its last handshake is less
  than 180 s old. An idle tunnel re-handshakes every 120 to 145 s whichever side started it,
  plus up to 15 s of file age: both ends send keepalives, and the 15 s status job pings an idle
  gateway's tunnel address once its handshake is 2 minutes old (only the side that started a
  session renews it, and only when it sends; the ping makes both sides send). Every recipe lets
  the hub ping the gateway. Without the ping a session could go 165 to 190 s (seen: 170 s).

## Status, check, list

```
sudo cctv-vpn status           # hub line (wg0, port, endpoint, firewall, ip_forward, counters) + each site
sudo cctv-vpn status --json    # exactly what the app reads
sudo cctv-vpn check            # PASS/WARN/FAIL for every item below (exit 1 on a FAIL)
sudo cctv-vpn site-list [--retired]
sudo cctv-vpn fw-verify        # is the firewall table exactly as generated? (loads it again if not)
```

`check` looks at:
1. the four units are active (firewall, `wg-quick@wg0`, status timer, firewall watcher);
2. the firewall table is loaded and **exactly** as generated (any flushed, deleted or added rule
   fails), and `cctv_vpn.nft` (the file the boot unit loads) was not edited;
3. `wg0` has the right address, MTU, port and key;
4. the peers match the site records, each with the hub's 25 s keepalive;
5. `10.78.x` routes via `wg0` from `10.77.0.1`;
6. `ip_forward` is 0;
7. packets arrive on the UDP port;
8. each site's handshake is recent;
9. each gateway answers ping;
10. (by hand, from a site) the hub is not reachable from there;
11. the status file is fresh and mode 644;
12. file permissions are right, and no bundle on the hub still holds a key the hub forgot;
13. (by hand) the leak guard works;
14. the backup is up to date.

The status file has exactly this shape:
```
{"at":"2026-09-24T03:33:37Z","hub":{"publicKey":"...","listenPort":51820,"address":"10.77.0.1/24","endpointHint":"vpn.example.com:51820"},
 "sites":[{"id":2,"name":"yard-a","tunnelIp":"10.77.0.2","virtualSubnet":"10.78.2.0/24","realLan":"192.168.1.0/24",
           "endpoint":"198.51.100.2:59010","latestHandshake":1790220791,"rxBytes":3214532,"txBytes":23516}]}
```

## Back up the hub

The hub key, the site records and their keys exist only in `/etc/cctv/vpn`. If that is lost
(a dead disk, a reinstalled WSL distro), `hub-init` would have to make a new hub key and **every
site would need a visit**. A backup avoids that:

```
sudo cctv-vpn backup --out /media/usb/cctv-vpn-2026-09-24.tar.gz.gpg     # asks for a passphrase (12+ characters)
sudo cctv-vpn restore /media/usb/cctv-vpn-2026-09-24.tar.gz.gpg          # on a machine without a hub
```

- The file is encrypted with gpg (AES256, your passphrase) and holds the hub key, every site
  record and key, the retired ids and the sites' last addresses. Keep it **off** this machine
  (another computer, a USB stick in a safe) and keep the passphrase apart from it.
  `--passphrase-file F` reads the passphrase from a file; `--no-encrypt` writes a plain
  `.tar.gz` for an already encrypted medium.
- Make a new one after every `site-add`, `site-remove`, `site-rekey`, `hub-rekey` or key
  change: those commands say "backup is now out of date", and `check` item 14 says so too.
- `restore` refuses a machine that already has a hub, an archive with links or unexpected
  names, a wrong passphrase, and records or keys that do not match; nothing is written until all
  of it checks out. It then runs `hub-init` with the restored settings. The sites keep the same
  keys and the same address, so none needs a visit; the hub dials each site's last address at
  once (measured in the simulation: all sites back within the same second).

**Moving the hub from the test PC to production** (sites need no change: same keys, same
endpoint):
1. On the old hub: `sudo cctv-vpn backup --out <file>`, and copy the file to the new server.
2. On the new server: `sudo cctv-vpn restore <file>` (then the ufw/firewalld step it prints).
3. Point the router's port forward at the new server (and its port: 51820 on native Ubuntu).
4. On the old hub: `sudo cctv-vpn hub-purge --yes --delete-keys`, so no key stays behind.

## Operating many sites

By design the hub has **no way into any gateway**, so some changes can only be made at the site
(or through the site device's own remote access). Plan for it, and record in each site's
`--note` what is there and how to reach it.

| change | what the sites need |
|---|---|
| NVRs added at a site, same /24 | nothing (add them in the app) |
| a new NVR behind a **Windows** relay, or with `--only` / `--nvr` lists | re-run the recipe there |
| `site-rekey` (key leaked, device replaced) | that site: a new bundle installed |
| `site-set --lan` (the site's LAN changed) | that site: a new bundle installed |
| `hub-init --endpoint` / public port change | **every site**: a new bundle, or `Endpoint` changed on the device (hence `--yes`) |
| `hub-rekey` | **every site**: the new hub public key |
| the main site's public IP changes, hub is a DNS name | nothing: update the A record (Linux gateways, MikroTik, OpenWrt, pfSense follow by themselves; RutOS, EdgeOS, OPNsense once their recipe's DNS step is done) |
| the main site's public IP changes, hub is a bare IP | **every site** (so prefer a DNS name) |
| a new version of `site-gateway.sh` | only if a fix matters for that site: re-run install there |
| the CCTV server is replaced | nothing, with a backup (see above) |

- **A site whose network blocks UDP 51820** (some 4G APNs do): forward a second external port
  on the main router, for example UDP 443, to the same server port, and give that one site a
  bundle made with `site-bundle NAME --endpoint <host>:443`.
- **Keep a spare:** a Pi prepared with `site-gateway.sh install ... --no-wait` can be swapped
  in by anyone on site.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| "UDP ... packets received" stays 0 after the outside test | The router forward is missing, or points at the wrong IP or port (DHCP changed: reserve it). The Windows rules are missing. The WSL claim did not take effect, or a Windows program holds the port (use `--port 41820` on WSL). The main site is behind CGNAT. Double NAT (forward on both routers). Wrong `--endpoint`. |
| handshake initiations rise, but no handshake | The site has the wrong hub key, the wrong own key or the wrong PSK: make a new bundle. Or the site's clock went back: `sudo cctv-vpn site-reset <site>`, and make the gateway start WireGuard only after NTP. |
| a router at a site never connects, its status shows an IPv6 endpoint | The hub's DNS name has an AAAA record. Remove it (A record only), or also forward UDP over IPv6 to the server. |
| no handshake from one site only, its internet works | Its network may block UDP 51820: `site-bundle <site> --endpoint <host>:443` plus a router forward of UDP 443 (see *Operating many sites*). |
| handshake OK, NVR not reachable | Gateway mapping, forward or masquerade missing; wrong `--lan`; the NVR is outside the mapped /24; the site router's firewall; an NVR IP allow-list (allow the gateway). `ping 10.77.0.N` tells gateway problems from NVR problems. |
| small data works, video stalls | MTU. The hub uses 1280, so this should not happen. `ss -tin dst 10.78.N.x` should show an MSS of about 1228. |
| the log says a site's address "changed 3 times in 10 minutes" | Two devices may hold that site's key (a copied bundle, an old router still running). Unless the site's router is restarting over and over: `site-rekey`, a new bundle, and new NVR passwords at that site. |
| the log says the firewall table "was changed outside cctv-vpn" | Someone or something edited, flushed or deleted `table inet cctv_vpn`; it was put back. Find out who (debugging, a firewall tool that flushes the ruleset). |
| app says the status is out of date | `systemctl status cctv-vpn-status.timer`; `journalctl -u cctv-vpn-status`. |
| after a hub reboot, sites are slow to come back | Only if `/var/lib/cctv-vpn/endpoints` is missing. Otherwise `wg0` dials each site's last address at once. |
| `hub-init` exits 2 or 3 | It says why: range or port in use, a foreign `wg0`, WSL not mirrored, `hub.key` missing while sites exist, or an endpoint change without `--yes`. |

**Hub behind carrier-grade NAT** (the router's WAN address is private or 100.64/10): no port
forward can work. In this order:
1. Ask the ISP for a public IPv4 address, or to opt out of CGNAT.
2. If the main site and the sites' 4G have IPv6: use an IPv6 endpoint (an AAAA name), with a
   router pinhole for UDP 51820 to the server.
3. A small VPS as a dumb UDP relay (a separate design; it never holds site keys).

Without the VPN, a site's NVRs can also be added by serial number through the P2P cloud they are
sold with (Sites, Add NVR, Serial number): no port forward at either end, but the login and the
video then pass through that cloud.

## Security notes

- **Private keys stay root-only.** The hub key and each site key are root-only (`/etc/cctv/vpn`
  0700, files and `wg0.conf` 0600). Site records are `KEY=value` files that are parsed, never
  sourced, and every value is validated.
- **Every input is validated.** That covers names, CIDRs, ids, keys, endpoints, ports, notes and
  backup archives: they end up in file names, firewall rules and configs.
- **The status file and the timer never touch secrets.** The timer and the watcher run as root
  with only `CAP_NET_ADMIN` and full systemd sandboxing, and read only `wg show` subcommands that
  print no secrets.
- **A site's bundle is as good as its gateway.** Whoever holds a copy (or the gateway device)
  can stand in for that site's gateway from any internet address: the hub then sends the app's
  connections for that site, **including the TVT logins with the NVR user and password**, to
  them. They still cannot reach the CCTV server or other sites. So: move bundles over secure
  channels and delete them after installing; prefer `--pubkey` sites or `--forget-key`. If a
  bundle or device may be in other hands: `site-rekey`, a new bundle, **and new passwords on that
  site's NVRs** (then in the app). The hub logs a warning when a site's address keeps jumping
  between two places, the sign of two holders of one key.
- **The firewall matches ports, not programs.** Any process or user on the CCTV server can reach
  TCP 6036 (and ping) at every site, not only the app. Limiting it to the app needs an owner
  match in the table (`meta skuid`), which needs a fixed user for the app instead of its current
  systemd DynamicUser; a cgroup match would break at boot, when the app is not running yet. Keep
  the CCTV server single-purpose and its user accounts few.
- **A compromised site can still attack the app.** It can send hostile replies to the app's TVT
  SDK, but only on TCP 6036, and only inside the app's systemd sandbox.
- **The firewall cannot be switched off quietly.** See *What can talk to what*: the watcher
  and the timer put the exact table back, `wg0` stops if they cannot, and `check` fails.
- **The backup holds every key.** It is encrypted with your passphrase; a `--no-encrypt` backup
  belongs on an encrypted medium only.
- **The Windows relay's watchdog** runs as SYSTEM without any file on disk, so a normal user on
  that PC cannot take it over.

## Key rotation

- **A site key** (router replaced, bundle leaked, device lost): run
  `sudo cctv-vpn site-rekey <site> --yes`, then `site-bundle <site>` and install the new bundle
  at the site. This makes a new key pair and a new PSK, and the old key stops working at once.
  The site is down until the new bundle is in: WireGuard cannot hold two keys for one peer.
  With `--pubkey KEY`, the device makes the key itself. **If the old key may be in someone else's
  hands, also change the passwords of that site's NVRs.**
- **The hub key** (only if the server is compromised): run `sudo cctv-vpn hub-rekey --yes`.
  Every site is cut off until its gateway has the new hub public key. The tool lists what each
  site needs: a new bundle, or just `[Peer] PublicKey`.
- **Session keys** renew about every 2 minutes by themselves (forward secrecy).
- After any of these: a new backup.

## Removal

- **A site:** run `sudo cctv-vpn site-remove <site> --yes`. The peer leaves `wg0` at once, the
  keys are deleted and the id is retired. Then remove the NVRs at `10.78.N.*` from the app.
  At the site, run `sudo cctv-site-gateway uninstall` (Linux) or the recipe's remove script.
- **Stop the hub:** run `sudo cctv-vpn hub-down`. It stays down after reboots, and the firewall
  table stays loaded so nothing leaks. `hub-up` starts it again.
- **Remove the hub:** run `sudo cctv-vpn hub-purge --yes [--delete-keys]`. This removes the
  units, `wg0`, the table, the status file and the state. `/etc/cctv/vpn` is kept unless you
  give `--delete-keys`; give it when the machine is decommissioned.
- **By hand afterwards:** the router's UDP forward. On Windows, run
  `Remove-NetFirewallHyperVRule -Name cctv-vpn-wg-wsl ; Remove-NetFirewallRule -Name cctv-vpn-wg`.

## Testing

`sudo bash deploy/vpn/test-sim.sh` needs root, `wireguard-tools`, `nftables`, python3, gpg and
unshare, and takes about 5 minutes. It runs the **real** `cctv-vpn` and the `site-gateway.sh`
from inside each bundle, entirely in network namespaces `cvs-*` that it creates and always
deletes (trap):

- a hub (`cvhub0`, table `inet cctv_vpn_sim`, files under a temp folder via `CCTV_VPN_ROOT`);
- a carrier NAT;
- two sites that both use `192.168.1.0/24` with an NVR at `192.168.1.10`;
- DNS names from a hosts file bind-mounted over `/etc/hosts` for single commands only.

It then checks:
- the overlapping LANs stay apart;
- port 22 is blocked (by the hub, and by the gateway alone);
- sites cannot reach the hub or each other, even with a tampered gateway and hub forwarding on;
- the status JSON (shape, values, no secrets; also through the app's own `cctv/vpn.mjs`);
- the firewall guard: an inserted accept, `nft flush table`, `nft delete table`, an edited
  `cctv_vpn.nft`, the watcher (restores in about 0.5 s, no reload loop), the PreUp at a boot-like
  `wg-quick up`, and fail-closed when nft cannot load (PreUp refuses, the timer takes `wg0` down);
- a gateway box that did not route before forwards only the tunnel;
- the endpoint-jump warning;
- `site-remove` cuts a site off, and an accidental removal is undone without a site visit;
- adding an existing site again is idempotent; site notes;
- about 70 bad inputs are refused and change nothing;
- `hub-down` does not leak, `hub-up` dials the saved endpoints (sites back in 0 s), and a gateway
  install without a handshake exits 5;
- retired ids are not reused; `--forget-key` / `--no-key`;
- the `--pubkey` / `--key` flow, `site-rekey`, `hub-rekey`, `site-reset`, `site-set`;
- a hub DNS name with an A and an AAAA record: `hub-init` warns and wants `--yes`; a gateway on a
  network with IPv6 still dials IPv4 (plain `wg` would pick IPv6) and follows a DNS change;
- a per-bundle endpoint (UDP 443);
- every router recipe renders (IP and DNS endpoints); the Windows task has no file; EdgeOS uses
  `wg77` and deletes each NAT rule before setting it;
- backup, the loss of the whole hub (`hub-purge --delete-keys`), hostile archives, a wrong
  passphrase, restore: same keys and sites, sites back in 0 s without any change at the site, no
  gpg agent or folder left behind;
- idle tunnels are re-keyed within 150 s whichever side started them (keepalives plus the status
  job's ping);
- `hub-purge` and the gateway uninstall.

At the end it compares the main namespace with how it was before the run: links, addresses,
rules, routes, nft ruleset, `ip_forward`, namespaces, WireGuard interfaces and gnupg folders. The
test-only modes refuse to run in the main namespace: `CCTV_VPN_ROOT` for `cctv-vpn`, and
`--no-systemd` for `site-gateway.sh`.

## Changes to the original plan (and why)

- **Site ids are 2..250.** Site 1 would get the hub's own `10.77.0.1`.
- **On WSL, `wg0` needs a port claim, and should listen on 41820.** After `wg0` comes up,
  `cctv-vpn` makes a userspace bind attempt on the port, so that WSL passes inbound UDP to kernel
  WireGuard. 51820 lies in Windows' dynamic port range, so on WSL the hub should listen on 41820
  with the public port kept at 51820. The fallback, if the outside test fails, is `wireguard-go`:
  a download, so it needs your OK. Native Ubuntu is not affected.
- **Sites reconnect at once after a hub restart.** The 15 s timer saves each site's last
  endpoint; `wg0`'s PostUp restores them and then switches on the hub's keepalive, which starts
  every handshake. (The keepalive is not in `wg0.conf`: set at interface-up with no endpoint
  known yet, WireGuard's first attempt would go nowhere and hold the handshake back for 5 s.)
- **Idle sessions are renewed in time.** Only the side that started a WireGuard session renews
  it, and only when it sends after 120 s; with keepalives at both ends only one end sends. So the
  hub also sends keepalives, and the status job pings a gateway whose handshake is 118 to 178 s
  old: the gap stays at 120 to 145 s instead of up to 190 s (beyond the app's 180 s limit).
- **Removed ids are never reused automatically.** Reuse needs `--id N --reuse-id`.
- **Routing, reject and MTU:** one route `10.78.0.0/16 dev wg0` (per-peer AllowedIPs still pick
  the site). Disallowed hub output is *rejected* (it fails at once). MTU is 1280 on the hub and
  on gateways: it fits every 4G path even when a site router stays at 1420.
- **Site LANs must be exactly one /24.** The hub design allowed /24 to /30, but the Linux gateway
  maps a whole /24.
- **The bundle is "format 1" as `site-gateway.sh` reads it.** It has `TUNNEL_IP`,
  `SITE_PUBLIC_KEY`, and separate `site.key` and `site.psk` files. The gateway scripts sit at the
  bundle's top level, because the gateway accepts only one folder level.
- **Hub DNS names must have an A record only**, and Linux gateways resolve IPv4 themselves.
- **A backup and restore pair**, and `hub-init` refuses to replace a lost hub key while sites
  exist.
- **New in `site-gateway.sh`:** `--key FILE`, `--no-wait`, exit code 5, IPv4 resolution of the
  hub name, and no routing between a box's other networks.
- **Names of only digits are refused.** They would be mistaken for site ids.
- **`hub-init` then re-run after an app update.** A new release does not update
  `/usr/local/sbin/cctv-vpn` by itself: re-run `hub-init`, which is idempotent.
