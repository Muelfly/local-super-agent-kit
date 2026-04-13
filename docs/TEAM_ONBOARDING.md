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
5. If you use optional helper lanes, run `Start Optional Lanes` after you fill the related env values.

## What Bootstrap Does

- applies the chosen hardware profile into `.env.local`
- generates starter n8n workflow files
- launches LM Studio if the app path can be resolved locally
- starts local n8n through Docker Compose
- checks the optional OpenJarvis and NemoClaw lanes
- turns on the Chat SDK ingress skeleton in the profile presets so teammates can wire adapters without reshaping the runtime core

## Optional Lane Commands

These are the repeatable commands teammates should keep handy:

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
- route durable automation into n8n
- keep LM Studio as the default inference lane
- keep OpenJarvis and NemoClaw optional instead of making them the onboarding gate

## Using Copilot In This Repo

This repository now ships a repo-local Copilot guide at `.github/copilot-instructions.md`.

Use Copilot most effectively here by keeping asks bounded and operational:

- ask for one runtime slice at a time
- prefer "wire this lane" or "validate this profile" over broad redesign prompts
- keep ingress thin and local-first by default
- when you hit repeated friction, record it back into this onboarding doc so the next teammate does less archaeology

For the longer operator-facing version, see `docs/OPERATOR_PLAYBOOK.md`.
