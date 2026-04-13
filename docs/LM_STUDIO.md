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
- OpenJarvis, OpenClaw, Hermes, and NemoClaw should ship behind it as packaged chain stages through local tools, gateways, MCP, or local HTTP surfaces
- shared MCP can remain secondary around that packaged chain
- teammates should not need to decide which assistant UI to open before they can use the package

## LM Studio MCP Bridge

This repo now ships a local MCP server branded as `super-agent` so LM Studio Chat can reach the control plane and packaged runtime chain without introducing another primary console.

- run `npm run install:lmstudio-mcp` to write the `super-agent` entry into `~/.lmstudio/mcp.json`
- bootstrap now installs that entry automatically for the teammate path
- if LM Studio was already open, restart it so the new MCP server entry is picked up

When the MCP bridge is active, the intended experience is that the user is talking to Super Agent, not to whichever base model is currently selected in LM Studio Chat. The selected model is the reasoning shell; the MCP tool surface is the product capability layer.

The MCP surface currently exposes:

- `super_agent_status`
- `super_agent_automation_status`
- `super_agent_workflows`
- `super_agent_workflow_runs`
- `super_agent_reason`
- `super_agent_delegate`
- `super_agent_openclaw_agent`
- `super_agent_hermes_agent`
- `super_agent_workspace_list`
- `super_agent_workspace_read`
- `super_agent_workspace_write`
- `super_agent_shell`
- `super_agent_runtime_status`
- `super_agent_sandbox_status`
- `super_agent_fetch`
- `super_agent_notes`
- `super_agent_tool_generate`
- `super_agent_workflow_design`

This packaged variant is intentionally full-access on the local machine boundary. The Super Agent MCP surface can now enumerate the workspace, read files, write files, and execute shell commands directly. If you want stricter guardrails, apply them outside the starter through your packaging policy, runtime sandbox, or deployment environment.

The MCP bridge now also exposes runtime-native entry points for OpenClaw and Hermes. Use those when you want the packaged runtimes to behave like themselves rather than only consuming them through the thinner compatibility chat layer.
