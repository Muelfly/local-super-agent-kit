# Architecture

## Purpose

This repository is a local super-agent starter, not a monolithic production control plane.

It is meant to give teammates a portable local stack with clear ownership boundaries:

- LM Studio: default local inference surface
- LM Studio Chat: primary human-facing cockpit
- local control plane: file-backed state, tool generation, evaluation, and promotion hooks
- n8n: deterministic waits, retries, schedules, and webhook glue
- OpenJarvis: optional local ops, telemetry, and evaluation lane
- NemoClaw: optional sandbox or review lane
- Chat SDK: included ingress skeleton, still replaceable
- shared MCP: optional upstream or team-shared extension, not mandatory core

## Ownership

- semantic owner: the teammate's durable notes and knowledge surface
- hot state: local runtime state, automation state, and ephemeral execution data, persisted locally under `.runtime`
- interactive surface: LM Studio Chat for day-to-day operator prompts
- ingress: replaceable adapter layer, not architectural owner
- execution: local model runtime plus optional helper tools

## Closed Loop

The starter now has a minimal closed loop for generated tool surfaces:

- n8n receives the webhook and stays the deterministic orchestration boundary
- the local control plane performs file writes, durable state updates, and external command hooks
- `tool.generate` updates the generated tool surface file, regenerates workflow JSON, validates the artifacts, optionally calls an OpenJarvis evaluation command, and attempts to import the result back into local n8n
- generated tools start as generic handoff branches so the surface is callable immediately even before a dedicated implementation exists

## Local-First Stance

The base path should work without cloud vendor lock-in:

- LM Studio local server is the default model endpoint
- LM Studio Chat is the default user-facing surface
- n8n is local by default
- NVIDIA key usage is optional
- shared MCP is optional

## LM Studio Chat Front Door

This starter should behave like one local product from the teammate's perspective.

- LM Studio Chat is the default front door
- the local control plane and n8n stay behind it as runtime surfaces
- OpenClaw, NemoClaw, OpenJarvis, and similar helper dependencies should be attached behind LM Studio Chat rather than introduced as competing first-run chat UIs
- if a teammate wants the highest-quality local chat first and the hardware allows it, point them to the Nemotron-3 Nano 30B profile before the 8B fallback

The repo-local MCP server is the current attachment point for that front-door model. It lets LM Studio Chat call runtime tools without making OpenJarvis, OpenClaw, or NemoClaw into separate required user interfaces.

## Why This Skeleton Exists

The usual friction points for teammates are predictable:

- they clone a repo and do not know which model runtime to launch
- they do not know whether n8n is mandatory or optional
- they see OpenJarvis or NemoClaw and assume everything depends on them on day one
- they cannot tell which parts are core versus optional lanes

This starter makes the default path explicit and keeps optional lanes attached but non-blocking.

## Future Shape

The starter already includes a thin Chat SDK skeleton under `src/chat-sdk/bot.ts`.

If Chat SDK becomes the main ingress layer later, this repository should absorb it without changing:

- local model ownership
- n8n orchestration ownership
- optional OpenJarvis or NemoClaw lanes
- optional shared MCP extensions

That is why the ingress is deliberately thin and the optional helper lanes stay outside the semantic core.

If long-term memory eventually needs a richer migration target than the current file ledger, Hermes Claw is a plausible next step, but it should stay optional until the team explicitly wants that tradeoff.
