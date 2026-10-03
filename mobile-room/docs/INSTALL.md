# Mobile-room installation guide

This guide assumes you already have [OpenRig](https://github.com/mvschwarz/openrig)
installed and a rig running. If not, follow the upstream
[getting-started guide](https://github.com/mvschwarz/openrig/blob/main/docs/reference/getting-started.md)
first.

## 1. Requirements

| Component | Requirement |
|---|---|
| Node.js | 22 or 24 (`node:sqlite` required) |
| OpenRig | daemon running, ≥1 rig with seats |
| Codex (for Codex seats) | Codex CLI installed and logged in, seats launched by OpenRig |
| Hermes (optional bridge) | Hermes Agent CLI on `PATH`, configured with a provider |
| Phone access (recommended) | Tailscale or another private network on both devices |

No `npm install` is needed for the room itself — the gateway uses Node built-ins only.

## 2. Configure

All settings are optional; defaults are safe (loopback-only). Two equivalent mechanisms:

- **Environment variables** — copy `mobile-room/.env.example` to `mobile-room/.env`,
  edit, and export before starting (`set -a; . ./.env; set +a`).
- **Config file** — copy `mobile-room/roomd.config.example.json` to
  `mobile-room/roomd.config.json` and edit. Environment variables win over the file.

Minimum useful configuration for phone access over a VPN interface:

```bash
export OPENRIG_HOST=127.0.0.1      # where the OpenRig daemon listens
export OPENRIG_PORT=31455
export OPENRIG_RIG=first-project   # your rig name
export ROOM_HOST=127.0.0.1         # local UI listener
export ROOM_PORT=8800
export ROOM_PRIVATE_HOST=<your-VPN-interface-IP>   # e.g. your tailscale0 address
export ROOM_PRIVATE_PORT=8800
```

Find your VPN interface IP with `ip -4 addr show tailscale0` (or your VPN's equivalent).
The gateway refuses to start the private listener until that address exists on the
machine, and retries until it does.

## 3. Run

```bash
node mobile-room/src/roomd.mjs
```

You should see:

```
[roomd] MCP listening on http://127.0.0.1:8810
[roomd] room (local) listening on http://127.0.0.1:8800
[roomd] room (private network) listening on http://<your-vpn-ip>:8800
[roomd] rig first-project id=<...>
```

Open `http://127.0.0.1:8800` locally. From your phone (on the same VPN), open
`http://<your-vpn-ip>:8800`.

### Optional: run as a systemd user service

```bash
mkdir -p ~/.config/systemd/user
cp mobile-room/systemd/openrig-room.service.example ~/.config/systemd/user/openrig-room.service
# edit the file: set your VPN interface name and private IP
systemctl --user daemon-reload
systemctl --user enable --now openrig-room.service
loginctl enable-linger "$USER"   # so it survives logout/reboot
```

## 4. Phone / PWA install

1. Open the room URL in your phone browser over the private network.
2. Browser menu → **Add to Home screen**. The app installs standalone (fullscreen,
   own icon) once served over **HTTPS**.
3. For HTTPS on a Tailscale network, run on the server:

   ```bash
   sudo tailscale set --operator=$USER        # once
   tailscale serve --bg --https=443 http://127.0.0.1:8800
   ```

   Then open `https://<your-machine>.<your-tailnet>.ts.net` — Tailscale provisions a
   Let's Encrypt certificate automatically. Adjust `tailscale serve` to your chosen
   `ROOM_PORT` if different.

## 5. Hermes bridge

The bridge shells out to `hermes` with a persistent named session:

```
hermes chat --query-file <tmp> --oneshot --continue <session-name> --create-if-missing \
  --in <HERMES_WORKDIR> -Q --format stream-json
```

Requirements:

- `hermes` on `PATH` (`which hermes`)
- Hermes configured (`hermes status`) with a working model provider
- One Hermes invocation runs at a time (the bridge serializes requests); replies post
  back to the room when the `result` JSON line arrives.

Configure the session name and workdir in `roomd.config.json` (`hermes.session`,
`hermes.workdir`) or leave defaults (`openrig-room`, unset → `$HOME`).

## 6. Codex seats

Codex seats are launched and managed by OpenRig itself (`rig up ...`). The room only:

- delivers messages to seats via `rig send <seat> <text>`
- reads seat replies via `rig transcript <seat> --json` (envelope-anchored extraction)

So any Codex/OpenRig seat works without extra setup. Seat names/avatars displayed in the
room are configured in `roomd.config.json` under `agents[]` — edit to match your rig.

## 7. MCP bridge (optional)

A loopback-only MCP server runs at `127.0.0.1:8810` (configurable) exposing:

| Tool | Effect |
|---|---|
| `room_read` | read the latest room messages |
| `room_send` | speak into the room (optionally addressed to an agent) |
| `agents_status` | list agents and their states |
| `task_delegate` | assign work to an agent and get a task id |

It speaks Streamable-HTTP-style JSON-RPC at `POST /mcp`. This is local infrastructure for
future controller-agent integrations. **No ChatGPT connection is included** — see the
Nexus note in the main README for why, and the current requirements
(ChatGPT Business/Enterprise/Edu developer-mode connectors, or an OpenAI
Secure MCP Tunnel with a compatible OpenAI product surface).

## 8. Known limitations

- Codex replies are captured from terminal transcripts; very long replies (>2000 chars)
  are tail-truncated; rapidly consecutive turns may coalesce into one posted reply.
- Hermes reply latency depends on your provider (seconds to a minute+); the status chip
  shows `working` while a reply is pending.
- The room transcript is stored per-rig by the OpenRig daemon (SQLite). Tearing down the
  rig does not delete it, but deleting OpenRig state does.
- `node:sqlite` is flagged experimental by Node; it is stable in practice for this
  workload but prints a startup warning.
- No authentication layer: the room assumes a trusted private network. Add your own
  reverse-proxy auth before ever widening access.
