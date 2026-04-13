# CGNAT-Bypass via VPS — Working Reference

Captured from the live POUGHKEEPSIE Unraid setup + crucifixgit.com VPS on 2026-04-13.
This is the template for the future FreeRAID "VPS Bypass" plugin.

**Goal:** expose a home server (behind carrier-grade NAT / no port forwarding) to
the public internet via a reverse tunnel to a cheap VPS. The VPS's public IP
becomes the server's apparent public IP for selected services (Plex).

```
Internet  →  VPS public IP :32400  →  WireGuard tunnel  →  Home Plex :32400
```

---

## Topology

| | Home (POUGHKEEPSIE)          | VPS (crucifixgit.com) |
|---|---|---|
| WAN IP | behind CGNAT, 172.59.75.208 observed (T-Mobile) | 212.28.181.47 (static) |
| Tunnel IP | 10.13.13.10 | 10.13.13.1 |
| WireGuard endpoint | outbound → crucifixgit.com:51820 | listens on UDP 51820 |
| MTU | 1280 (both ends; TCP MSS clamped to 1240) |  |

Only the home side initiates the handshake (CGNAT-friendly); `PersistentKeepalive=25`
keeps the NAT mapping hot.

---

## Home side (Unraid)

### 1. WireGuard client config
`/boot/config/wg2-bypass.conf` → copied to `/etc/wireguard/wg2.conf` at boot.

```ini
[Interface]
PrivateKey = <home_private_key>
Address    = 10.13.13.10/24
MTU        = 1280
Table      = off                 # critical: do NOT install default route
PostUp     = /bin/bash /boot/config/wg2-bypass-postup.sh

[Peer]
PublicKey          = <vps_public_key>
PresharedKey       = <psk>
Endpoint           = crucifixgit.com:51820
AllowedIPs         = 0.0.0.0/0   # with Table=off, this is ignored for routing
PersistentKeepalive = 25
```

`Table = off` is the linchpin — it prevents wg-quick from yanking the default
gateway and routing ALL home traffic through the VPS. We only route *specific*
destinations through the tunnel (the PostUp script below).

### 2. Selective routing (`wg2-bypass-postup.sh`)

Routes only plex.tv control-plane hosts via the tunnel, so plex.tv sees the
server as originating from the VPS public IP (enabling remote access), while
regular traffic still exits via the home ISP.

```bash
#!/bin/bash
# Always-needed: tunnel subnet route
ip route replace 10.13.13.0/24 dev wg2

# Route plex.tv hosts via the tunnel so plex.tv sees us from the VPS public IP
for h in plex.tv my.plex.tv pubsub.plex.tv clients.plex.tv tracking.plex.tv \
         events.plex.tv meta.plex.tv metadata.provider.plex.tv \
         vod.provider.plex.tv www.plex.tv api.plex.tv community.plex.tv; do
  for ip in $(getent ahostsv4 "$h" | awk '{print $1}' | sort -u); do
    ip route replace "${ip}/32" via 10.13.13.1 dev wg2
  done
done
```

### 3. Watchdog (`wg2-bypass-watchdog.sh`)

Cron every 2 min. Re-ups the interface if it's missing or if the handshake is
older than 5 minutes (CGNAT mappings sometimes drop silently).

```bash
#!/bin/bash
if ! ip link show wg2 >/dev/null 2>&1; then
  wg-quick up wg2; exit 0
fi
hs=$(wg show wg2 latest-handshakes | awk '{print $2}')
now=$(date +%s)
[ -z "$hs" ] || [ "$hs" -eq 0 ] && exit 0
age=$((now - hs))
if [ $age -gt 300 ]; then
  wg-quick down wg2 || true
  sleep 1
  wg-quick up wg2
fi
```

### 4. Boot wiring (`/boot/config/go`)

Unraid's `go` script runs as rc.local. Three blocks:

```bash
# Copy client config onto the rootfs and bring it up
if [ -f /boot/config/wg2-bypass.conf ]; then
  cp /boot/config/wg2-bypass.conf /etc/wireguard/wg2.conf
  chmod 600 /etc/wireguard/wg2.conf
  /usr/bin/wg-quick up wg2 2>&1 | logger -t wg2-bypass
fi

# Install watchdog cron idempotently
if [ -f /boot/config/wg2-bypass-watchdog.sh ]; then
  ( crontab -l 2>/dev/null | grep -v wg2-bypass ;
    echo "*/2 * * * * /bin/bash /boot/config/wg2-bypass-watchdog.sh" ) | crontab -
fi
```

### 5. Plex preferences (relevant subset)

File: `/mnt/user/appdata/plex/Plex Media Server/Preferences.xml`

```xml
customConnections="http://crucifixgit.com:32400"
ManualPortMappingMode="1"
ManualPortMappingPort="32400"
```

`customConnections` is the key: Plex advertises this URL to plex.tv as a
reachable address for the server. plex.tv probes it through the VPS → tunnel →
home, sees it reachable, publishes it to clients. Without this, plex.tv only
sees the CGNAT-masked outbound IP which isn't reachable inbound.

