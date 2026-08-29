# nodep

**AI-native browser automation and frontend testing — in one file, with zero dependencies.**

Built for **Zero Dependency 2026**, **Track A — Developer Tools & CLI**.
Runtime: Bun ≥ 1.4. Runtime dependencies: **none**.

The entire project — library, CLI and MCP server — is a single source file,
[`nodep.ts`](./nodep.ts), using nothing but the Bun standard library.

```bash
nodep audit http://localhost:3000
```
```
http://localhost:3000  webkit backend

✗ 3 problems

  console errors (1)
    ✗ Uncaught TypeError: Cannot read properties of undefined
  broken assets (1)
    ✗ image /assets/logo.png [404]
  layout overflow (1)
    ✗ 375x812 overflows by 42px — nav.menu
```

---

## Build and run

One command, and **no install step** — there are no dependencies to install:

```bash
bun run build     # -> ./dist/nodep, a standalone 61MB binary
./dist/nodep audit http://localhost:3000
```

Or run the source directly:

```bash
bun run nodep.ts audit http://localhost:3000
```

Verified: `bun run build` and the full test suite both pass with `node_modules`
deleted, and the compiled binary runs on a machine with no Bun and no browser
install.

## Zero-dependency proof

```bash
bun run proof
```

```
Manifest
  ✓ dependencies: empty
  ✓ peerDependencies: empty
  ✓ optionalDependencies: empty
  ✓ bundledDependencies: empty
Imports in nodep.ts
  ✓ node:fs — standard library
  ✓ node:path — standard library

ZERO THIRD-PARTY RUNTIME DEPENDENCIES — verified
```

The script parses the manifest, strips comments from the source and resolves
every `import`/`require`/dynamic-import specifier, exiting non-zero if a
third-party package ever appears. See **[STDLIB.md](./STDLIB.md)** for the 16
packages replaced and how.

## Reproducible build

```bash
bun run verify:build
```

Compiles twice to the same output path and compares digests:

```
REPRODUCIBLE — both builds are byte-identical
  sha256  8caf3cd060c779a8b8e5a0288cd967e0263c9ad99c14a87f0297840a2e4cb87d
```

*(Bun embeds the output filename in the executable, so the comparison must fix
the output path — the path is an input.)*

---

## Why this exists

Playwright and Puppeteer are built for humans writing local scripts. Pointed at
an AI agent they have three problems:

1. **Footprint** — hundreds of MB of browser binaries and a deep dependency tree.
2. **Context exhaustion** — locating an element means sending a whole DOM tree
   to a model, burning thousands of tokens on markup.
3. **Selector fragility** — `div > span.submit-btn` breaks the moment layout shifts.

`nodep` returns a compact, viewport-filtered list of only what is actually
clickable, with pixel coordinates, and drives the page with native events.

```jsonc
// getInteractiveTree() — the whole page, not a fragment
{
  "interactiveElements": [
    { "ref": "button#live", "tag": "button", "text": "Sign Up",
      "center": { "x": 140, "y": 220 },
      "boundingBox": { "x": 100, "y": 200, "width": 80, "height": 40 } }
  ],
  "occluded": 3, "offscreen": 41, "viewport": { "width": 1280, "height": 800 }
}
```

`occluded` and `offscreen` are the point: 44 elements matched the selector, 1 is
genuinely actionable. That filtering is what keeps the payload small.

---

## CLI

```
nodep <command> [url] [options]

  audit <url>         Health report: console errors, broken assets, layout overflow
  tree <url>          Actionable elements with click-ready coordinates
  responsive <url>    Horizontal-overflow audit across viewports
  shot <url>          Screenshot the viewport to a file
  serve               Run the MCP server on stdio
```

Key options: `--json`, `--backend webkit|chrome`, `--width`/`--height`,
`--viewports 1920x1080,375x812`, `--max`, `--settle`, `--out`, `--no-color`.
Full list: `nodep --help`.

**Exit codes** — designed for CI:

| Code | Meaning |
| :-- | :-- |
| `0` | Completed, nothing wrong found |
| `1` | Completed, problems found |
| `2` | Usage error |
| `3` | Runtime failure (browser launch or navigation failed) |

