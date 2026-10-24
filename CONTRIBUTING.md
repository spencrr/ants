# Contributing

Thanks for helping. This file is the short version; [AGENTS.md](AGENTS.md) has the exact commands and the conventions that are not obvious from the code.

## Setup

```sh
npm ci            # Node >= 22.13; also installs the git hooks (lefthook)
npm run check     # typecheck + lint + tests; what CI runs
```

The tests start a real VS Code (downloaded once into `.vscode-test/`) against a fake Anthropic API. They never read your own sign-in. The git hooks run Biome on staged files when you commit and the typecheck when you push; skip one with `LEFTHOOK=0 git commit`.

To try the extension itself, open the folder in VS Code and press <kbd>F5</kbd>. The launch configuration enables the proposed APIs for the development host.

## Changes

- Open an issue first for anything beyond a small fix.
- One concern per pull request. Keep the commit messages in plain prose, like the existing history; no `Co-authored-by` trailers.
- Update `README.md` for anything users would notice, and add a line under **Unreleased** in `CHANGELOG.md`.
- Keep the prose and comments in the voice of the existing code: short, plain, written for a person.
- Never commit anything from your own `%APPDATA%\Anthropic` or `~/.config/anthropic`, nor a `usage.jsonl`; the test fixtures are synthetic.

## Releases

Maintainers cut releases with `node scripts/release.mjs <version>` and push the tag; `.github/workflows/release.yml` builds the VSIX and publishes the GitHub Release.

One thing the tests can't do: drive a Copilot agent session, which needs Copilot itself. So before a release, install the VSIX, open a Copilot agent session in the Agents window, and send one message through a model of each group in Manage Models. Then check in **Ants: Show Claude Usage** that each request shows under the right **Billed to**, and in **Ants: Connection Status** that no profile has a last error.
