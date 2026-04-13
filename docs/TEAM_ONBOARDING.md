# Team Onboarding

## What Teammates Need

Required for the default local path:

- Node.js 20 or later
- LM Studio with local server enabled
- Docker Desktop if local n8n is desired

Optional:

- OpenJarvis CLI and local serve setup
- NemoClaw runtime
- NVIDIA key for cloud-backed NemoClaw or NIM scenarios
- Chat SDK adapter credentials for Discord or GitHub ingress

## Recommended First Run

1. Clone the repository.
2. Run `npm install`.
3. In VS Code, run either:
   - `Bootstrap: 4060 Ti 8B`
   - `Bootstrap: 3060 Ti 30B`
4. Confirm `Doctor` shows LM Studio and n8n as reachable.
5. Confirm the control plane is reachable too. `Doctor` now checks it explicitly.
6. If you use optional helper lanes, run `Start Optional Lanes` after you fill the related env values.

## What Bootstrap Does

- applies the chosen hardware profile into `.env.local`
- generates starter n8n workflow files
- starts the local control plane and checks its health
- tries the bundled `lms server start` flow first when the LM Studio CLI is available, then launches the desktop app if needed
- starts local n8n through Docker Compose
- imports the generated workflow bundle into local n8n as inactive review surfaces when dockerized n8n is available
- checks the optional OpenJarvis and NemoClaw lanes
- turns on the Chat SDK ingress skeleton in the profile presets so teammates can wire adapters without reshaping the runtime core

Fresh LM Studio installs on Windows can have the desktop app present while the local OpenAI-compatible server is still off. If that happens, `Doctor` now tries the bundled CLI path at `C:\Users\<you>\.lmstudio\bin\lms.exe server start` before it gives up.

## Optional Lane Commands

These are the repeatable commands teammates should keep handy:

- `npm run start:control-plane`
- `npm run start:openjarvis`
- `npm run start:optional-lanes`
- `npm run chat-sdk:summary`

If `NEMOCLAW_SETUP_COMMAND` is blank, the optional lane command will only report NemoClaw status. That is intentional: the default path stays local-first and low-friction.

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
