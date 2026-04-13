# LM Studio Notes

## Default Contract

This starter assumes LM Studio exposes an OpenAI-compatible local endpoint at:

- `http://127.0.0.1:1234/v1`

The doctor and bootstrap scripts probe:

- `/models`

## Auto-Launch Behavior

Bootstrap can attempt to launch the LM Studio desktop app when:

- `LM_STUDIO_AUTO_LAUNCH=true`
- a local app path can be resolved

When the bundled LM Studio CLI is available, bootstrap and doctor also try `lms server start` before they fall back to the desktop app. This helps on fresh Windows installs where the app is present but the local server is still off.

If a teammate installs LM Studio in a nonstandard path, set `LM_STUDIO_APP_PATH` in `.env.local`.

## Package UX Defaults

For the packaged teammate-facing experience, treat these as the preferred LM Studio defaults:

- UI language: Korean
- local OpenAI-compatible service: enabled
- bundled auto-load prompt: disabled so first launch does not immediately steer teammates into Gemma 4
- primary chat model when hardware allows: Nemotron-3 Nano 30B
- lighter fallback chat model: Nemotron Nano 8B

On the current Windows machine, the tracked local settings now keep `language` on `ko`, `enableLocalService` on, and `autoLoadBundledLLM` off.

## Model Profiles

- `4060ti-8b` defaults to a Nemotron Nano 8B hint.
- `3060ti-30b` defaults to a Nemotron-3 Nano 30B hint, uses a longer startup timeout, and should be the first documented choice for teammates who want the richest local chat model first.

The profile files are launch hints for teammates. They do not hardcode a permanent vendor dependency.

## Chat Front Door

LM Studio Chat should be treated as the operator-facing front door for this starter.

- everyday chat should happen in LM Studio Chat first
- OpenClaw, NemoClaw, OpenJarvis, and other helper lanes should plug in behind it through local tools, gateways, MCP, or local HTTP surfaces
- teammates should not need to decide which assistant UI to open before they can use the package

## LM Studio MCP Bridge

This repo now ships a local MCP server so LM Studio Chat can reach the control plane and helper lanes without introducing another primary console.

- run `npm run install:lmstudio-mcp` to write the repo entry into `~/.lmstudio/mcp.json`
- bootstrap now installs that entry automatically for the teammate path
- if LM Studio was already open, restart it so the new MCP server entry is picked up

The MCP surface currently exposes:

- `stack_status`
- `n8n_status`
- `n8n_workflows`
- `n8n_executions`
- `openjarvis_chat`
- `openclaw_chat`
- `nemoclaw_status`
- `web_fetch`
- `notes_capture`
- `tool_generate`