---

## VPS side (Debian 13, crucifixgit.com)

Note: this VPS also runs nginx (:80, :443), OpenVPN AS (separate), Gitea, etc.
WireGuard bypass is an additional role alongside those.

### 1. WireGuard server config
`/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address    = 10.13.13.1/24
ListenPort = 51820
PrivateKey = <vps_private_key>
MTU        = 1280
PostUp     = /etc/wireguard/wg0-up.sh
PostDown   = /etc/wireguard/wg0-down.sh

[Peer]
# Unraid (POUGHKEEPSIE)
PublicKey          = <home_public_key>
PresharedKey       = <psk>
AllowedIPs         = 10.13.13.10/32
PersistentKeepalive = 25
```

Enabled as a systemd unit: `systemctl enable --now wg-quick@wg0`.

### 2. PostUp rules (`wg0-up.sh`)

All nftables. Two tables:

**MSS clamp** — prevents fragmentation across the tunnel:
```sh
nft delete table ip mss 2>/dev/null || true
nft add table ip mss
nft add chain ip mss forward '{ type filter hook forward priority -150 ; }'
nft add rule ip mss forward oifname wg0 tcp flags syn tcp option maxseg size set 1240
nft add rule ip mss forward iifname wg0 tcp flags syn tcp option maxseg size set 1240
```

**DNAT + SNAT** — rewrites inbound :32400 so it goes through the tunnel and
return traffic comes back the same way:
```sh
# DNAT: inbound eth0 :32400 → Unraid through tunnel
nft add rule ip nat PREROUTING iifname eth0 tcp dport 32400 dnat to 10.13.13.10:32400
nft add rule ip nat PREROUTING iifname eth0 udp dport 32400 dnat to 10.13.13.10:32400
# SNAT: make return packets come back via the tunnel (not routed out eth0)
nft add rule ip nat POSTROUTING ip daddr 10.13.13.10 tcp dport 32400 snat to 10.13.13.1
nft add rule ip nat POSTROUTING ip daddr 10.13.13.10 udp dport 32400 snat to 10.13.13.1
# General masquerade for anything else the home side sends out
nft add rule ip nat POSTROUTING ip saddr 10.13.13.0/24 oifname eth0 masquerade
```

### 3. Cleanup (`wg0-down.sh`)

Best-effort delete of the ruleset handles on shutdown so bring-up is
idempotent:
```sh
nft delete table ip mss 2>/dev/null || true
nft -a list table ip nat | awk '/dnat to 10.13.13.10|snat to 10.13.13.1/ \
    {for(i=1;i<=NF;i++) if($i=="handle") print $(i+1)}' | while read h; do
  nft delete rule ip nat PREROUTING  handle "$h" 2>/dev/null
  nft delete rule ip nat POSTROUTING handle "$h" 2>/dev/null
done
```

### 4. Sysctl

```
net.ipv4.ip_forward = 1
```

### 5. Firewall

UFW is installed but **inactive**. Raw nftables handles policy.
`FORWARD` chain default policy is `ACCEPT`.

---

## Plane summary

```
plex.tv probe
     │
     ▼
VPS eth0 :32400  (nft DNAT)
     │  dnat → 10.13.13.10:32400
     ▼
wg0 (10.13.13.1) ─── WireGuard UDP ───▶ home wg2 (10.13.13.10)
                                                │
                                                ▼
                                          Plex container :32400
                                                │
                                                ▼ (reply)
                                          back up the tunnel
                                                │
                                                ▼
VPS nft POSTROUTING snat → 10.13.13.1
     │
     ▼
eth0 ─── reply to plex.tv probe with VPS public IP as source
```

The SNAT is critical: without it, Plex's reply packet to plex.tv goes out via
the home ISP's default route and plex.tv drops the asymmetric return.

---

## Future FreeRAID plugin requirements

Minimum inputs from the user:
- VPS hostname + SSH credentials (one-shot for bootstrap)
- List of services to expose (Plex is first; generalize to "port + protocol + container")

Plugin automates:
1. **On VPS**: install WireGuard, generate keypair + preshared key, write
   `/etc/wireguard/wg0.conf`, write PostUp/PostDown nft scripts, enable
   `wg-quick@wg0`, enable `net.ipv4.ip_forward`.
2. **On FreeRAID**: write WireGuard client config with `Table=off`, generate
   per-service PostUp that routes the service's control-plane hosts (e.g.
   plex.tv) via the tunnel, install the watchdog cron, apply per-container
   "expose via VPS" config (for Plex: set `customConnections` + manual port
   map).
3. **Hands-off re-up** on either side if tunnel drops.

UI contract: one screen per service with checkboxes.
  - [x] Plex  → also sets customConnections + manual port map
  - [ ] qBittorrent (future — different: needs port forward + kill switch semantics)
  - [ ] Jellyfin
  - [ ] …

Per service, the plugin maintains:
- The nft DNAT rule on the VPS
- The route-through-tunnel list for that service's control plane (if applicable)
- The in-container config needed to advertise the VPS URL
