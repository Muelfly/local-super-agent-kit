# Team Onboarding

## What Teammates Need

Required for the default local path:

- Node.js 20 or later
- Astral uv so the repo-managed OpenJarvis launcher can pull the packaged CLI
- LM Studio with local server enabled
- Docker Desktop
- WSL2 on Windows, because the packaged NemoClaw path uses the official WSL2 plus Docker Desktop flow

Packaged teammate-facing builds should also preseed LM Studio with Korean UI and no bundled Gemma auto-load prompt.

Optional:

- NVIDIA key for cloud-backed NemoClaw or NIM scenarios
- Chat SDK adapter credentials for Discord or GitHub ingress

Packaged by default:

- OpenJarvis runtime via the repo-managed launcher
- OpenClaw CLI and local gateway runtime
- Hermes Agent runtime
- NemoClaw sandbox/runtime tail

## Recommended First Run

1. Clone the repository.
2. Run `npm install`.
3. In VS Code, prefer:
   - `Bootstrap: Auto Detect` to let the package choose the install bundle and LM Studio model candidates from the local machine assets
4. Or run one of the fixed-profile tasks when you want to force a known tradeoff:
   - `Bootstrap: 3060 Ti 30B` if the teammate wants Nemotron-3 Nano 30B first in LM Studio Chat
   - `Bootstrap: 4060 Ti 8B` for the lighter fallback path
5. Confirm `Doctor` shows LM Studio, OpenJarvis, OpenClaw, Hermes, NemoClaw, and n8n as reachable.
6. Confirm the control plane is reachable too. `Doctor` now checks it explicitly.
7. If any packaged chain runtime needs a retry after bootstrap, run `Start Super-Agent Lanes`.

## What Bootstrap Does

- applies the chosen hardware profile into `.env.local`
- when you use auto-detect bootstrap, writes the selected bundle and hardware snapshot to `.runtime/install-plan.json`
- when auto-detect selects a curated bundle, layers the recommended model candidates and LM Studio automation flags on top of the nearest base profile
- generates starter n8n workflow files
- starts the local control plane and checks its health
- tries the bundled `lms server start` flow first when the LM Studio CLI is available, then launches the desktop app if needed
- can acquire and load the recommended LM Studio model bundle through `lms get` and `lms load`
- installs the repo LM Studio MCP entry into `~/.lmstudio/mcp.json`
- provisions the repo-managed OpenJarvis launcher when it is missing and starts the packaged runtime
- installs OpenClaw when it is missing and starts the packaged gateway runtime
- installs Hermes when it is missing and restores the Windows shim when needed
- runs the official non-interactive NemoClaw onboard flow and restores the repo-managed launcher when needed
- starts local n8n through Docker Compose
- provisions a repo-local n8n owner and public API key when the repo compose service is the active n8n instance
- imports the generated workflow bundle into local n8n as inactive review surfaces when dockerized n8n is available
- checks the packaged OpenJarvis, OpenClaw, Hermes, and NemoClaw runtimes plus the Chat SDK lane
- turns on the Chat SDK ingress skeleton in the profile presets so teammates can wire adapters without reshaping the runtime core

Fresh LM Studio installs on Windows can have the desktop app present while the local OpenAI-compatible server is still off. If that happens, `Doctor` now tries the bundled CLI path at `C:\Users\<you>\.lmstudio\bin\lms.exe server start` before it gives up.

The packaged UX should assume teammates talk to LM Studio Chat first. OpenJarvis, OpenClaw, Hermes, and NemoClaw belong behind that surface as built-in runtimes rather than as separate first-run consoles.

The repo-managed n8n auth state is written to `.runtime/n8n/auth.json`, which stays local and ignored by Git. That lets LM Studio Chat inspect workflows without sending teammates through manual owner setup and API-key creation in the n8n UI.

## External n8n Override

If another n8n instance is already bound to port `5678`, the package should not try to claim it as the repo-managed service.

Set these in `.env.local` when you intentionally want to point at that external instance:

- `N8N_MANAGED_BY_REPO=false`
- `N8N_API_KEY=<existing public API key>`

Without that override, the package assumes the repo Docker Compose service is the source of truth for hidden automation.

## Runtime Commands

These are the repeatable commands teammates should keep handy:

- `npm run bootstrap:auto`
- `npm run start:control-plane`
- `npm run install:lmstudio-mcp`
- `npm run start:openjarvis`
- `npm run start:super-agent-lanes`
- `npm run start:optional-lanes`
- `npm run chat-sdk:summary`

If `NEMOCLAW_SETUP_COMMAND` is blank, the runtime command will only report NemoClaw status. That is intentional: OpenClaw and Hermes are bundled by default, while NemoClaw stays secondary.

If LM Studio is already running when the MCP entry is installed, restart LM Studio once so the Chat UI picks up the new tool bridge.

On Windows, `Start Super-Agent Lanes` expects WSL2 plus Docker Desktop so the default NemoClaw onboard command can complete.

## NVIDIA Key Guidance

Do not make the NVIDIA key part of the required onboarding path.

Treat it as optional for teammates who later want:

- cloud-backed NemoClaw paths
- NVIDIA NIM evaluation lanes
- a non-LM-Studio runtime branch

The default skeleton should remain useful even without that key.

## Future Chat SDK Layer

This starter already includes a thin Chat SDK ingress skeleton. Keep it thin.

- use Chat SDK as the replaceable event ingress
- let the durable thread ledger live on disk under `.runtime/chat-sdk` instead of pushing Redis into the first-run path
- route durable automation into n8n
- keep LM Studio as the default inference lane
- keep shared MCP optional instead of making the ingress own the runtime chain

## LM Studio Chat First

- LM Studio Chat is the default user-facing entrypoint
- Nemotron-3 Nano 30B is the preferred first chat model when the 30B profile is practical
- Nemotron Nano 8B remains the lighter fallback
- OpenJarvis, OpenClaw, Hermes, and NemoClaw should ship with the package and attach behind LM Studio Chat
- shared MCP can remain secondary

## Generated Tool Loop

`tool.generate` now writes to `generated/tool-surface.generated.json`, regenerates `generated/n8n/*.workflow.json`, validates the artifacts, and tries to import the result into local n8n.

If you want an evaluation gate before promotion, set `OPENJARVIS_EVAL_COMMAND` locally. The command receives `AGENT_TOOL_NAME`, `AGENT_TOOL_SUMMARY`, `AGENT_WORKFLOW_FILE`, and `AGENT_GENERATED_SURFACE_FILE` in the environment.

## Using Copilot In This Repo

This repository now ships a repo-local Copilot guide at `.github/copilot-instructions.md`.

Use Copilot most effectively here by keeping asks bounded and operational:

- ask for one runtime slice at a time
- prefer "wire this lane" or "validate this profile" over broad redesign prompts
- keep ingress thin and local-first by default
- when you hit repeated friction, record it back into this onboarding doc so the next teammate does less archaeology

For the longer operator-facing version, see `docs/OPERATOR_PLAYBOOK.md`.
