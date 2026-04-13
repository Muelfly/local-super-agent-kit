# Local Super-Agent Kit Copilot Instructions

## Purpose

This repository is a teammate-facing local-first starter. Keep the default path low-friction.

## Working Stance

- LM Studio is the default model runtime.
- n8n is the deterministic automation layer.
- OpenJarvis and NemoClaw are optional helper lanes.
- Chat SDK ingress should stay thin and replaceable.
- NVIDIA keys and cloud surfaces must stay optional on the first-run path.

## Implementation Rules

- Prefer extending existing scripts and docs over adding new layers.
- Keep Discord, GitHub, or any other ingress adapter out of the semantic core.
- Route durable automation and retries into n8n instead of embedding them in ingress handlers.
- Do not make OpenJarvis or NemoClaw mandatory for bootstrap unless the user asks for that tradeoff.
- When you discover repeated setup friction, update docs/TEAM_ONBOARDING.md instead of leaving the lesson only in chat.

## Validation Rules

- Run npm run typecheck after code edits.
- Use npm run doctor to validate the local runtime contract.
- If you change optional lane behavior, rerun npm run start:optional-lanes or the related focused command.