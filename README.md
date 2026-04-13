# Local Super-Agent Kit

LM Studio-first local super-agent starter for VS Code teams.

This repository is meant to give teammates a practical local runtime skeleton:

- LM Studio as the default local model surface
- LM Studio Chat as the primary human-facing cockpit
- OpenJarvis as the packaged local ops, telemetry, and evaluation runtime
- OpenClaw as a packaged gateway/runtime lane that ships with the super-agent path
- Hermes Agent as a packaged agent runtime that ships with the super-agent path
- NemoClaw as the packaged sandboxed runtime tail for the local chain
- hardware profiles for 4060 Ti 8B and 3060 Ti 30B targets
- local control plane for file-backed state, tool generation, and evaluation hooks
- self-hosted n8n as the deterministic automation surface
- Chat SDK ingress skeleton for Discord and GitHub style adapters
- a generated n8n tool-surface starter bundle
- VS Code tasks that teammates can run without rediscovering the stack

## Intended Shape

- core control plane: local scripts plus VS Code tasks
- control-plane runtime: local HTTP service for durable state and promotion hooks
- reasoning surface: LM Studio OpenAI-compatible endpoint
- primary operator UI: LM Studio Chat
- LM Studio integration layer: local MCP server launched from this repo
- packaged local chain: OpenJarvis plus the OpenClaw gateway, Hermes Agent runtime, and NemoClaw sandbox tail
- orchestration surface: local n8n
- optional extensions: shared MCP
- ingress skeleton: Chat SDK style multi-platform adapters under `src/chat-sdk/bot.ts`

## Public-Share Posture

This repository is intentionally shaped to be shareable beyond one internal machine.

- the default path is local-first and clone-friendly
- NVIDIA or cloud credentials are optional, not bootstrap prerequisites
- Chat SDK ingress is included, but kept thin and replaceable
- local automation belongs in n8n, not inside ingress handlers
- real adapter credentials stay in local env only and should never be committed

If you plan to share this repo widely, keep the first-run path as close as possible to:

1. `npm install`
2. `npm run bootstrap:auto`
3. `npm run doctor`

## Quick Start

1. Install Node.js 20 or later.
2. Install Docker Desktop. On Windows, enable WSL2 too; the packaged NemoClaw path uses the official WSL2 plus Docker Desktop flow.
3. Install Astral uv so the repo-managed OpenJarvis launcher can pull the packaged CLI.
4. Install LM Studio, keep the UI in Korean for packaged teammates, disable bundled auto-load prompts, and enable its local server.
5. Copy `.env.example` to `.env.local` or use one of the hardware profile tasks.
6. Run one of these:
   - `npm install`
   - `npm run bootstrap:auto`
   - `npm run bootstrap:4060ti`
   - `npm run bootstrap:3060ti`
7. Run `npm run doctor` to confirm LM Studio, OpenJarvis, OpenClaw, Hermes, NemoClaw, n8n, and the local control plane are reachable.
8. If any packaged chain runtime needs a manual retry after bootstrap, run `npm run start:super-agent-lanes`.

`bootstrap:auto` detects the local hardware, writes a recommended install plan to `.runtime/install-plan.json`, applies the matching env overrides into `.env.local`, and can acquire or load the recommended LM Studio model bundle through the bundled `lms` CLI.

## Hardware Profiles

- `4060ti-8b`: lighter local fallback profile for Nemotron Nano 8B.
- `3060ti-30b`: preferred chat-first profile when a teammate wants Nemotron-3 Nano 30B first in LM Studio Chat.

`bootstrap:auto` sits above these fixed profiles. It selects one curated bundle such as a balanced 4060 Ti 8GB path, a 4060 Ti 16GB hybrid path, or a 3060 Ti offload-first path, then layers the chosen model hints and candidate list on top of the closest base profile.

These profiles do not force one vendor runtime forever. They are launch defaults for teammates.

## LM Studio Chat First

The package target should feel like one local product, not a pile of separate consoles.

- LM Studio Chat should be the default day-to-day chat surface for teammates
- Nemotron-3 Nano 30B should be the documented first-choice chat model when the hardware profile supports it
- Nemotron Nano 8B should stay available as the lighter fallback profile
- OpenJarvis, OpenClaw, Hermes, and NemoClaw should ship with the package and sit behind LM Studio Chat through local server, gateway, MCP, or tool-calling integration instead of becoming separate first-run chat UIs
- shared MCP can stay optional around that packaged core

The repo now ships a local LM Studio MCP server so LM Studio Chat can directly call:

- `stack_status` for lane readiness
- `n8n_status`, `n8n_workflows`, and `n8n_executions` for hidden workflow visibility
- `openjarvis_chat` for helper-lane reasoning
- `openclaw_chat` when the OpenClaw gateway and chat surface are both ready
- `nemoclaw_status` for sandbox/runtime lane visibility
- `web_fetch`, `notes_capture`, and `tool_generate` through the local control plane

## NVIDIA Key Friction

The basic LM Studio-first path does not require an NVIDIA key.

`NVIDIA_API_KEY` should only matter if a teammate decides to:

