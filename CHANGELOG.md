# Changelog

All notable changes to Ants are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.2.1] - 2026-10-28

### Fixed
- CSV export marks cells a spreadsheet would otherwise read as a formula as text.
- Token counts the API reports as anything other than a number are counted as none, rather than passed on.
- **Ants: Connection Status** shows the organization and account names the API returns as plain text, on one line.

## [0.2.0] - 2026-10-24

### Added
- Several organizations or workspaces at once. Each group under **Manage Models → Add Models → Claude (Console)** names an Anthropic profile (`ant auth login --profile <name>`); its models are listed under the group's name in chat and agent sessions, and requests through it are billed to that organization. A group with no profile uses the active sign-in, and follows it when it changes (`ant profile activate`, or a new sign-in): the next request goes to the new workspace and the models are listed again.
- **Ants: Connection Status**: for each group's profile, the organization and workspace billed, the account, when the credentials were last saved, the API host, and the last error, plus the profiles on this machine no group uses and the state of the VS Code settings agent sessions need.
- Every usage record now names the organization and workspace it was billed to, and the usage panel breaks spend down by them (**Billed to**) instead of by profile name. Records from before this change show the profile name, or "(active sign-in)".
- Requests that were stopped part-way or failed are logged too (`outcome`), a stopped one with the tokens that had arrived, since they are billed. The Requests card counts them.
- **Export CSV** in the usage panel saves the rows in view.
- On first run, an offer to turn on the two settings Copilot agent sessions need, and a pointer to `argv.json` when the proposed APIs are off. Each can be dismissed for good. **Ants: Allow Claude in Copilot Agent Sessions** does the same from the command palette.

### Changed
- Needs VS Code 1.141 or newer. The groups in Manage Models that every model now comes from arrived in 1.109, the bridge to Copilot agent sessions in 1.141, and the tests only ever run on the current release, so the stated minimum stops claiming older versions. Nothing changes for anyone on a current VS Code.
- A model the price table doesn't know is logged with no cost rather than a cost of 0, the panel counts it as unpriced and shows the total as a floor, and every total says which month's list prices it uses.
- Every model now belongs to a group in Manage Models, the way VS Code treats other providers with more than one instance. A fresh install has none, so the extension offers to open Manage Models the first time; adding one group is enough. If you had set an effort or context size on a model before, VS Code already made a group for it, and that group keeps working. Agent-session model ids gain the group name (`ants/<group>/<model>`), so a thinking level chosen for one may need choosing again.
- Sign-in errors say what was found rather than "not signed in": no profile on this machine (and where it looked), a Claude Code login made with **Create an API key**, a profile file that can't be read (with the SDK's reason), missing credentials, or an expired sign-in. A group naming a profile that doesn't exist is told which ones do. An `ANTHROPIC_API_KEY` in the environment is called out, since it overrides the active profile (named profiles ignore it). An API host that can't be reached is reported as that, not as a sign-in problem, and profiles that sign in another way (workload identity federation) get the SDK's own error. The active profile is resolved the way the SDK does it, `ANTHROPIC_PROFILE` included.
- The offer to add a first group no longer appears when groups already exist. Cancelling a reply is no longer treated as a failed sign-in. The button after enabling agent sessions says what it does: **Quit VS Code**, since VS Code can't restart itself.

## [0.1.0] - 2026-10-20

First release.

### Added
- Your Anthropic Console models in VS Code chat, as the **Claude (Console)** provider. Sign-in is the Anthropic profile that `claude /login` (Console account) or `ant auth login` writes; the SDK refreshes the token, and a new sign-in is picked up without a reload.
- The same models in Copilot agent sessions and the Agents window (`chat.agentHost.byokModels.enabled`, `extensions.supportAgentsWindow`).
- With VS Code's proposed APIs enabled: an effort picker (shown as **Thinking Level** in agent sessions), a context size picker (200K or 1M; 100K or 1M on Claude Haiku 5.5, where prompts over 100K cost five times as much), and Claude's thinking shown in chat and carried into the next turn. When the newest models refuse earlier thinking because the conversation was rewritten, the request is retried once without it.
- System prompts, tool calls and results, images (PNG, JPEG, GIF, WebP) and prompt caching, mapped to the Messages API; token usage reported back so chat can show how full the context is.
- **Ants: Show Claude Usage**: a panel over an append-only `usage.jsonl` log with cost estimates from Anthropic's list prices, token mix and cache hit rate, a time range and a zoomable timeline, and breakdowns by model, surface, effort and session down to single requests. Live-updates as requests finish.

[0.1.0]: https://github.com/spencrr/ants/releases/tag/v0.1.0

[0.2.0]: https://github.com/spencrr/ants/compare/v0.1.0...v0.2.0

[unreleased]: https://github.com/spencrr/ants/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/spencrr/ants/compare/v0.2.0...v0.2.1
