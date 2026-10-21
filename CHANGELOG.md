# Changelog

All notable changes to Ants are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added
- On first run, an offer to turn on the two settings Copilot agent sessions need, and a pointer to `argv.json` when the proposed APIs are off. Each can be dismissed for good. **Ants: Allow Claude in Copilot Agent Sessions** does the same from the command palette.

### Changed
- Sign-in errors say what was found rather than "not signed in": no profile on this machine (and where it looked), a Claude Code login made with **Create an API key**, a profile kind this extension doesn't support, missing credentials, or an expired sign-in. An `ANTHROPIC_API_KEY` in the environment is called out, since it overrides the profile.

## [0.1.0] - 2026-10-20

First release.

### Added
- Your Anthropic Console models in VS Code chat, as the **Claude (Console)** provider. Sign-in is the Anthropic profile that `claude /login` (Console account) or `ant auth login` writes; the SDK refreshes the token, and a new sign-in is picked up without a reload.
- The same models in Copilot agent sessions and the Agents window (`chat.agentHost.byokModels.enabled`, `extensions.supportAgentsWindow`).
- With VS Code's proposed APIs enabled: an effort picker (shown as **Thinking Level** in agent sessions), a context size picker (200K or 1M; 100K or 1M on Claude Haiku 5.5, where prompts over 100K cost five times as much), and Claude's thinking shown in chat and carried into the next turn. When the newest models refuse earlier thinking because the conversation was rewritten, the request is retried once without it.
- System prompts, tool calls and results, images (PNG, JPEG, GIF, WebP) and prompt caching, mapped to the Messages API; token usage reported back so chat can show how full the context is.
- **Ants: Show Claude Usage**: a panel over an append-only `usage.jsonl` log with cost estimates from Anthropic's list prices, token mix and cache hit rate, a time range and a zoomable timeline, and breakdowns by model, surface, effort and session down to single requests. Live-updates as requests finish.

[unreleased]: https://github.com/spencrr/ants/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/spencrr/ants/releases/tag/v0.1.0
