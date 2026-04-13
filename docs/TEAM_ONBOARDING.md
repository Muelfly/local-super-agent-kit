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
- OpenClaw CLI and local gateway/control runtime
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

For OpenClaw specifically, read a green status as gateway or control reachability unless the detail explicitly says the chat lane itself was validated.

## What Bootstrap Does

- applies the chosen hardware profile into `.env.local`
- when you use auto-detect bootstrap, writes the selected bundle and hardware snapshot to `.runtime/install-plan.json`
- when auto-detect selects a curated bundle, layers the recommended model candidates and LM Studio automation flags on top of the nearest base profile
- generates starter n8n workflow files
- starts the local control plane and checks its health
- tries the bundled `lms server start` flow first when the LM Studio CLI is available, then launches the desktop app if needed
- can resolve friendly LM Studio hints to real download keys, acquire the matching bundle through `lms get`, load the concrete local `modelKey` through `lms load`, and wait until the LM Studio API reports the chat model as live
- installs the repo `super-agent` LM Studio MCP entry into `~/.lmstudio/mcp.json`
- provisions the repo-managed OpenJarvis launcher when it is missing and starts the packaged runtime
- installs OpenClaw when it is missing and starts the packaged gateway runtime
- installs Hermes when it is missing and restores the Windows shim when needed
- runs the official non-interactive NemoClaw onboard flow against LM Studio's OpenAI-compatible endpoint and restores the repo-managed launcher when needed
- starts local n8n through Docker Compose
- provisions a repo-local n8n owner and public API key when the repo compose service is the active n8n instance
- imports the generated workflow bundle into local n8n as inactive review surfaces when dockerized n8n is available
- checks the packaged OpenJarvis, OpenClaw, Hermes, and NemoClaw runtimes plus the Chat SDK lane
- turns on the Chat SDK ingress skeleton in the profile presets so teammates can wire adapters without reshaping the runtime core

Fresh LM Studio installs on Windows can have the desktop app present while the local OpenAI-compatible server is still off. If that happens, `Doctor` now tries the bundled CLI path at `C:\Users\<you>\.lmstudio\bin\lms.exe server start` before it gives up.

The package no longer treats helper-lane startup and LM Studio model load as unrelated work. Bootstrap and `Start Super-Agent Lanes` now reconcile the LM Studio model bundle first, then start OpenJarvis, OpenClaw, Hermes, and NemoClaw after the target chat model is visible on `/v1/models`.

Helper lanes are no longer treated as one-model-only surfaces. The package keeps primary hints for first boot, but `OPENJARVIS_MODEL_CANDIDATES`, `OPENCLAW_MODEL_CANDIDATES`, `HERMES_MODEL_CANDIDATES`, and `NEMOCLAW_MODEL_CANDIDATES` inherit the LM Studio candidate set unless you narrow them explicitly.

`npm install` now writes the repo `super-agent` LM Studio MCP entry into `~/.lmstudio/mcp.json`, and `Doctor` refreshes it again as a safety net. That keeps the MCP bridge on the default first-run path.

NemoClaw still inherits upstream preflight checks for ports `8080` and `18789`. OpenShell can run on a different host gateway port, but NemoClaw's default onboard path still assumes the default OpenShell gateway port while the dashboard path remains centered on `18789` in the current upstream flow. If either port is unavailable on the Windows plus WSL stack, the package will surface that exact blocker instead of pretending the lane is healthy.

If port `8080` is the recurring blocker, the supported fallback is to manage OpenShell separately: start the gateway on another host port or on a remote host, then rerun `nemoclaw onboard` against that separately managed environment instead of relying on the default all-in-one onboard path.

The packaged UX should assume teammates talk to LM Studio Chat first. OpenJarvis, OpenClaw, Hermes, and NemoClaw belong behind that surface as built-in runtimes rather than as separate first-run consoles.

When the LM Studio MCP surface is active, the expected user experience is “I am using Super Agent,” not “I am using model X plus a few tools.” The MCP server now brands itself as `super-agent`, exposes branded tool names, and instructs LM Studio to treat the currently selected chat model as the reasoning shell rather than the product identity.

The current package shape is intentionally not read-only. Super Agent now exposes workspace list/read/write and shell execution through the local control plane by default. That means teammates can ask the packaged agent to inspect files, edit files, and run local commands without a separate in-package approval layer.