```bash
nodep audit "$STAGING_URL" --json > report.json || echo "frontend regressions found"
```

`--json` writes exactly one JSON document to stdout and nothing else — no
progress lines, no ANSI. Diagnostics always go to stderr. Colour switches off
automatically when stdout is not a TTY or `NO_COLOR` is set.

## Library

```ts
import { Engine } from "./nodep.ts";

await using e = await Engine.open({ url: "http://localhost:3000" });

const { interactiveElements } = await e.getInteractiveTree();
await e.clickCoordinate({ x: 140, y: 220 });

const blocked = await e.detectPointerBlocker({ x: 140, y: 220 });
// { isBlocked: true, intendedElement: "button#submit",
//   blockingElement: "div.modal-backdrop", pointerEventsStyle: "auto" }

const report = await e.compileHealthReport();
```

| Method | Notes |
| :-- | :-- |
| `goto(url)` / `waitForIdle()` | Navigate; network-quiet wait (chrome) |
| `getInteractiveTree({ max })` | Actionable elements + centre coordinates |
| `detectPointerBlocker({ x, y })` | What blocks a click, and why |
| `clickCoordinate({ x, y })` / `({ selector })` | Selector form waits for actionability |
| `typeInput({ text, realKeys })` | `realKeys` sends per-character keydown |
| `pressKey({ key, modifiers })` | `"Enter"`, `"Tab"`, chords |
| `hoverCoordinate({ x, y })` | **chrome only** |
| `scroll({ dx, dy })` / `({ selector })` | |
| `detectDeadClicks({ x, y, timeoutMs })` | DOM + console + navigation + network |
| `captureRuntimeLogs()` | Includes load-time errors |
| `interceptTraffic()` | **chrome only** |
| `scanBrokenAssets()` | Status codes on chrome only |
| `auditResponsiveness({ viewports })` | Overflow + offending elements |
| `captureViewport({ path })` | Writes a file, returns the path |
| `compileHealthReport()` | Consolidated scorecard |

`engine.view` exposes the underlying `Bun.WebView` for anything not wrapped here.

## MCP server

Every API is exposed as an MCP tool over stdio, so an agent drives the browser
through tool calls instead of shelling out and parsing text. The JSON-RPC layer
is hand-written — no SDK.

```json
{
  "mcpServers": {
    "nodep": { "command": "bun", "args": ["run", "/path/to/nodep/nodep.ts", "serve"] }
  }
}
```

## Backends

| | `webkit` (default) | `chrome` |
| :-- | :-- | :-- |
| Browser install required | **no** — system WebKit | yes (Chrome/Chromium/Brave) |
| Platform | macOS | any |
| Network interception, HTTP status codes, hover | ✗ | ✓ |

The three CDP-dependent APIs throw an error naming the fix when called on
`webkit`; the other twelve behave identically. `detectDeadClicks` reports
`registeredNetworkRequests: null` rather than `0` on webkit, so a signal that was
never measured is never mistaken for a measured zero.

## Things that will bite you (handled here)

- **Coordinates are CSS-space; screenshots are not.** On a retina display the PNG
  is 2× the CSS size. `captureViewport` returns `cssSize`, `pixelSize` and
  `deviceScaleFactor` so an agent cannot silently mis-click.
- **The backends disagree on `width`/`height`** — CSS viewport on webkit, outer
  *window* on chrome, an ~81px difference. `Engine.open()` normalizes both.
- **Per-character typing needs a barrier.** Key dispatch has no completion
  signal; without an `evaluate()` after each key, `"ab@c"` arrives as `"a"`.
- **`DOM.documentUpdated` cannot detect click effects** — it only fires on full
  document replacement. `detectDeadClicks` installs a `MutationObserver` first.
- **Console and network capture cannot be lazy.** Both are enabled before the
  first navigation, or load-time failures — the ones that matter — are gone.

## Tests

```bash
bun test          # 54 tests against a real browser and a real fixture server
bun run typecheck
```

Every backend-agnostic API is asserted on **both** backends against a
deliberately broken page (404 image, load-time console error, a button under a
backdrop, an inert div, 1400px overflow). The MCP server and the CLI are both
driven as real subprocesses over real pipes, including every exit code.

## License

MIT — see [LICENSE](./LICENSE).
