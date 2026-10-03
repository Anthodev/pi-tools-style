<h1 align="center">pi-tools-style</h1>

<p align="center"><strong>Give Pi tool activity clear, theme-aware structure without changing how tools run.</strong></p>

<p align="center">
  <a href="https://github.com/Anthodev/pi-tools-style/actions/workflows/ci.yml?query=branch%3Adevelop"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/Anthodev/pi-tools-style/ci.yml?branch=develop&amp;style=for-the-badge&amp;label=tests&amp;labelColor=101418"></a>
  <a href="https://github.com/Anthodev/pi-tools-style/releases/latest"><img alt="Latest stable release" src="https://img.shields.io/github/v/release/Anthodev/pi-tools-style?style=for-the-badge&amp;label=release&amp;labelColor=101418&amp;color=9ccbfb"></a>
  <a href="https://github.com/Anthodev/pi-tools-style/blob/develop/LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/Anthodev/pi-tools-style?style=for-the-badge&amp;labelColor=101418&amp;color=b9c8da"></a>
</p>

`pi-tools-style` adds rounded frames, tool-specific icons, and live running indicators to Pi tool calls and direct shell commands. It decorates the output Pi already produces instead of replacing tool definitions or renderers.

Built-in tools, MCP integrations, AFT, and third-party extensions keep control of their schemas, permissions, prompts, execution backends, and rendered content. When an output cannot be framed safely, the extension leaves it untouched.

## Highlights

- **Presentation without ownership** — wraps existing TUI output and never registers or replaces a tool.
- **Theme-aware borders** — assigns semantic Pi theme colors by tool category and follows theme changes live.
- **Three icon modes** — uses portable ASCII labels by default, richer Nerd Font glyphs when enabled, or icon-free titles.
- **Live running state** — animates the title while a model tool call is still executing, then removes the spinner on completion.
- **Terminal-correct sizing** — measures visible ANSI width before padding, truncating, or drawing borders.
- **Renderer-friendly composition** — preserves Pi, AFT, MCP, and extension-provided output inside the frame.
- **Image-safe fallback** — skips Kitty, iTerm2, and Sixel rows instead of corrupting terminal image sequences.
- **Reload-safe state** — keeps wrappers and runtime configuration idempotent across `/reload`.

## Installation

This checkout targets Pi `1.0.x`, verified with `1.0.0`, and requires Node.js `>=22.19.0`.

To install it, use the following command:

```bash
pi install npm:@anthodev/pi-tools-style
```

To install this checkout as a local Pi package:

```bash
cd /absolute/path/to/pi-tools-style
npm install --legacy-peer-deps
pi install "$(pwd)"
```

Pi stores the package in user settings and references the directory directly, so local changes become available after `/reload` or a restart.

## What it looks like

ASCII mode stays readable in any terminal:

```text
╭─ [F] | read / ───────────────────────╮
│ Reading README.md                    │
╰──────────────────────────────────────╯
```

Nerd Font mode uses tool-specific glyphs and Braille spinner frames:

```text
╭─  | read ⠹ ─────────────────────────╮
│ Reading README.md                    │
╰──────────────────────────────────────╯
```

Once execution finishes, the spinner disappears and the title remains stable:

```text
╭─  | read ───────────────────────────╮
│ README content                       │
╰──────────────────────────────────────╯
```

Direct `!` and `!!` commands use the same frame with a `shell` title. Slash-command output remains unchanged because Pi does not expose one uniform transcript component for slash commands.

## Usage

Boxes start enabled. Manage them from Pi with:

```text
/tools-style
/tools-style on
/tools-style off
/tools-style icons ascii
/tools-style icons nerd-font
/tools-style icons off
/tstyle
```

`/tools-style` toggles framing. `/tstyle` is a short alias with the same arguments. The explicit `on` and `off` forms set the desired state without depending on its current value.

Icon mode persists in `~/.pi/agent/config/tools-style.json`. ASCII remains the package default; Nerd Font mode can be enabled once for terminals that provide the required glyphs. `icons off` keeps frames and the ASCII running spinner, but removes the static icon and its `|` separator from titles.

```json
{
  "iconMode": "nerd-font"
}
```

Set `PI_TOOLS_STYLE=0` before startup to load the extension with framing disabled.

## Icons and running indicators

Common tools receive dedicated icons, while unknown tools fall back to their semantic category.

| Purpose | ASCII | Nerd Font | Examples |
| --- | --- | --- | --- |
| Read a file | `[F]` | `` | `read`, `read_symbol` |
| Write a file | `[W]` | `` | `write` |
| Edit content | `[E]` | `` | `replace`, `apply_patch` |
| Run a command | `[$]` | `` | `bash`, shell tools |
| Search | `[?]` | `` | `symbol_search`, `grep` |
| Use the web | `[@]` | `` | `web_search`, browser tools |
| Fetch content | `[v]` | `` | `fetch_content` |
| Call MCP | `[M]` | `` | `mcp`, `mcpScript` |
| Orchestrate work | `[*]` | `` | `workflow`, `subagent` |
| Track tasks | `[#]` | `` | `todo` |
| Ask the user | `[!]` | `` | `ask_user`, confirmation tools |
| Show diagnostics | `[D]` | `` | `lsp_diagnostics`, `lens_diagnostics` |
| Unknown tool | `[T]` | `` | third-party fallback |

