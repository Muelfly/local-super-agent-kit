# Local Super-Agent Kit

LM Studio-first local super-agent starter for VS Code teams.

This repository is meant to give teammates a practical local runtime skeleton:

- LM Studio as the default local model surface
- hardware profiles for 4060 Ti 8B and 3060 Ti 30B targets
- local control plane for file-backed state, tool generation, and evaluation hooks
- optional OpenJarvis lane for local ops, telemetry, and evaluation
- optional NemoClaw lane for sandboxed review and experimentation
- self-hosted n8n as the deterministic automation surface
- Chat SDK ingress skeleton for Discord and GitHub style adapters
- a generated n8n tool-surface starter bundle
- VS Code tasks that teammates can run without rediscovering the stack

## Intended Shape

- core control plane: local scripts plus VS Code tasks
- control-plane runtime: local HTTP service for durable state and promotion hooks
- reasoning surface: LM Studio OpenAI-compatible endpoint
- orchestration surface: local n8n
- optional accelerators: OpenJarvis, NemoClaw, shared MCP
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
2. `npm run bootstrap:4060ti` or `npm run bootstrap:3060ti`
3. `npm run doctor`

## Quick Start

1. Install Node.js 20 or later.
2. Install Docker Desktop if you want the local n8n surface.
3. Install LM Studio and enable its local server.
4. Copy `.env.example` to `.env.local` or use one of the hardware profile tasks.
5. Run one of these:
   - `npm install`
   - `npm run bootstrap:4060ti`
   - `npm run bootstrap:3060ti`
6. Run `npm run doctor` to confirm LM Studio, n8n, and the local control plane are reachable.
7. If you want the optional helper lanes, run `npm run start:optional-lanes`.

## Hardware Profiles

- `4060ti-8b`: default local profile for Nemotron Nano 8B.
- `3060ti-30b`: CPU-offload-friendly profile for Nemotron-3 Nano 30B.

These profiles do not force one vendor runtime forever. They are launch defaults for teammates.

## NVIDIA Key Friction

The basic LM Studio-first path does not require an NVIDIA key.

`NVIDIA_API_KEY` should only matter if a teammate decides to:

- use NemoClaw against NVIDIA cloud or NIM surfaces
- switch part of the runtime away from local LM Studio execution

That keeps the default onboarding path local-first and team-friendly.

## VS Code Tasks

The repository ships tasks for:

- bootstrap on the 4060 Ti 8B profile
- bootstrap on the 3060 Ti 30B profile
- doctor
- control-plane startup
- optional lane startup for OpenJarvis plus NemoClaw checks
- Chat SDK ingress summary
- n8n tool-surface generation
- local n8n startup

## Chat SDK Ingress Skeleton

The starter now ships a thin Chat SDK ingress skeleton in `src/chat-sdk/bot.ts`.

- it uses `chat` plus the official Discord and GitHub adapters
- it keeps hot adapter state in `@chat-adapter/state-memory` so teammates do not need Redis on day one
- it also writes a durable thread ledger under `.runtime/chat-sdk` so restarts do not erase all thread context
- it is intentionally thin: the ingress should stay replaceable while LM Studio, n8n, and optional helper lanes remain the runtime core

Use `npm run chat-sdk:summary` to see which adapters are currently configured and where to mount the webhook handlers in your own framework.

## Optional Helper Lanes

The starter keeps OpenJarvis and NemoClaw optional, but now bundles them more explicitly.

- `npm run start:openjarvis` tries the configured `OPENJARVIS_SERVE_COMMAND` and then re-checks the local API
- `npm run start:optional-lanes` ensures OpenJarvis, checks or bootstraps NemoClaw if `NEMOCLAW_SETUP_COMMAND` is set, and prints Chat SDK ingress readiness too
- bootstrap already includes these checks, but the dedicated commands are easier for teammates to rerun after they fix one optional lane

## Generated n8n Surface

`npm run n8n:surface` reads `config/tools/default-surface.json` and writes starter workflows to `generated/n8n`.

The built-in starter tools now route through the local control plane:

- `web.fetch` performs a deterministic fetch and stores a runtime record
- `notes.capture` writes a durable note capture record
- `tool.generate` writes or updates `generated/tool-surface.generated.json`, regenerates workflows, validates artifacts, runs an optional OpenJarvis evaluation hook, and attempts an n8n import

New generated tools start as generic handoff branches. They are immediately callable and record invocations, but you should replace them with dedicated control-plane handlers or richer n8n branches once they stabilize.

Bootstrap now imports the generated workflow bundle into n8n as inactive review surfaces when the local dockerized n8n lane is available.

## Long-Term Memory Note

Hermes Claw is a plausible future migration path if this starter outgrows the current local control-plane plus file-ledger approach.

- the documented `hermes claw migrate` flow can carry persona, user profile, long-term memory, daily memory files, skills, MCP server config, and provider settings forward
- unsupported OpenClaw concepts are archived for manual review rather than silently dropped
- that makes Hermes a reasonable upgrade path for richer long-term memory, but it is still optional and should not become the first-run dependency for this starter

## Suggested Next Steps

- point Chat SDK handlers at the same hot-state and automation surfaces
- replace platform-specific ingress adapters over time
- keep OpenJarvis, NemoClaw, and shared MCP optional rather than mandatory
- keep recurring teammate friction documented in `docs/TEAM_ONBOARDING.md` and `.github/copilot-instructions.md`
- keep operator habits and product-share boundaries documented in `docs/OPERATOR_PLAYBOOK.md`
