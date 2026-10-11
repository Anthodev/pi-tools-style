<h1 align="center">pi-tools-style</h1>

<p align="center"><strong>Give Pi tool activity clear, theme-aware structure without changing how tools run.</strong></p>

> [!NOTE]
> The published npm `0.1.4` release still targets Pi `1.0.x`. Version `0.2.0`, which moves to Pi `1.1.x` and the middleware support, semantic cards, and MCP, web-search, and execution views described on this page.

`pi-tools-style` gives Pi tool calls and direct shell commands clear semantic structure: status, duration, and identity in a card head, command and content in framed sections, bounded previews that expand in place with `Ctrl+O`, and colors that follow the active theme. It draws through Pi's public tool-renderer middleware and never registers or replaces a tool.

Built-in tools, MCP servers, and third-party extensions keep control of their schemas, permissions, prompts, execution backends, and content. Cards show only the data a result already contains; outputs that cannot be framed safely pass through untouched.

## Highlights

- **Presentation without ownership** — draws semantic cards around tool activity and never registers or replaces a tool.
- **Public render middleware** — builds on Pi `1.1`'s `registerToolRenderer` for tool cards instead of private render wrappers.
- **MCP-aware** — proven `server/tool` identity, declared annotation hints, dedicated resource views, and full-output paths shown but never read.
- **Web-search views** — exact tool recognition, answers and sources rendered from the result, configurable extra tool names, no name heuristics.
- **Three icon modes** — uses portable ASCII labels by default, richer Nerd Font glyphs when enabled, or icon-free titles.
- **Terminal-correct sizing** — measures visible ANSI width before padding, truncating, or drawing borders.
- **Image-safe fallback** — skips Kitty, iTerm2, and Sixel rows instead of corrupting terminal image sequences.
- **Reload-safe state** — keeps registration and runtime configuration idempotent across `/reload`.

## Installation

This checkout targets Pi `>=1.1.0 <2`, verified with `1.1.0`, and requires Node.js `>=22.19.0`.

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

Cards stay collapsed to a bounded preview and expand in place with `Ctrl+O`. The following frames are captured verbatim from provider-free offline replays at a 120-column terminal; they prove rendering, not filesystem execution. A `bash` call renders as a framed card with the tool's identity, state, and duration in the head, the supplied command directly below the head above an `Output` section, and a completion mark (shown expanded with `Ctrl+O`):

```text
╭─── [$] | Bash · ok ──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ $ echo "First command line"                                                                                          │
│ echo "Second command line"                                                                                           │
│ timeout: 10s                                                                                                         │
├─── Output ───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ First command line                                                                                                   │
│ Second command line                                                                                                  │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The head never repeats the command; `Ctrl+O` reveals any remaining command lines above the same `Output`, with no `Command` divider row.

A `read` call renders as a framed card too: the supplied path sits directly under the head, above the previewed `Output`:

```text
╭─── [F] | Read · ok ──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ path: /offline/InputLiteralPath.txt                                                                                  │
├─── Output ───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ O01                                                                                                                  │
│ O02                                                                                                                  │
│ O03                                                                                                                  │
│ O04                                                                                                                  │
│ O05                                                                                                                  │
│ O06                                                                                                                  │
│ O07                                                                                                                  │
│ O08                                                                                                                  │
│ O09                                                                                                                  │
│ O10                                                                                                                  │
│ … 2 more lines ctrl+o to expand                                                                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

`find`, `grep`, and `ls` follow the same shape: their supplied path, pattern, and options render the same way, above their `Output`.

