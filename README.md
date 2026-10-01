# devin-local-bridge

An MCP server that exposes your Mac's **local** Devin CLI/Desktop sessions to a Devin Cloud session — the same sessions the official Devin iOS app shows. A Cloud session can read transcripts, send messages, and answer pending permission prompts and questions on your machine.

> Status: **alpha**.

## Architecture

```
Devin Cloud session
        │  MCP (Streamable HTTP, Bearer auth)
        ▼
┌───────────────────────┐     ┌──────────────────────┐
│   tunnel (your pick)  │────▶│ devin-local-bridge   │
│  quick / cloudflare / │     │  Bun, 127.0.0.1:8787 │
│  tailscale / none     │     │  7 mac_* tools       │
└───────────────────────┘     └─────────┬────────────┘
                                        │ ACP (JSON-RPC over stdio)
                                        ▼
                              ┌──────────────────────┐
                              │   devin acp          │
                              │  spawns per read,    │
                              │  one owner per turn  │
                              └──────────────────────┘
```

Reads spawn a short-lived `devin acp` process that replays history and exits. `mac_send_message` spawns one owner process per session that lives for the duration of the turn and proxies `session/request_permission` / `elicitation/create` back as MCP tools.

## Quick start

```sh
bun install
bun link          # puts `dlb` on your PATH
dlb setup         # workspaces, port, tunnel provider
dlb start         # prints your public MCP URL + Authorization header
dlb status        # health check
dlb doctor        # devin binary, credentials, ACP round-trip, tunnel
dlb stop
```

Config lives in `~/.local/share/devin-local-bridge/` (`config.toml`, `token`, pid files, `logs/`, `audit.jsonl`, `state.json`).

## Devin Cloud setup

1. `dlb start` — copy the printed URL and header.
2. Devin Cloud → **Customize → MCPs → Add custom MCP → HTTP**.
3. URL: `https://<your-tunnel>/mcp`; Auth header: `Authorization: Bearer <token>`; **Test tools**.

## Suggested Cloud session prompt

> You are the control panel for my Mac. Use the mac_* tools. Always call mac_list_sessions before stating any session state; never invent results. Show sessions numbered with title, state and last activity. Ask me for confirmation before approving any permission. If the Mac is offline, say so. Start by telling me what is running on my Mac.

PT-BR:

> Você é o painel de controle do meu Mac. Use as tools mac_*. Sempre chame mac_list_sessions antes de afirmar o estado de qualquer sessão; nunca invente resultados. Mostre as sessões numeradas com título, estado e última atividade. Peça minha confirmação antes de aprovar qualquer permissão. Se o Mac estiver offline, diga isso. Comece me contando o que está rodando no meu Mac.

## Tunnel providers

| Provider | TLS termination | Notes |
|---|---|---|
| `quick` (default) | Cloudflare edge | Zero setup (`cloudflared` only). **Cloudflare can read traffic.** Random URL changes on restart. |
| `cloudflare` | Cloudflare edge | Named tunnel, stable hostname. Requires `cloudflared tunnel login`. **Cloudflare can read traffic.** |
| `tailscale` | **Your Mac** | `tailscale funnel --bg` — TLS ends on your machine. Requires tailnet ACL with Funnel enabled; only serves ports 443/8443/10000. Untested locally (tailscale not installed on the dev machine) — verify syntax with `tailscale funnel --help`. |
| `none` | — | BYO reverse proxy / local-only. Set `tunnel.public_url` for `dlb url` output. |

## Security model

- Bearer token auth (constant-time compare), 60 req/min per token, `127.0.0.1` bind only.
- Sessions are only visible if their `cwd` is inside `BRIDGE_WORKSPACES`; real session ids and paths are never exposed — tools use opaque `s_…`/`w_…` handles.
- No shell tool, no arbitrary paths, no session creation.
- Permission requests never expose `allow_always` — only reject / allow once / allow-session.
- Unanswered turns are cancelled after `BRIDGE_TURN_TTL_MIN` (default 30) so the Desktop app can reclaim the session lock.
- Every mutating call is appended to `audit.jsonl` (message bodies truncated to 200 chars).

## Known limits

- `session/list` returns at most the 50 most recent sessions (devin CLI cap).
- Sessions open in Devin Desktop/CLI are read-only through the bridge — the transcript is served from the replayed history, but `mac_send_message` returns `locked_by_other_client`.
- The Mac must stay awake for the bridge to answer.
- Each Cloud query consumes ACUs.
- Turn timeouts default to 30 minutes (`turn_ttl_min` in config.toml).

## Dev

```sh
bun test             # unit + integration tests (fake ACP agent)
bun run typecheck    # tsc --noEmit, strict
```
