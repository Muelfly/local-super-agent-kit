# Architecture

## Purpose

This repository is a local super-agent starter, not a monolithic production control plane.

It is meant to give teammates a portable local stack with clear ownership boundaries:

- LM Studio: default local inference surface
- n8n: deterministic waits, retries, schedules, and webhook glue
- OpenJarvis: optional local ops, telemetry, and evaluation lane
- NemoClaw: optional sandbox or review lane
- Chat SDK: included ingress skeleton, still replaceable
- shared MCP: optional upstream or team-shared extension, not mandatory core

## Ownership

- semantic owner: the teammate's durable notes and knowledge surface
- hot state: local runtime state, automation state, and ephemeral execution data
- ingress: replaceable adapter layer, not architectural owner
- execution: local model runtime plus optional helper tools

## Local-First Stance

The base path should work without cloud vendor lock-in:

- LM Studio local server is the default model endpoint
- n8n is local by default
- NVIDIA key usage is optional
- shared MCP is optional

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
