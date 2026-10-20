# Ants

Use Claude in VS Code with your Anthropic Console account, including organizations that sign in with SSO. Your Claude models show up in chat, in Copilot agent sessions, and in the Agents window.

The extension doesn't sign you in itself. It uses your Anthropic profile, the login that Claude Code and the [`ant` CLI](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication) save in `%APPDATA%\Anthropic` (`~/.config/anthropic` on macOS and Linux). The [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) reads that profile and refreshes the token for you.

This started as a VS Code version of [claude-oauth-proxy](https://github.com/achetronic/claude-oauth-proxy), which is for claude.ai Team and Enterprise logins. Console accounts have an official way to do the same thing, so this uses that instead.

## Sign in

If Claude Code already works with your Console account, skip this. Otherwise:

1. Run `claude` in a terminal and type `/login`.
2. Choose **Anthropic Console account**, then **Sign in with your Console account**. Don't pick **Create an API key**. That keeps the login inside Claude Code, where this extension can't use it.
3. Finish signing in in your browser.

If you have the `ant` CLI, `ant auth login` does the same thing.

If your sign-in expires and can't be renewed, chat shows an error asking you to sign in again. Do the steps above and try again. There's no need to reload VS Code.

## Install

Download `ants-<version>.vsix` from the [latest release](https://github.com/spencrr/ants/releases/latest) and install it from the Extensions view (`...` → **Install from VSIX...**), or from a terminal:

```sh
code --install-extension ants-0.1.0.vsix
```

To build it yourself, run `npm ci` and `npm run package`. To try changes without installing, open this folder in VS Code and press <kbd>F5</kbd>. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

Your Claude models then show up in the chat model picker. If they don't, open **Manage Models...** from the picker. It shows what went wrong.

### Copilot agent sessions and the Agents window

Of VS Code's agents, only Copilot can use models from extensions. That covers the Copilot CLI session type in chat, and Copilot in the Agents window. The Claude and Codex agents only offer their own models.

Copilot agent sessions only use models from extensions when this setting is on. In VS Code 1.141 it's off by default:

```json
"chat.agentHost.byokModels.enabled": true
```

The Agents window also only runs extensions you allow, so add this one:

```json
"extensions.supportAgentsWindow": {
    "spencrr.ants": true
}
```

Without that, agent sessions in the Agents window can only use your Claude models while a regular VS Code window is open. VS Code takes extension models from just one window at a time, so the models can also drop out of agent sessions when it picks the Agents window. In that window's model picker they'd also be listed under "Ants" rather than "Claude (Console)".

Restart VS Code after changing either setting. Then, in a Copilot agent session, open the model picker and switch from the **GitHub Copilot** tab to the **Claude (Console)** tab.

**Manage Models** lists each Claude model only once, under Claude (Console), even though agent sessions can use it too. Hiding a model there hides it everywhere.

Copilot also has to allow bring-your-own-key models for your account. It always does for individual plans and for members of Microsoft's and GitHub's organizations. On other business plans, an admin has to allow it.

### Effort picker, context size, and thinking

Three more features need VS Code's proposed APIs:

- **The effort picker.** It shows next to the model in chat, and as "Thinking Level" in agent sessions.
- **Context size.** In local chat, you can pick how much of the model's context window the conversation may fill. Copilot summarizes the conversation once it outgrows that size, which keeps each turn cheaper. Models with a 1M window offer 200K or 1M and start at 1M. Claude Haiku 5.5 offers 100K or 1M and starts at 100K, because its prompts over 100K tokens cost five times as much. Copilot agent sessions don't offer this for models from extensions yet.
- **Claude's thinking.** It's shown in chat and carried over to the next turn, which helps on longer tasks.

VS Code only turns these APIs on for extensions you list. Run **Preferences: Configure Runtime Arguments**, add this line, and quit and reopen VS Code. Every window has to close, the Agents window included, because reloading a window doesn't pick up this file:

```json
"enable-proposed-api": ["spencrr.ants"]
```

The **Ants** output channel says whether they're on. Without them, everything else still works. Claude still thinks on the newest models, but the thinking stays hidden.

### Usage and cost

Run **Ants: Show Claude Usage** to open a panel with your spend, token counts, and cache hit rate. Pick a time range, switch between cost, tokens, and requests, break the numbers down by model, surface, effort, or session, and click a session to see each request in it. Drag across the chart to zoom in on a stretch of time.

The costs are estimates from Anthropic's list prices, which are written into `src/usageLog.ts` and can go stale. Check against the Console's Cost page when it matters. Every request is appended to `usage.jsonl` in the extension's global storage folder; **Open log** in the panel shows the file.

Only this extension knows what your Console account pays. The Session Cost that VS Code shows in agent sessions counts Copilot credits, which your Claude (Console) requests never use, so in a session that mixes both it shows only the Copilot part.

## How it works

Everything in `src/` is small: `extension.ts` is the model provider, `usageLog.ts` keeps the request log and price table, and `usagePanel.ts` with the files in `media/` is the usage view. The provider implements VS Code's [`LanguageModelChatProvider`](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider):

- It lists your models from `/v1/models`, along with their context windows and which effort levels and kinds of thinking each one supports.
- It converts VS Code chat messages (system prompt, earlier thinking, tool calls and results, images) to the Messages API format.
- It streams text, thinking, and tool calls back, then reports token usage so chat can show how full the context is.
- It turns on prompt caching, since agent mode resends the whole conversation every turn.

VS Code hands models from extensions to Copilot agent sessions through a small local bridge to whichever window runs this extension, so the same provider serves chat and agent sessions.

The newest Claude models only accept earlier thinking while everything before it in the conversation is unchanged. Chat sometimes rewrites earlier turns, for example when it summarizes a long session. When Claude refuses earlier thinking for that reason, the extension retries once without it and notes that in the Ants output channel.

The `vscode.proposed.*.d.ts` files are type definitions for the proposed APIs, matching VS Code 1.141. Run `npm run proposed-api` to download them again after changing the version in `package.json`.

If `ANTHROPIC_API_KEY` is set in the environment VS Code was started from, the SDK uses that key instead of your profile.

## Limitations

- VS Code's own Claude agent doesn't recognize Console profile logins, so it only offers Copilot's Claude models. Use a Copilot agent session to run your Console models as an agent.
- Usage is billed to your Console organization, the same as Claude Code.
- In agent sessions, replies show up all at once rather than word by word, because VS Code's bridge waits for the full reply.
- Stopping an agent session turn doesn't stop the request to Claude, which finishes and is billed anyway. Stopping in regular chat works.
- Token counts are estimates (about 4 characters per token). VS Code uses them to size prompts, so a prompt can run a little past the context size you picked, including Haiku 5.5's 100K.
- Output is capped at 32k tokens per response, and the rest of the context window goes to the prompt.
- Proposed APIs can change in any VS Code update. If the effort picker, context size, or thinking stops working after an update, the rest keeps working.
