# Mobile OpenRig — mobile-room

A mobile-first control room for [OpenRig](https://github.com/mvschwarz/openrig): a shared
group-chat interface in your phone's browser (installable as a PWA) that fronts the OpenRig
daemon so a human never needs to learn `rig` CLI syntax to run an agent team.

> **This is a fork addition.** This repository is a fork of
> [OpenRig by mvschwarz](https://github.com/mvschwarz/openrig). OpenRig provides the
> underlying multi-agent coordination system (daemon, rigs, seats, chatroom, transcripts,
> snapshots). The `mobile-room/` layer in this fork is an independent addition built **on
> top of** OpenRig. The original OpenRig author did not create, maintain, endorse, or support
> the mobile-room additions. See the repository root README and
> [LICENSE](../LICENSE) (Apache-2.0).

## What it adds

- **Mobile-first web UI / PWA** — a group-chat room: speaker avatars, names, timestamps,
  message bubbles, composer with send button, auto-scroll, auto-reconnect (SSE), and a
  home-screen-installable manifest.
- **Shared room conversation** — messages from the human, every OpenRig seat in the rig,
  and bridged Hermes instances all appear in one transcript, persisted by the OpenRig
  daemon's chatroom API (survives gateway restarts).
- **Codex seats in the room** — messages addressed to a seat (or the whole room) are
  delivered with `rig send`; seat replies are captured from the seat transcript and posted
  back into the room under the seat's identity.
- **Hermes bridge** — [Hermes Agent](https://github.com/nousresearch-hermes/hermes-agent)
  appears as a persistent named participant. Each message resumes the same named session
  (`--continue <session> --create-if-missing`), so context carries across messages.
  Invocations are serialized to one at a time.
- **Agent status** — online / working / waiting / error / offline per seat, driven by the
  OpenRig daemon's node API, plus "unavailable" for integrations that are not connected.
- **Direct addressing** — tap the target pill (or `@name`) to address one agent or the
  whole room.
- **Loop protection** — message/task IDs, duplicate-send suppression, and a maximum
  automatic agent→agent handoff depth.
- **Optional local MCP bridge** — a loopback-only MCP server exposing room tools
  (`room_read`, `room_send`, `agents_status`, `task_delegate`) for controller agents.
- **Private-network access model** — designed for phone → Tailscale (or any private VPN)
  → room gateway → localhost OpenRig. No public exposure, ever.

## What it does NOT do (honest status)

- **Nexus / ChatGPT** — the MCP bridge infrastructure is included and works locally, but a
  real ChatGPT-side connection depends on OpenAI account/product support (developer-mode
  custom MCP connectors currently require ChatGPT Business/Enterprise/Edu; personal Plus
  accounts cannot attach them). Until a real connector exists, the UI shows
  **"Nexus — unavailable"** and messages addressed to Nexus are **not routed to any other
  model** — they are recorded with an explanatory note instead.

## Requirements

- Node.js 22+ (`node:sqlite` is experimental-flagged but built-in) — zero npm dependencies
- A working OpenRig installation (daemon running, at least one rig with seats)
- For Codex seats: Codex CLI, logged in
- For the Hermes bridge: Hermes Agent CLI on PATH
- For phone access: Tailscale (or another private network) — the room binds to
  interfaces you configure, not to `0.0.0.0`

## Quick start

```bash
# 1. Install OpenRig itself (upstream project) and boot a rig:
#    npm install -g @openrig/cli && rig up first-project
#    (see https://github.com/mvschwarz/openrig for OpenRig usage)

# 2. Configure the room (all optional — defaults are loopback-only):
cp mobile-room/roomd.config.example.json mobile-room/roomd.config.json
cp mobile-room/.env.example mobile-room/.env   # then edit

# 3. Start the gateway:
node mobile-room/src/roomd.mjs

# 4. Open http://127.0.0.1:8800 locally, or your private-network address.
```

Environment variables (see `.env.example` for the full list):

| Variable | Default | Meaning |
|---|---|---|
| `OPENRIG_HOST` / `OPENRIG_PORT` | `127.0.0.1` / `31455` | OpenRig daemon address |
| `OPENRIG_RIG` | `first-project` | which rig's seats join the room |
| `ROOM_HOST` / `ROOM_PORT` | `127.0.0.1` / `8800` | local listener for the UI |
| `ROOM_PRIVATE_HOST` / `ROOM_PRIVATE_PORT` | unset | optional private-network listener (e.g. your Tailscale interface IP) |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `8810` | loopback MCP bridge |
| `HERMES_WORKDIR` | unset | working directory for Hermes sessions |
| `ROOM_HUMAN_ID` / `ROOM_HUMAN_NAME` | `you` / `You` | how the human appears in the room |
| `ROOM_STATE_DB` | `mobile-room/.state/room-state.db` | runtime state location |

See [docs/INSTALL.md](docs/INSTALL.md) for the full setup guide (including the optional
systemd user service and Tailscale access) and [docs/SECURITY.md](docs/SECURITY.md) for
the intended security model.

## Layout

```
mobile-room/
  src/roomd.mjs          # the gateway (backend + SSE + bridges + MCP)
  public/                 # PWA: index.html, manifest, icons
  systemd/                # optional user-service template (example)
  docs/                   # INSTALL.md, SECURITY.md
  scripts/                # helper scripts
  tests/                  # smoke tests
  .env.example            # safe placeholder configuration
  roomd.config.example.json
```

## License

Apache-2.0 (inherited from upstream OpenRig). The mobile-room additions in this fork are
provided under the same license.
