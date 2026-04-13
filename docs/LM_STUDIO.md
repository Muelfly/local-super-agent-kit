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

If a teammate installs LM Studio in a nonstandard path, set `LM_STUDIO_APP_PATH` in `.env.local`.

## Model Profiles

- `4060ti-8b` defaults to a Nemotron Nano 8B hint.
- `3060ti-30b` defaults to a Nemotron-3 Nano 30B hint and uses a longer startup timeout.

The profile files are launch hints for teammates. They do not hardcode a permanent vendor dependency.
