# Operator Playbook

## Purpose

This repository is meant to behave like a small product starter, not a personal one-off machine snapshot.

That means the operator habits matter:

- keep the default path local-first
- keep optional lanes optional
- keep ingress thin
- keep the control-plane loop observable
- keep credentials local-only
- record repeated friction where the next teammate will actually read it

## First-Run Contract

The intended first-run contract is:

1. install Node.js
2. install LM Studio
3. optionally install Docker Desktop for n8n
4. run bootstrap for the right hardware profile
5. confirm doctor output

For teammate-facing packaging, also assume LM Studio opens in Korean and does not immediately push a bundled Gemma 4 download on first launch.

Anything beyond that should be treated as an optional lane unless you are deliberately expanding the product surface.

## What Is Core Versus Optional

Core:

- LM Studio local server
- LM Studio Chat as the default user-facing console
- local control plane
- n8n local automation surface
- VS Code tasks and local scripts
- generated tool-surface workflows

Optional:

- OpenJarvis local serve lane
- NemoClaw sandbox lane
- shared MCP
- platform-specific Chat SDK credentials
- NVIDIA cloud-backed paths

## Keep Ingress Thin

The Chat SDK skeleton is there to prove the ingress shape, not to become the new control plane.

Prefer this split:

- ingress handler receives event
- LM Studio Chat owns the human-facing conversation surface
- handler routes into local automation or agent runtime
- local control plane owns file writes, durable ledgers, tool generation, and promotion hooks
- n8n owns durable orchestration
- LM Studio owns default inference
- OpenJarvis and NemoClaw stay helper lanes

If a handler starts owning retries, waits, or durable branching logic, move that behavior into n8n instead.

## Using Copilot Here

The most effective pattern is bounded operational asks.

Good asks:

- wire one optional lane
- validate one profile
- add one adapter route
- tighten one onboarding step

Weak asks:

- redesign the whole system
- add every platform at once
- make every optional lane mandatory

If repeated friction appears, update one of these instead of letting it live only in chat:

- `docs/TEAM_ONBOARDING.md`
- `.github/copilot-instructions.md`
- this playbook

## Known Practical Gotchas

### LM Studio Reachability

If doctor says LM Studio is unreachable, the most common cause is that the desktop app path cannot be auto-resolved or the local server is not enabled. Set `LM_STUDIO_APP_PATH` locally if needed.

### Optional NemoClaw Setup

If `NEMOCLAW_SETUP_COMMAND` is blank, the starter will only report NemoClaw status. That is intentional so the first-run path stays light.

### LM Studio Chat First

The package should not ask teammates to choose among multiple assistant front ends on day one.

- LM Studio Chat is the primary front door
- OpenClaw, NemoClaw, OpenJarvis, and other helper dependencies should sit behind it through local runtime integration
- if a teammate wants the strongest local chat experience first, direct them to the Nemotron-3 Nano 30B profile before the 8B fallback

The repo-local MCP server is the current bridge for that integration. Install it with `npm run install:lmstudio-mcp`, or let bootstrap write `~/.lmstudio/mcp.json` automatically.

### Chat SDK State

The starter uses `@chat-adapter/state-memory` on purpose. Do not force Redis into the first-run path unless you are intentionally making the public starter heavier.

The companion file ledger under `.runtime/chat-sdk` is the intended middle ground: better restart resilience without making the starter depend on external state infra.

### Generated Tool Promotion

`tool.generate` now has a real local loop:

- candidate tool definition lands in `generated/tool-surface.generated.json`
- workflow JSON is regenerated under `generated/n8n`
- structural validation runs before promotion
- `OPENJARVIS_EVAL_COMMAND` can act as an operator-defined evaluation gate
- the resulting workflow is imported back into local n8n as an inactive review surface when the default docker path is available

If you need a non-docker promotion path, override `N8N_PROMOTE_COMMAND` locally.

### Hermes Migration Note

If this starter later needs a richer long-term-memory runtime, Hermes Claw is a reasonable migration candidate rather than a first-run dependency.

- the documented migration flow can bring over persona, user profile, long-term memory, daily memory files, skills, provider config, and MCP server config
- unsupported concepts are archived for manual review instead of being silently discarded
- use that as an upgrade path only when the team actually wants Hermes-level long-term memory and runtime complexity

### Secrets

Keep all real credentials local-only:

- Discord bot tokens
- GitHub app or webhook secrets
- NVIDIA keys
- shared MCP URLs with auth
- OpenJarvis API keys

The tracked files should remain templates and examples only.

## Public Sharing Checklist

Before sharing this repo with a wider audience, confirm:

1. `.env.local` is not committed
2. docs only mention template values, not live credentials
3. the README still describes one low-friction first run
4. optional lanes are still optional in scripts and wording
5. Chat SDK remains an ingress skeleton, not a hidden hard dependency
6. doctor output still makes sense on a clean machine