While a model tool call is active, ASCII mode cycles through `| / - \` and Nerd Font mode cycles through `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`. One shared timer drives all active titles and stops after completion, interruption, box disablement, stale transcript removal, or session shutdown.

## Theme-aware palette

Borders resolve their color from the active Pi theme on every render. Switching themes therefore updates existing tool categories without reloading the extension.

| Category | Typical tools | Pi theme token |
| --- | --- | --- |
| Inspect | reads, searches, reports, diagnostics | `mdLink` |
| Mutate | writes, edits, create/update/delete operations | `warning` |
| Execute | bash, shell, tests, terminal commands | `bashMode` |
| External | web, fetch, MCP, browser, GitHub, Slack | `syntaxType` |
| Orchestrate | workflow, subagent, Ralph, todo | `customMessageLabel` |
| Interact | ask, question, confirm, select | `accent` |
| Other | unknown third-party tools | `borderMuted` |

## How it works

Pi `1.0.x` does not expose public, composable render middleware covering both tools and direct shell commands. `pi-tools-style` therefore installs a narrow wrapper around the existing `render()` methods of `ToolExecutionComponent` and `BashExecutionComponent`.

The wrapper asks the previous renderer to draw at the frame's inner width, removes only paired outer horizontal rules, and then adds ANSI-aware chrome. It does not call `pi.registerTool()`, replace tool definitions, or intercept execution.

Configuration and animation state live behind `Symbol.for()` keys. Reloading updates the active configuration without stacking wrappers or leaving duplicate timers behind. Any incompatibility or decoration error falls back to Pi's original full-width renderer.

## Compatibility and limits

- Pi `1.0.x` is the supported target, verified with `1.0.0` in both `fullscreen` and `regular` TUI modes. Pi `0.84.x` is no longer a supported target. Private TUI internals may change in later releases.
- The render wrapper is necessarily unsupported until Pi exposes public, composable render middleware.
- Kitty, iTerm2, and Sixel image output remains unboxed by design.
- Slash commands remain outside the current scope because their transcript output has no uniform component.
- Another extension can replace this wrapper if it overwrites component rendering without composing with the previous renderer.
- Unsupported renderer shapes fail open rather than affecting tool execution.
- Frame characters remain selectable text and are included in copied output. Excluding decorative cells would require Pi/TUI integration for fullscreen selection; no portable exclusion path has been identified for native terminal selection in regular mode.

## Development

Install dependencies and run the complete verification suite with:

```bash
npm install --legacy-peer-deps
npm run check
npm pack --dry-run --json
```

`npm run check` runs TypeScript validation and the Vitest suite. Tests cover frame width, ANSI output, terminal images, native and AFT rule removal, category colors, icon modes, persisted settings, spinner lifecycle, real `ToolExecutionComponent` and `BashExecutionComponent` integration, third-party renderer composition, decorator toggling and reinstallation, reload idempotence, fail-open behavior, and the no-`registerTool()` contract.

Release-note tests cover exact version sections, Markdown fences and whitespace, duplicate or missing sections, tagged Git snapshots, annotated and lightweight tags, and CLI failure paths.

`--legacy-peer-deps` avoids an npm 10.9.8 Arborist failure observed while resolving the development peer dependency graph.

## Releases

Releases are triggered only by stable `vX.Y.Z` tag pushes. `.github/workflows/publish.yml` validates the tagged commit on Node.js `22.19.0` and `24.x`, packages one npm tarball, publishes it to npm, then creates the GitHub release with that tarball and `SHA256SUMS` as assets.

`CHANGELOG.md` is the source of release notes. CI extracts the exact version section from the tagged commit, not the working tree, and preserves its summary, lists, links, and Markdown. Invalid tags, mismatched revisions, or missing, empty, or duplicate sections fail before publication. CI neither generates notes from commit subjects nor edits the changelog.

To prepare a release:

1. Update `package.json` and regenerate `package-lock.json`. Move the release entries from `Unreleased` into a dated `## [X.Y.Z] - YYYY-MM-DD` section, preserving verified commit or PR references and the full changelog comparison link.
2. Run `PI_CODING_AGENT_DIR="$(mktemp -d)" npm run check` and `npm run pack:check`.
3. Seal and push the release-preparation commit on `develop`. With jj, use the sealed commit's explicit SHA, never an empty working-copy `@`.
4. Set `VERSION` to the prepared package version and `RELEASE_SHA` to that commit's full SHA, then validate the notes before pushing the tag:

```bash
jj tag set "v${VERSION}" -r "$RELEASE_SHA"
notes="$(mktemp)"
node scripts/generate-release-notes.ts "v${VERSION}" "$RELEASE_SHA" "$notes"
jj git push --tag "v${VERSION}"
```

The workflow requires the tag to match the package and lockfile versions and to belong to `develop`. npm publication uses OIDC Trusted Publishing on a GitHub-hosted runner with the protected `npm` environment. Keep the `publish.yml` filename and environment aligned with the trusted publisher configuration. Concurrent release tags are serialized.

Publication is not an idempotent update. An already-published npm version or existing GitHub release makes a rerun fail. npm publication precedes GitHub release creation, so a failure in the latter can leave the package already published. Do not move a published tag or delete a release to make a rerun succeed.

## License

MIT
