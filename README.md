# devin-twin

Follow, get notified about, steer, and approve your **local** Devin CLI / Devin Desktop sessions from the official Devin iOS app — by giving each local session a lightweight Cloud "twin" that narrates what the local agent is doing and relays your replies back to it.

Repository: https://github.com/raffr85/devin-twin

> Status: **alpha**. Personal project, not affiliated with Cognition.

## Why this exists

The official Devin app only shows Cloud sessions. Sessions running in Devin CLI or Devin Desktop on your Mac are invisible to it — when you step away, you can't see what the agent is doing, and you can't approve a permission request until you're back at the keyboard.

Local sessions are also locked by the client that owns them: a second process can't write into a session the Desktop app is driving. But the agent's lifecycle hooks (UserPromptSubmit, PermissionRequest, Stop, SessionEnd) run *inside* the owning process and can approve requests, inject instructions, and hold a turn open — no matter which client owns the session.

The Devin v3 API can create tiny `lite`-mode Cloud sessions and attach MCP servers to them. Put those together: a local bridge watches your sessions through hooks and ACP, and a Cloud "twin" session — visible in the iOS app — narrates each local session and calls back into the bridge over authenticated MCP.

## What you get

| | |
|---|---|
| Twin card per session | A Cloud session titled `[<hostname>] <session title>` (tagged `mac:<host>`) appears in the app for every local session |
| Live narration | Milestones (turn started, tool calls, turn done, errors) are narrated by a lite-mode narrator with a fixed layout (the narrator, pushes and reply keywords are currently in Portuguese; see `src/twin/manager.ts`) |
| Push notifications | Optional ntfy pushes for every milestone; high priority on permission requests; tap opens the twin |
| Approve/deny | Permission requests show up on the twin; your reply is relayed to the local agent through the hook |
| Send instructions | Type an instruction in the twin chat; it's delivered into the live turn or queued |
| Absent mode | `twin remote on` holds every Stop hook open so queued instructions land within seconds |
| Continuation | Idle Desktop-locked sessions can be continued in a new bridge-owned session with their history summarized |
| Artifacts | Screenshots and logs the agent saves into `<state>/attach/<sessionId>/` (png/jpg/gif/webp/txt/log/md, ≤5 MB) are uploaded as attachments on the twin — e.g. an iOS Simulator screenshot lands on your phone; image pushes carry an ntfy `Attach` preview |

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              Devin Cloud                │
                    │  twin session (lite, playbook narrator) │
                    └───────┬─────────────────────▲───────────┘
                            │ MCP tools (mac_*)   │ v3 API: session create,
                            │ over HTTPS tunnel   │ messages, playbook
┌───────────────┐           ▼                     │
│  iOS app      │   ┌──────────────┐              │
│ (sees twin,   │   │    tunnel    │              │
│  talks to it) │   │ quick/cf/ts  │              │
└───────────────┘   └──────┬───────┘              │
                          │ HTTPS                │
                    ┌─────▼──────────────────────┴──────────┐
                    │           devin-twin bridge           │
                    │  :8787 /mcp + /healthz (tunneled)     │
                    │  :8788 /hook (localhost only)         │
                    └─▲───────────────┬──────────────┬──────┘
        hook events   │               │ ACP stdio    │ ntfy
  (SessionStart,      │               ▼              ▼
   UserPromptSubmit,  │      ┌──────────────┐  ┌──────────┐
   PermissionRequest, │      │  devin acp   │  │ ntfy.sh  │
   PostToolUse, Stop, │      │  (per turn,  │  │ (push)   │
   SessionEnd)        │      │  + reader)   │  └──────────┘
                      │      └──────────────┘
        ┌─────────────┴───────┐
        │  Devin CLI / Desktop │  ← same sessions the app can't see
        └─────────────────────┘
