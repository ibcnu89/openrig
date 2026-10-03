# Security model — mobile-room

## Intended architecture

```
Phone
  → private network (Tailscale / VPN)
    → mobile-room gateway  (binds: loopback + ONE private interface you choose)
      → OpenRig daemon     (binds: 127.0.0.1 ONLY)
        → agent seats (tmux)
```

Hard rules baked into the design:

1. **The OpenRig daemon never leaves loopback.** The gateway is the only component that
   talks to it (`OPENRIG_HOST`, default `127.0.0.1:31455`). Do not port-forward it, do
   not `tailscale serve` it, do not put it behind a public reverse proxy.
2. **The room gateway binds only what you configure.** Defaults: `127.0.0.1` only.
   The optional `ROOM_PRIVATE_HOST` listener binds exactly one private interface
   address — never `0.0.0.0`. If that interface is absent, the listener waits until it
   exists.
3. **The MCP bridge binds loopback only by default** (`MCP_HOST=127.0.0.1`). It is meant
   for a local controller agent or a local tunnel client — not for network clients.
4. **No secrets in the room.** The gateway stores no credentials. Provider auth lives in
   the Codex/Hermes/OpenRig installations, untouched by this layer.
5. **No public exposure path is provided.** There is no built-in auth; the security
   boundary is your private network. If you need broader access, put an authenticated
   reverse proxy in front and accept that you are stepping outside the tested model.

## Threat-model notes

- Anyone who can reach the room can send messages to your agent seats (and therefore ask
  the underlying agents to run tools). Treat the private network as the trust boundary and
  keep your tailnet device approvals strict.
- Room messages are stored in the OpenRig daemon's per-rig chatroom database on the same
  machine.
- The MCP tools are deliberately narrow (read room, send, status, delegate). They cannot
  create/destroy rigs, alter specs, or shell out.

## Verification checklist (what we tested on the reference deployment)

- OpenRig daemon socket: `127.0.0.1:PORT` only; probes to LAN IP and VPN IP refused.
- Room gateway: loopback + one VPN-interface listener; LAN probes refused.
- MCP bridge: loopback only; probes from VPN and LAN refused.
- No `0.0.0.0` binds introduced anywhere.
- Gateway runs as an unprivileged user; no root needed anywhere in this layer.

Reproduce on your machine:

```bash
ss -ltnp | grep -E '31455|8800|8810'
curl -s -o /dev/null -w '%{http_code}\n' http://<LAN-IP>:8800/    # expect refusal
curl -s -o /dev/null -w '%{http_code}\n' https://<vpn-host>/       # expect 200
```

## What this layer is NOT

- It is not an authentication system.
- It is not a multi-tenant server. One human, one machine, one private network.
- It is not audited by anyone except you. Review the single-file gateway
  (`src/roomd.mjs`) yourself before trusting it with your agent fleet — that is the point
  of keeping it small and dependency-free.
