# Security

## What Ants touches

- **Reads** your Anthropic profile (`%APPDATA%\Anthropic`, or `~/.config/anthropic`) through the official Anthropic SDK, which also **writes** refreshed tokens back to it. The extension never sees or logs the tokens itself.
- **Writes** one file of its own: `usage.jsonl` in the extension's global storage folder, with token counts, timings, model names and a short hash of each conversation's first message. No prompt or reply text is stored.
- **Network:** `api.anthropic.com` only (or whatever `base_url` your profile names). There is no telemetry.
- **Prompts** go to Anthropic under your Console organization, the same as Claude Code. Everything an agent session sends to its model, tool results included, is sent to Claude.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through [GitHub's private vulnerability reporting](https://github.com/spencrr/ants/security/advisories/new) for this repository. Include the extension version, your VS Code version and platform, and steps to reproduce.

You will get an acknowledgement within a few days. Fixes ship as a patch release, with the advisory published once the fix is available.

## Supported versions

Only the latest release is supported.