## OpenClaw Chat Lane Reality Check

The current packaged OpenClaw path can look healthier than it really is.

- repo bootstrap now provisions repo-local OpenClaw state under `.runtime/openclaw`
- that repo-local state binds a custom `lmstudio` provider to the loaded LM Studio chat model before the gateway is treated as ready
- doctor now fails when LM Studio has no chat model loaded or only embedding models loaded, because that still breaks the OpenClaw handoff in practice

The package no longer depends on user-home OpenClaw auth for the default LM Studio path.

- `.runtime/openclaw/openclaw.json` is now the package-local source of truth for the default OpenClaw LM Studio binding
- `OPENCLAW_MODEL` is now the package target that gets matched against the loaded LM Studio chat model id
- if doctor still fails, the first thing to inspect is usually LM Studio model load state, not `~/.openclaw/agents/main/agent/auth-profiles.json`

Hermes and NemoClaw follow the same package-managed direction now.

- Hermes writes its package-local config under `.runtime/hermes` instead of silently reusing an old user-home model binding
- the default NemoClaw package path now uses the `custom` provider against LM Studio rather than assuming a separate Ollama default

The repo-managed n8n auth state is written to `.runtime/n8n/auth.json`, which stays local and ignored by Git. That lets LM Studio Chat inspect workflows without sending teammates through manual owner setup and API-key creation in the n8n UI.

## External n8n Override

The repo-managed n8n lane now defaults to host port `5679`, so it can sit next to a separate default n8n on `5678` without colliding.

If you want the package to target some other existing n8n instance instead of the repo-managed one, set these in `.env.local`:

- `N8N_MANAGED_BY_REPO=false`
- `N8N_BASE_URL=<existing instance base URL>`
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

If LM Studio is already running when the MCP entry is installed or refreshed, restart LM Studio once so the Chat UI picks up the new tool bridge.

On Windows, `Start Super-Agent Lanes` expects WSL2 plus Docker Desktop so the default NemoClaw onboard command can complete.

`Start OpenJarvis` and `Start Super-Agent Lanes` both reconcile the LM Studio model bundle first, so they can recover a missing chat-model load instead of just reporting downstream binding failures.

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

The visible MCP tool surface inside LM Studio now centers on Super Agent naming:

- `super_agent_status`
- `super_agent_reason`
- `super_agent_delegate`
- `super_agent_openclaw_agent`
- `super_agent_hermes_agent`
- `super_agent_workspace_list`
- `super_agent_workspace_read`
- `super_agent_workspace_write`
- `super_agent_shell`
- `super_agent_fetch`
- `super_agent_notes`
- `super_agent_tool_generate`
- `super_agent_workflow_design`

## Generated Tool Loop

`tool.generate` now writes to `generated/tool-surface.generated.json`, regenerates `generated/n8n/*.workflow.json`, validates the artifacts, and tries to import the result into local n8n.

`n8n.workflow.design` now adds a higher-level design pass on top of that loop. It writes a workflow draft to `.runtime/workflow-designs`, records suggested steps and open questions, and can optionally scaffold the generated workflow/tool artifacts before you decide whether to import them into n8n.

If you want runtime-native behavior instead of the thinner compatibility layer, use `super_agent_openclaw_agent` or `super_agent_hermes_agent`. Those wrappers call the packaged OpenClaw and Hermes runtimes directly, while the workspace and shell tools remain available through the control plane for explicit local action.

If you want an evaluation gate before promotion, set `OPENJARVIS_EVAL_COMMAND` locally. The command receives `AGENT_TOOL_NAME`, `AGENT_TOOL_SUMMARY`, `AGENT_WORKFLOW_FILE`, and `AGENT_GENERATED_SURFACE_FILE` in the environment.

## Using Copilot In This Repo

This repository now ships a repo-local Copilot guide at `.github/copilot-instructions.md`.

Use Copilot most effectively here by keeping asks bounded and operational:

- ask for one runtime slice at a time
- prefer "wire this lane" or "validate this profile" over broad redesign prompts
- keep ingress thin and local-first by default
- when you hit repeated friction, record it back into this onboarding doc so the next teammate does less archaeology

For the longer operator-facing version, see `docs/OPERATOR_PLAYBOOK.md`.