```

## How a round-trip works

1. You prompt a local session (CLI or Desktop).
2. The agent finishes its turn → the `Stop` hook fires into the bridge. With absent mode on, the bridge holds the turn open (the session still shows "working").
3. The bridge fires a `⟳` trigger into the twin and sends you an ntfy push: "turn finished · waiting for your instructions".
4. You open the twin in the app, read the narration, and reply with an instruction.
5. The twin calls `mac_send_message`; the bridge's held Stop hook returns it as `{"decision":"block","reason":…}`, so the local agent picks it up and keeps working.
6. The agent needs a permission → `PermissionRequest` hook holds → push + twin render → you answer "approve" → `mac_respond_permission` → the hook returns `{"decision":"approve"}` → the command runs.

## Quick start

Requirements: macOS, Devin CLI installed and logged in (`devin` works), Bun ≥ 1.3, and a Devin Cloud organization where you can add a custom MCP server (admin).

```sh
git clone https://github.com/raffr85/devin-twin && cd devin-twin
bun install && bun link        # exposes `twin` (and `dlb` as an alias)
twin setup                     # workspaces, port, tunnel provider, tokens
twin hooks install             # merges lifecycle hooks into ~/.config/devin/config.json
twin start                     # bridge + tunnel
twin url                       # prints the MCP URL + Authorization header
```

Then in Devin Cloud: **Customize → MCPs → Add custom MCP → HTTP** — paste the URL from `twin url`, and the `Authorization: Bearer …` header it prints. Run "Test tools" — you should see the `mac_*` tools.

Finally: `twin remote on` (absent mode), open a session in Desktop, and watch its twin appear in the app.

## Exposing the bridge (tunnels)

The bridge binds `127.0.0.1`; only `/mcp` and `/healthz` are reachable through the tunnel — hooks live on a separate localhost-only port (8788) that never touches the tunnel. You pick how the outside world reaches `/mcp`:

| Provider | TLS termination | URL stability | Notes |
|---|---|---|---|
| `quick` (default) | Cloudflare edge | changes every `twin start` | zero setup; Cloudflare can read traffic; **you must update the MCP URL in Devin Cloud after each start** |
| `cloudflare` | Cloudflare edge | stable hostname | needs a domain on Cloudflare + `cloudflared tunnel login` |
| `tailscale` | **your Mac** | stable `*.ts.net` | needs the Tailscale app + Funnel enabled in the tailnet ACL; makes your Mac a tailnet node |
| `none` | — | — | BYO reverse proxy; set `tunnel.public_url` for `twin url` output |

### quick

`twin setup --tunnel quick` — done. After every `twin start`/`restart`, run `twin url` and update the MCP URL in Devin Cloud. There is no API to update the URL remotely, so for daily use a stable hostname is strongly recommended.

### cloudflare (named tunnel)

```sh
cloudflared tunnel login
cloudflared tunnel create devin-twin        # note the tunnel name
# route a hostname: cloudflared tunnel route dns devin-twin twin.example.com
twin setup --tunnel cloudflare --name devin-twin --hostname twin.example.com
twin start
```

### tailscale (Funnel)

```sh
# install Tailscale, log in, then:
tailscale funnel --bg --https=443 http://127.0.0.1:8787
# if Funnel isn't enabled, the command prints an admin-console link — click it once
twin setup --tunnel tailscale
twin start
```

TLS terminates on your Mac and the URL (`https://<machine>.<tailnet>.ts.net`) is stable. Trade-off: your machine becomes a Tailscale node and Funnel exposes it to the internet.

### none

`twin setup --tunnel none --public-url https://your-proxy.example.com` — run your own reverse proxy in front of `127.0.0.1:8787`.

## Notifications (optional)