- switch NemoClaw away from its default local onboarding path and toward NVIDIA cloud or NIM surfaces
- switch part of the runtime away from local LM Studio execution

That keeps the default onboarding path local-first and team-friendly.

## VS Code Tasks

The repository ships tasks for:

- auto-detect bootstrap based on local hardware
- bootstrap on the 4060 Ti 8B profile
- bootstrap on the 3060 Ti 30B profile
- doctor
- control-plane startup
- packaged runtime startup for OpenJarvis, OpenClaw, Hermes, NemoClaw, and Chat SDK checks
- Chat SDK ingress summary
- n8n tool-surface generation
- local n8n startup

## Chat SDK Ingress Skeleton

The starter now ships a thin Chat SDK ingress skeleton in `src/chat-sdk/bot.ts`.

- it uses `chat` plus the official Discord and GitHub adapters
- it keeps hot adapter state in `@chat-adapter/state-memory` so teammates do not need Redis on day one
- it also writes a durable thread ledger under `.runtime/chat-sdk` so restarts do not erase all thread context
- it is intentionally thin: the ingress should stay replaceable while LM Studio, n8n, and the packaged local chain remain the runtime core

Use `npm run chat-sdk:summary` to see which adapters are currently configured and where to mount the webhook handlers in your own framework.

## Packaged Chain

The starter now treats OpenJarvis, OpenClaw, Hermes, and NemoClaw as one packaged local chain behind LM Studio Chat.

- `npm run start:openjarvis` provisions the repo-managed OpenJarvis launcher when needed, starts the packaged runtime, and re-checks the local API
- `npm run start:super-agent-lanes` ensures OpenJarvis, OpenClaw, Hermes, and NemoClaw are present, then prints Chat SDK readiness too
- `npm run start:optional-lanes` remains as a backward-compatible alias for the same command surface
- bootstrap already includes these checks, but the dedicated command is easier for teammates to rerun after they fix one chain stage

On Windows, the default NemoClaw path expects WSL2 plus Docker Desktop and uses the official non-interactive onboard flow with a local Ollama provider. LM Studio remains the front door either way.

OpenClaw is still the sharpest edge in the packaged chain, but bootstrap now manages that edge inside the repo instead of leaning on user-home global state. The package provisions repo-local OpenClaw state under `.runtime/openclaw`, binds a custom `lmstudio` provider to the loaded LM Studio chat model, and fails fast when LM Studio only exposes embeddings or no chat-capable model at all. `OPENCLAW_MODEL` now acts as the package target for matching the loaded LM Studio model rather than as a cosmetic hint.

These runtimes should attach behind LM Studio Chat in the packaged experience rather than forcing teammates to operate multiple chat fronts.

Use `npm run install:lmstudio-mcp` to write the repo MCP entry into `~/.lmstudio/mcp.json`. Bootstrap now does this automatically for the teammate path.

## Generated n8n Surface

`npm run n8n:surface` reads `config/tools/default-surface.json` and writes starter workflows to `generated/n8n`.

The built-in starter tools now route through the local control plane:

- `web.fetch` performs a deterministic fetch and stores a runtime record
- `notes.capture` writes a durable note capture record
- `tool.generate` writes or updates `generated/tool-surface.generated.json`, regenerates workflows, validates artifacts, runs an optional OpenJarvis evaluation hook, and attempts an n8n import

New generated tools start as generic handoff branches. They are immediately callable and record invocations, but you should replace them with dedicated control-plane handlers or richer n8n branches once they stabilize.

Bootstrap now imports the generated workflow bundle into n8n as inactive review surfaces when the local dockerized n8n lane is available.

When the repo-managed compose service owns the n8n port, bootstrap also provisions the initial owner and a local public API key under `.runtime/n8n/auth.json` so LM Studio Chat can inspect workflows without sending teammates through the n8n UI first.

The repo-managed n8n lane now defaults to host port `5679` so it can coexist with a separate default n8n on `5678`.

If you want the package to target some other existing n8n instance instead, set `N8N_MANAGED_BY_REPO=false`, `N8N_BASE_URL=...`, and `N8N_API_KEY=...` in `.env.local`.

## Hermes Memory Note

Hermes is now part of the packaged super-agent runtime, and its claw migration surface remains useful if this starter outgrows the current local control-plane plus file-ledger approach.

- the documented `hermes claw migrate` flow can carry persona, user profile, long-term memory, daily memory files, skills, MCP server config, and provider settings forward
- unsupported OpenClaw concepts are archived for manual review rather than silently dropped
- that makes Hermes a reasonable built-in bridge toward richer long-term memory instead of an afterthought add-on

## Suggested Next Steps

- point Chat SDK handlers at the same hot-state and automation surfaces
- replace platform-specific ingress adapters over time
- keep shared MCP optional unless the team has a concrete extension need
- keep recurring teammate friction documented in `docs/TEAM_ONBOARDING.md` and `.github/copilot-instructions.md`
- keep operator habits and product-share boundaries documented in `docs/OPERATOR_PLAYBOOK.md`