Direct `!` and `!!` commands keep their frame and `shell` title through a guarded internal adapter described under [How it works](#how-it-works), and place the command body directly below the head above `Output` like tool cards. An interrupted command renders an explicit cancelled state rather than an error. Slash-command output remains unchanged because Pi does not expose one uniform transcript component for slash commands.

## Usage

Boxes start enabled. Manage them from Pi with:

```text
/tools-style
/tools-style on
/tools-style off
/tools-style config
/tools-style icons ascii
/tools-style icons nerd-font
/tools-style icons off
/tstyle
```

`/tools-style` toggles framing. `/tstyle` is a short alias with the same arguments. The explicit `on` and `off` forms set the desired state without depending on its current value. Turning boxes off restores Pi's native rendering for downstream renderers, backgrounds, and padding.

`/tools-style config` opens an interactive menu (interactive TUI sessions only) listing the global switch, the icon mode, the shell card switch, and one row per known tool — the eight native tools, MCP calls, third-party tools, and the owned execution tools. Fuzzy search filters the rows; `Enter` or `Space` flips the selected value; `Escape` closes. Per-tool rows store explicit preferences for that exact tool name (absent means follow the global switch); already-rendered rows restyle immediately and every choice persists across restarts and `/reload`. The shell card has its own switch, so `!/!!` styling can be turned off without touching tool calls.

## Settings

Settings persist in `~/.pi/agent/config/tools-style.json`. The icon mode, the web-search recognition list, and the per-tool preferences share the file; saving an icon mode preserves the configured list and tool preferences. ASCII remains the package default; Nerd Font mode can be enabled once for terminals that provide the required glyphs. `icons off` keeps frames but drops the icon and its `|` separator from titles, showing the textual status (`pending`, `running`, `done`, `error`, `cancelled`) instead of an animated spinner.

```json
{
  "enabled": true,
  "iconMode": "nerd-font",
  "shellEnabled": true,
  "webSearchTools": ["mcp__my_web__search"],
  "tools": {
    "read": false,
    "mcp__my_web__search": true
  }
}
```

`webSearchTools` accepts exact tool names only; see [Web-search cards](#web-search-cards). `tools` maps exact tool names to explicit `true`/`false` preferences; a name absent from the map follows the global switch. `shellEnabled` styles the direct shell card (`!`/`!!`) independently of tool calls. With `enabled: false` the global switch wins and every card returns to Pi's native rendering while the stored preferences are kept. Set `PI_TOOLS_STYLE=0` before startup to load the extension with framing disabled.

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

While a model tool call is active, the status mark animates: ASCII mode cycles through `| / - \` and Nerd Font mode cycles through `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`. Completion replaces the spinner with `ok` or `✓` (`!` or `✗` on error) and a duration such as `1.3s`. One shared timer drives all active titles and stops after completion, interruption, box disablement, stale transcript removal, or session shutdown.

## Cards and colors

Card borders and backgrounds follow the active Pi theme, so switching themes updates existing cards without reloading. The color follows the card state, not a tool category:

| State | Border | Theme tokens |
| --- | --- | --- |
| Pending or running | accent | `accent`, `toolPendingBg` |
| Done | muted | `borderMuted`, `toolSuccessBg` |
| Error | error | `error`, `toolErrorBg` |
| Cancelled | warning | `warning` |

Direct `!` and `!!` shell cards use the same state-based border and background selection as every other card; there is no separate category color.

## Tool presentations

The plugin renders these tool-specific cards:

Supplied call arguments render directly under the head without an `Input` or `Command` divider. Other section dividers, including `Output`, `Diff`, and `Calls`, are unchanged.

| Tool | Card |
| --- | --- |
| `bash`, `powershell` | Framed: identity, state, and duration in the head; the command (first line, supplied options such as `timeout`) directly below the head above `Output` (last ten lines), truncation note, `Full output: <path>` when Pi wrote one |
| `edit` | Framed: path and the request, kept when the result arrives, above the final `Diff` or error |
| `write` | Framed: path and content preview above the actual result `Output`; an empty result shows no fabricated confirmation |
| `read` | Framed: path and any supplied offset or limit above the `Output` preview |
| `find`, `grep`, `ls` | Framed: supplied pattern, path, and options above the `Output` entries with an expand hint |
| `ctx_execute`, `ctx_execute_file` | Framed: path, language, code, and options above the `Output` text |
| `codemode` | Framed: JavaScript, model `Calls`, optional cost total, `Output`, `Full output: <path>` |
| MCP calls | Framed: proven identity and declared hints in the head, supplied arguments above the `Output` |
| MCP resources | Framed: resource title in the head, supplied server and URI arguments above the `Output` |
| Web search | Framed in every state: query and supplied options above the answer, sources, or raw response |

Every card shows its target once — in the head or directly below it — and collapses previews behind a `… N more lines` or `… N more entries` hint. Output paths are displayed but never read.

### MCP cards

- A tool is treated as proven MCP only when Pi's public tool info reports `builtin:mcp`. An `mcp__*` name or reserved resource name that Pi has not proven is treated as an unresolved MCP call and still gets the MCP card, unless a downstream renderer already draws its own complete shell, in which case it passes through untouched; provenance is re-checked against Pi's tool list on render.
- The head keeps only the callable identity: `server/tool` when the result details prove both, or `namespace/tool` when a proven namespace prefixes the exposed name; otherwise it falls back to the exposed tool name. A meta line shows the namespace when it is not already in the head, the exposure form when it is not direct, and annotation hints exactly as the server declares them (read-only, destructive, idempotent, open-world). Declared hints are shown, not verified. Supplied arguments are never merged into the head; the complete arguments render directly under the head.
- Resource tools get their own cards. The head shows the resource title only; supplied arguments render as delivered (schemaless safe JSON) directly under the head, where `…` marks a value that has not arrived rather than a validated required field, and empty arguments are shown literally.

### Web-search cards

- Recognition is exact: Pi's native `web_search`, names listed in `webSearchTools`, and MCP tools proven as `web_search` by their namespace or result details. Pi's own tool names are refused even if configured by mistake, and no substring heuristics apply.
- The card renders only what the result already contains: the answer, sources (eight collapsed with a `… N more sources` hint), provider and usage metadata, warnings, and a `Full output: <path>` reference. It never executes, fetches, or reads anything.
- Unstructured results keep a six-line text preview instead of a source tree.
- MCP and web-search rendering is verified offline against recorded tool info and results. The extension does not contact servers or providers and makes no transport or quality promise.

### Execution cards

- Ownership follows the exact requested tool name and is case-sensitive: `codemode`, or any name starting with `ctx_execute` (`ctx_execute`, `ctx_execute_file`, and a future `ctx_execute*` suffix). `ctx_batch_execute`, `mcp__server__ctx_execute`, and other casings are not owned. The match needs no provenance, so these names get execution cards even when Pi reports none, and the web exception refuses them even if configured in `webSearchTools`.
- `ctx_execute` and `ctx_execute_file` show their metadata (path for the file form, language for both), the code, and the remaining options — `timeout` in milliseconds, `background`, `cwd`, `intent` — directly under the head, above `Output`. The path is displayed, never read. The server's own input echo is dropped only on an exact match, so a result that does not match the arguments stays intact; codemode's `Script completed`/`Script failed` wrapper is likewise dropped only when it matches exactly.
- Collapsed previews are independent: the code keeps the first ten visual lines, `Output` the first five. `Ctrl+O` expands the full content.
- `codemode` shows its JavaScript directly under the head, each model call (name, arguments, status, duration, cost) in a `Calls` section that keeps the last eight entries behind a `… N more entries` hint and prints full errors when expanded, a `Model calls: $…` total when more than one call has a positive cost, the `Output`, and a `Full output: <path>` reference. A partial result shows only the calls already reported and no output.
- Turning cards off, a presentation failure, or a width below the card minimum restores the captured native renderer for these tools.

## How it works

Pi `1.1` exposes a public render middleware: extensions call `pi.registerToolRenderer()`, and the registered resolvers run in extension load order. `pi-tools-style` registers one resolver that receives `next()` — the downstream remainder of the resolver chain — and draws its own card around the renderer that `next()` returns, capturing that renderer's call and result fragments.

Ordering decides the outcome. An earlier registered authoritative non-web renderer wins outright and this plugin is never consulted; a web provider registered after it is intercepted by the web exception, while a web renderer registered before it must delegate web calls through `next()` for that exception to apply. A resolver sees only the renderer handed to it through `next()`, cannot tell which extension produced it, and cannot reorder the chain. Generic third-party renderers are preserved — drawn inside the card, or passed through untouched when they already draw their own complete shell — whereas builtin, MCP, recognized web, and owned execution renderers are replaced by these cards while styling is on and restored to Pi's native rendering when it is turned off. Execution ownership is matched by the exact requested name and is checked first, so those names never take the generic self-shell passthrough and are never promoted to web cards.

Direct `!` and `!!` shell commands are not covered by that middleware. They keep a narrow internal decorator on the shell component, guarded so that any incompatible Pi internal change disables only shell framing and reports `Shell styling unavailable: incompatible Pi renderer internals.` The public tool cards keep working.

Turning cards off restores Pi's native rendering. Decoration errors fail open to the native layout, terminal image sequences (Kitty, iTerm2, Sixel) pass through unframed, and the extension never calls `pi.registerTool()` or intercepts execution. Reloading re-registers the renderer and refreshes configuration without stacking wrappers or leaving duplicate timers behind.

### Rendering and cache boundaries

- **Header-only animation** — Owned tool cards refresh their prepared running header without rebuilding or rendering the body again. Direct-shell cards reuse Pi's existing loader cadence. For generic renderers, only a known static `Text`/`Container` tree whose descendants are all static and passive qualifies for the header-only transaction; an opaque or custom-render component keeps the ordinary SDK invalidation path so implicit dynamic rendering stays live. This does not make every generic card cost-free.
- **Generic cards** — A third-party renderer that does not draw its own complete shell is drawn inside the card: its real call component renders directly under the head (first ten visual lines) and its real result component becomes `Output` (first five), falling back to the safe supplied arguments or extracted text only when the renderer returns no usable component. Interactive components are never sliced, while a noninteractive sibling still keeps its own preview and hint.
- **Bounded preparation** — Each row retains one current primary body and one current-width layout. Unchanged text, Markdown, and syntax highlighting are reused; ordinary callbacks still re-read arguments and results, including objects mutated in place. Real component or environment invalidation clears derived preparation, while width-only changes relayout the retained view.
- **Exact previews** — Previews remain bounded after wrapping. Unusual Unicode clusters keep defensive width checks, and fresh large payloads still require full-context highlighting and wrapping. This reduces renderer CPU work, not all terminal painting or input latency.

## Compatibility and limits

- Pi `>=1.1.0 <2` is the supported peer range, verified with `1.1.0` in both `fullscreen` and `regular` TUI modes. Future `1.x` releases are expected to work through the public middleware, but each release is verified, not assumed.
- The direct-shell decorator relies on Pi component internals. Its compatibility is bounded by verification: when internals change, the guard disables shell framing only, and the peer range alone does not prove it.
- Pi's HTML exporter processes SGR styling only. OSC 8 hyperlinks are exported as raw control text around the link label, so exported HTML shows escape sequences that the terminal itself would render as links. The extension adds no artificial export mode or private workaround, and no claim is made about link interaction or image rendering in exports.
- Pi serializes call and result rows independently. An exported card can therefore show a repeated closing border, and a call row exported while still running keeps the state it had at that moment. No retroactive fixups are attempted.
- Windows runtime behavior is untested; the Windows-specific path test is skipped on other platforms.
- Kitty, iTerm2, and Sixel image output remains unboxed by design.
- Slash commands remain outside the current scope because their transcript output has no uniform component.
- A card that cannot be framed safely — turned off globally or per name, narrower than the card minimum, a presentation or construction failure, or an unsupported renderer shape — falls back to the captured native rendering rather than affecting tool execution. A downstream renderer that already draws its own complete shell, and terminal-image output, pass through untouched.
- Frame characters remain selectable text and are included in copied output. Excluding decorative cells would require Pi/TUI integration for fullscreen selection; no portable exclusion path has been identified for native terminal selection in regular mode.

## Development

Install dependencies and run the complete verification suite with:

```bash
npm install --legacy-peer-deps
npm run check
npm pack --dry-run --json
```

Pi selects which extension files a package contributes through that package's `pi.extensions` field (`index.ts` here); activating the working tree means adding the checkout path to Pi's `packages` setting in the user settings and restarting Pi. An already-loaded package picks up changes after `/reload`.

`npm run check` runs TypeScript validation and the Vitest suite. Tests cover the builtin, MCP, web-search, and execution semantic views against recorded results, shell command placement and independent previews, frame layout and ANSI width parity, native restoration when cards are disabled, the public middleware resolver and its self-shell exception, the guarded shell decorator, category colors, icon modes, persisted settings, spinner lifecycle, real Pi `1.1` component integration, reload idempotence, fail-open behavior, and the no-`registerTool()` contract.

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
