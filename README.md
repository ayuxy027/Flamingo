# 🦩 flamingo

### AI Native Frontend Testing Toolkit

**One file. Zero dependencies. Built on Bun.**

An AI agent looking at your frontend is effectively blind. Playwright hands it a
DOM dump it burns thousands of tokens failing to parse. flamingo hands it a short
list of what is actually visible and clickable — and, like the bird it is named
after, filters the few things that matter out of a whole lake of mud.

Built for **Zero Dependency 2026**, **Track A — Developer Tools & CLI**.
Runtime: Bun ≥ 1.4. Runtime dependencies: **none**.

The entire project — library, CLI and MCP server — is a single source file,
[`flamingo.ts`](./flamingo.ts), using nothing but the Bun standard library.

```bash
flamingo crawl http://localhost:3000
```
```
http://localhost:3000

  14 controls found, 14 tested
  ✓ 12 responded
  ✗ 2 dead

    ✗ button#checkout "Checkout"  blocked by div.modal-backdrop
    ✗ a.help          "Help"      no handler fired
```

Every control on the page, clicked, with the dead ones named and explained —
swallowed by an overlay, or simply never wired up.

```bash
flamingo audit http://localhost:3000
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

## Install

```bash
bun add @ayuxy027/flamingo
```

Then check the environment — the first thing to run, and the first thing to ask
for when anything misbehaves:

```bash
bunx flamingo doctor
```
```
flamingo 0.1.0 — AI Native Frontend Testing Toolkit

  ✓ bun       1.4.0 (requires >=1.4.0)
    platform  darwin arm64
  ✓ webkit    system WebKit — no browser install needed
  ✓ chrome    /Applications/Brave Browser.app/Contents/MacOS/Brave Browser

✓ ready
```

Every command carries its own help (`flamingo crawl --help`), and
`flamingo schema` prints the entire API — 16 MCP tools with JSON Schemas, 8 CLI
commands with flags and exit codes — as one JSON document, so an agent can learn
to call everything without reading these docs:

```bash
flamingo schema | jq '.tools[].name'
```

## Build and run

One command, and **no install step** — there are no dependencies to install:

```bash
bun run build     # -> ./dist/flamingo, a standalone 61MB binary
./dist/flamingo audit http://localhost:3000
```

Or run the source directly:

```bash
bun run flamingo.ts audit http://localhost:3000
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
Imports in flamingo.ts
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
  sha256  09782193da1f910724195608e880c784b6cfaf58c6525cb2bddb38a072092e98
```

*(Hash is for the current committed source. Bun embeds the output filename in the executable, so the comparison must fix
the output path — the path is an input.)*

---

## Why this exists

Playwright and Puppeteer are built for humans writing local scripts. Pointed at
an AI agent they have three problems:

1. **Footprint** — hundreds of MB of browser binaries and a deep dependency tree.
2. **Context exhaustion** — locating an element means sending a whole DOM tree
   to a model, burning thousands of tokens on markup.
3. **Selector fragility** — `div > span.submit-btn` breaks the moment layout shifts.

`flamingo` returns a compact, viewport-filtered list of only what is actually
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
flamingo <command> [url] [options]

  audit <url>         Health report: console errors, broken assets, layout overflow
  crawl <url>         Click every control and report the dead ones
  tree <url>          Actionable elements with click-ready coordinates
  responsive <url>    Horizontal-overflow audit across viewports
  shot <url>          Screenshot the viewport to a file
  serve               Run the MCP server on stdio
  doctor              Check the environment and report what works here
  schema              Print the machine-readable API description as JSON
```

Key options: `--json`, `--backend webkit|chrome`, `--width`/`--height`,
`--viewports 1920x1080,375x812`, `--max`, `--settle`, `--out`, `--no-color`.
Full list: `flamingo --help`.

**Exit codes** — designed for CI:

| Code | Meaning |
| :-- | :-- |
| `0` | Completed, nothing wrong found |
| `1` | Completed, problems found |
| `2` | Usage error |
| `3` | Runtime failure (browser launch or navigation failed) |

```bash
flamingo audit "$STAGING_URL" --json > report.json || echo "frontend regressions found"
```

`--json` writes exactly one JSON document to stdout and nothing else — no
progress lines, no ANSI. Diagnostics always go to stderr. Colour switches off
automatically when stdout is not a TTY or `NO_COLOR` is set.

## Library

```ts
import { Engine } from "./flamingo.ts";

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
| `detectDeadClicks({ x, y, timeoutMs })` | DOM + console + navigation + focus + network |
| `crawl({ max, dwellMs })` | Click every control; report the dead ones and why |
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
    "flamingo": { "command": "bun", "args": ["run", "/path/to/flamingo/flamingo.ts", "serve"] }
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
- **A click that only moves focus is not dead.** Clicking a text field focuses
  it and changes nothing else; counting that as dead flags every input on the
  page. Focus landing on a *button*, though, proves nothing — buttons take focus
  on any click — so only fields count.

## Tests

```bash
bun test          # 64 tests against a real browser and a real fixture server
bun run typecheck
```

The installed package is verified too: the bin links and runs, the library
import works, and `schema` is asserted to describe every tool well enough to call
it blind. Every backend-agnostic API is asserted on **both** backends against a
deliberately broken page (404 image, load-time console error, a button under a
backdrop, an inert div, 1400px overflow). The MCP server and the CLI are both
driven as real subprocesses over real pipes, including every exit code.

## License

MIT — see [LICENSE](./LICENSE).
