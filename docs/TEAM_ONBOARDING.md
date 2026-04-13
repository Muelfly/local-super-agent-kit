# Team Onboarding

## What Teammates Need

Required for the default local path:

- Node.js 20 or later
- LM Studio with local server enabled
- Docker Desktop if local n8n is desired

Packaged teammate-facing builds should also preseed LM Studio with Korean UI and no bundled Gemma auto-load prompt.

Optional:

- OpenJarvis CLI and local serve setup
- NemoClaw runtime
- NVIDIA key for cloud-backed NemoClaw or NIM scenarios
- Chat SDK adapter credentials for Discord or GitHub ingress

## Recommended First Run

1. Clone the repository.
2. Run `npm install`.
3. In VS Code, run either:
   - `Bootstrap: 3060 Ti 30B` if the teammate wants Nemotron-3 Nano 30B first in LM Studio Chat
   - `Bootstrap: 4060 Ti 8B` for the lighter fallback path
4. Confirm `Doctor` shows LM Studio and n8n as reachable.
5. Confirm the control plane is reachable too. `Doctor` now checks it explicitly.
6. If you use optional helper lanes, run `Start Optional Lanes` after you fill the related env values.

## What Bootstrap Does

- applies the chosen hardware profile into `.env.local`
- generates starter n8n workflow files
- starts the local control plane and checks its health
- tries the bundled `lms server start` flow first when the LM Studio CLI is available, then launches the desktop app if needed
- installs the repo LM Studio MCP entry into `~/.lmstudio/mcp.json`
- starts local n8n through Docker Compose
- provisions a repo-local n8n owner and public API key when the repo compose service is the active n8n instance
- imports the generated workflow bundle into local n8n as inactive review surfaces when dockerized n8n is available
- checks the optional OpenJarvis and NemoClaw lanes
- turns on the Chat SDK ingress skeleton in the profile presets so teammates can wire adapters without reshaping the runtime core

Fresh LM Studio installs on Windows can have the desktop app present while the local OpenAI-compatible server is still off. If that happens, `Doctor` now tries the bundled CLI path at `C:\Users\<you>\.lmstudio\bin\lms.exe server start` before it gives up.

The packaged UX should assume teammates talk to LM Studio Chat first. OpenJarvis, NemoClaw, OpenClaw, and other helper dependencies belong behind that surface rather than as separate required consoles.

The repo-managed n8n auth state is written to `.runtime/n8n/auth.json`, which stays local and ignored by Git. That lets LM Studio Chat inspect workflows without sending teammates through manual owner setup and API-key creation in the n8n UI.

## External n8n Override

If another n8n instance is already bound to port `5678`, the package should not try to claim it as the repo-managed service.

Set these in `.env.local` when you intentionally want to point at that external instance:

- `N8N_MANAGED_BY_REPO=false`
- `N8N_API_KEY=<existing public API key>`

Without that override, the package assumes the repo Docker Compose service is the source of truth for hidden automation.

## Optional Lane Commands

These are the repeatable commands teammates should keep handy:

- `npm run start:control-plane`
- `npm run install:lmstudio-mcp`
- `npm run start:openjarvis`
- `npm run start:optional-lanes`
- `npm run chat-sdk:summary`

If `NEMOCLAW_SETUP_COMMAND` is blank, the optional lane command will only report NemoClaw status. That is intentional: the default path stays local-first and low-friction.

If LM Studio is already running when the MCP entry is installed, restart LM Studio once so the Chat UI picks up the new tool bridge.

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
- keep OpenJarvis and NemoClaw optional instead of making them the onboarding gate

## LM Studio Chat First

- LM Studio Chat is the default user-facing entrypoint
- Nemotron-3 Nano 30B is the preferred first chat model when the 30B profile is practical
- Nemotron Nano 8B remains the lighter fallback
- helper lanes such as OpenClaw, NemoClaw, OpenJarvis, and shared MCP should attach behind LM Studio Chat

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
