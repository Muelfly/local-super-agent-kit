# Architecture

## Purpose

This repository is a local super-agent starter, not a monolithic production control plane.

It is meant to give teammates a portable local stack with clear ownership boundaries:

- LM Studio: default local inference surface
- LM Studio Chat: primary human-facing cockpit
- OpenJarvis: packaged local ops, telemetry, and evaluation runtime
- OpenClaw: packaged gateway/runtime lane bundled with the product path
- Hermes Agent: packaged agent runtime bundled with the product path
- NemoClaw: packaged sandboxed runtime tail for the local chain
- local control plane: file-backed state, tool generation, evaluation, and promotion hooks
- n8n: deterministic waits, retries, schedules, and webhook glue
- Chat SDK: included ingress skeleton, still replaceable
- shared MCP: optional upstream or team-shared extension, not mandatory core

## Ownership

- semantic owner: the teammate's durable notes and knowledge surface
- hot state: local runtime state, automation state, and ephemeral execution data, persisted locally under `.runtime`
- interactive surface: LM Studio Chat for day-to-day operator prompts
- ingress: replaceable adapter layer, not architectural owner
- execution: local model runtime plus the packaged local chain

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
- OpenClaw and Hermes are bundled local runtimes in the default product path
- n8n is local by default
- NVIDIA key usage is optional
- shared MCP is optional

The install path is now also asset-aware. Bootstrap can inspect the local machine, choose a curated model bundle, and persist that decision under `.runtime/install-plan.json` so the packaged runtime feels pre-wired instead of asking every teammate to choose model tradeoffs manually.

## LM Studio Chat Front Door

This starter should behave like one local product from the teammate's perspective.

- LM Studio Chat is the default front door
- the local control plane and n8n stay behind it as runtime surfaces
- OpenJarvis, OpenClaw, Hermes, and NemoClaw should be attached behind LM Studio Chat rather than introduced as competing first-run chat UIs
- shared MCP stays secondary around that bundled core
- if a teammate wants the highest-quality local chat first and the hardware allows it, point them to the Nemotron-3 Nano 30B profile before the 8B fallback

The repo-local MCP server is the current attachment point for that front-door model. It lets LM Studio Chat call runtime tools without making OpenJarvis, OpenClaw, or NemoClaw into separate required user interfaces.

## Why This Skeleton Exists

The usual friction points for teammates are predictable:

- they clone a repo and do not know which model runtime to launch
- they do not know whether n8n is mandatory or optional
- they see OpenJarvis or NemoClaw and assume parts of the packaged chain are still optional
- they cannot tell which parts are the front door versus the background chain

This starter makes the default path explicit and keeps the packaged OpenJarvis, OpenClaw, Hermes, and NemoClaw chain attached from day one.

That is why the chain is surfaced as required in doctor and bootstrap output, while Chat SDK and shared MCP remain visible secondary extensions.

## Future Shape

The starter already includes a thin Chat SDK skeleton under `src/chat-sdk/bot.ts`.

If Chat SDK becomes the main ingress layer later, this repository should absorb it without changing:

- local model ownership
- n8n orchestration ownership
- the packaged local chain
- optional shared MCP extensions

That is why the ingress is deliberately thin and only shared extensions stay outside the semantic core.

If long-term memory eventually needs a richer migration target than the current file ledger, the packaged Hermes runtime is already the natural bridge instead of a future optional add-on.