Push uses [ntfy](https://ntfy.sh) — a simple HTTP pub/sub service with a free hosted server and an iOS app. `twin setup` generates a random unguessable topic (`twin-<hex>`); `twin push info` prints it. In the ntfy app: "Subscribe to topic" → paste it. `twin push test` sends a test.

The topic is a secret — anyone who knows it can read your pushes (and they contain session titles and milestone headlines). To use your own server, set `[push] server` in `config.toml`; to disable pushes entirely, set `provider = "none"`. Every push carries a deep link to the twin session.

## Absent mode

`twin remote on` turns on absent mode:

- **Stop hold**: when a turn ends, the Stop hook holds the session open (Desktop shows "working") instead of letting it go idle. Instructions you send are injected within seconds. The hold re-arms under the hook's 2-hour timeout (max 48 re-arms per session) and has a hard cap (`--max-hold-min`, default 720). `twin remote off` releases all active holds immediately and reports how many.
- **Permission relay**: `PermissionRequest` holds up to ~9 minutes; if you don't answer, it falls through and the normal Desktop prompt appears. The bridge never auto-approves.
- **Honest delivery**: `mac_send_message` reports `acp_now` (bridge-owned session, sent immediately), `hook_live` (active turn or Stop hold — injected in seconds), or `queued_idle_locked` (idle + Desktop-locked — queued, with a suggestion to use `mac_continue_session`).
- **SessionEnd drain**: if a session ends with queued instructions, the bridge waits ~2s for the session lock to release, then sends them over ACP (`queue_drained_on_end` in the audit log).
- **Continuation**: `mac_continue_session` spawns a new bridge-owned session in the same cwd, seeded with a compact summary of the original's history plus your instruction. It narrates into the same twin; pushes get "(continuation)".
- **Artifacts**: with remote mode on, the SessionStart hook tells the agent about `~/.local/share/devin-twin/attach/<sessionId>/`. Files saved there (png/jpg/gif/webp/txt/log/md, ≤5 MB, ≤4 per scan) are uploaded as attachments on the next twin trigger; the watch runs on PostToolUse, on Stop, and every ~5s while a Stop hold is parked. Text artifacts are secret-redacted before upload; symlinks and path escapes are rejected.

Leave absent mode off when you're at the desk — held turns keep Desktop showing "working" and route permission prompts through your phone.

## The twin session

- One twin per local session, created lazily on the first milestone while remote mode is on; auto-archived on `session_end`.
- Runs `devin_mode: "lite"` with `max_acu_limit` (default 2). Milestones are coalesced (≥20s apart; permission requests go immediately). Measured cost across today's test turns: 0.0 ACU.
- Narration is driven by an org-level playbook, "Devin Twin · narrator" (created once, updated when the bundled text changes — see `src/twin/manager.ts`). Twin chats show only `⟳ <handle> · <title>` triggers plus the narrator's replies.
- Twins are tagged `mac:<hostname>` and titled `[<host>] <resolved title>`.

## Security model

- Bearer-token auth on `/mcp` (constant-time compare), 60 requests/minute/token, `127.0.0.1` bind.
- Only sessions whose `cwd` is inside your configured `workspaces` are visible; tools take opaque `s_…`/`w_…` handles — real session ids and paths never cross the wire. No shell tool, no arbitrary path access, no session creation except `mac_continue_session` inside an existing workspace.
- `allow_always` permission options are filtered down to session-scoped grants before they reach the twin.
- The hook endpoint lives on a separate localhost-only port with its own `hook_token` (0600), and rejects any request carrying tunnel headers (`cf-ray`, `cf-connecting-ip`, `x-forwarded-for`) — a tunneled request can't reach it even if DNS tricks send it to the right port.
- Event text (`user_prompt`, tool summaries, `last_assistant_message`) is redacted before storage: `api_key=…`, `Bearer …`, `sk-`/`ghp_`/`cog_`/`AKIA…`, and 32+-char hex strings become `«redacted»`.
- Queued instructions expire after `queue_ttl_min` (default 60); pending actions expire with the turn TTL; `mac_send_message` is rate-limited to 20/hour/session.
- Everything mutating is appended to `audit.jsonl`.
- **Phone-origin authority**: the twin agent is never treated as authoritative — approvals and instructions only take effect through authenticated `mac_*` tool calls, which are what the Cloud session issues when you type in its chat.
- **Threat model, plainly**: whoever holds the bearer token can steer your local agent and approve commands while absent mode is on. Rotate with `twin token rotate` (then update the MCP header in Cloud). The twin/Cognition sees session titles, tool summaries, last assistant messages, and pending permission text — keep that in mind for sensitive repos. Keep absent mode off when you don't need it.

## CLI reference

| Command | What it does |
|---|---|
| `twin setup` | Write `config.toml`, generate bearer + hook tokens (flags: `--workspaces --port --hook-port --tunnel --name --hostname --public-url`) |
| `twin start` / `stop` / `restart` | Manage bridge + tunnel processes (pidfiles in the state dir) |
| `twin status` | Bridge/tunnel health, remote mode, queue size, twin counts, last request/audit |
| `twin url` | Print the MCP URL + Authorization header for Devin Cloud |
| `twin token rotate` | Generate a new bearer token (update the Cloud MCP afterwards) |
| `twin logs [--tunnel] [--audit]` | Tail bridge / tunnel / audit logs |
| `twin doctor` | Check devin binary, credentials, config, token, ACP round-trip, tunnel provider |
| `twin hooks install` / `uninstall` / `status` | Merge (idempotent, with backup) or remove the lifecycle hooks in `~/.config/devin/config.json` |
| `twin remote on` / `off` / `status` | Absent mode; `--max-hold-min N` sets the hard cap (default 720) |
| `twin twin list` / `archive <id|all>` | List twins, archive them |
| `twin push info` / `test` | Print the ntfy topic / send a test push |

## Configuration

`~/.local/share/devin-twin/config.toml`:

```toml
port = 8787           # public MCP port (localhost; what the tunnel proxies to)
hook_port = 8788      # localhost-only hook port
queue_ttl_min = 60    # queued instructions expire after this
turn_ttl_min = 30     # owned turns are cancelled after this
workspaces = ["/abs/path"]  # only sessions with cwd under these are visible

[tunnel]
provider = "quick"    # quick | cloudflare | tailscale | none
# name/hostname/public_url depending on provider

[push]
provider = "ntfy"     # ntfy | none
server = "https://ntfy.sh"
topic = "twin-xxxxxx" # secret — generated by setup

[twin]
max_acu_limit = 2
archive_on_end = true
```

State dir (`~/.local/share/devin-twin`): `token`, `hook_token`, `config.toml`, `remote.json`, `state.json`, `queue.json`, `twins.json`, `events/*.jsonl`, `audit.jsonl`, `logs/`, pidfiles. Env vars: `TWIN_*` preferred, `DLB_*` accepted for compatibility (`TWIN_STATE_DIR`, `TWIN_DEVIN_CONFIG`, `TWIN_HOOK_PORT`, …). On first run, `~/.local/share/devin-local-bridge` is migrated automatically.

## Limits & known issues

- `session/list` is capped at ~50 sessions by the CLI.
- The quick tunnel URL changes on every start — update the MCP entry in Cloud each time, or use a stable provider.
- Desktop permission mode must be **Normal** for approvals to route through the bridge (Smart/Bypass auto-approve locally).
- Idle Desktop-locked sessions can't receive input directly — absent mode holds future turns, and `mac_continue_session` covers already-idle ones.
- Hook round-trip adds ~6ms per event; ACP reads take ~4s (subprocess spawn + replay).
- Mobile push goes through ntfy, not the Devin app — install it or accept in-app twin polling only.
- The narrator is a lite LLM — it can phrase things oddly; the underlying `mac_get_events` feed is always the source of truth.

## Credits

Built on Devin CLI's ACP mode (`devin acp`), the CLI lifecycle hooks, the `@agentclientprotocol/sdk` and `@modelcontextprotocol/sdk` packages, the Devin v3 API, and ntfy. MIT — Rafael Affonso.
