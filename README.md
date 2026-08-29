# 🦩 flamingo

**AI Native Frontend Testing Toolkit: a browser your agent drives in a loop.**

One file. Zero runtime dependencies. Bun only. See [`STDLIB.md`](./STDLIB.md) for the proof.

```bash
npx flamingo init          # wires your agent (MCP + skill)
bunx flamingo doctor       # check your setup
flamingo crawl http://localhost:3000
```

```
14 controls found, 14 tested
  ✓ 12 responded
  ✗ 2 dead
    ✗ button#checkout "Checkout"  blocked by div.modal-backdrop
    ✗ a.help "Help"               no handler fired
```

That's it. Every control clicked, dead ones named with why.

---

## Install

```bash
npx flamingo init              # or bunx
bun add @ayuxy027/flamingo     # library / CLI
```

`init` writes two things and nothing else:

* `.mcp.json`: MCP server entry (merged, not overwritten)
* `.claude/skills/flamingo/SKILL.md`: the loop, coordinates, gotchas

Restart your agent, ask it to *"check localhost:3000 for dead buttons"*.

## The loop

```
observe → act → observe
```

Every action returns the new page state. Every observation tells you what changed.

```ts
import { Engine } from "@ayuxy027/flamingo";

await using e = await Engine.open({ url: "http://localhost:3000" });

let s = await e.observe();
while (!done(s)) {
  const btn = s.elements.find(e => e.text === "Continue");
  if (!btn) break;
  await e.clickCoordinate(btn.center);
  s = await e.observe();
  if (!s.changed) break; // did nothing, try something else
}
```

`observe()` is tiny: only what's clickable, with coordinates. `changed`, `newErrors`, `newFailedRequests` are deltas since last time.

## CLI

```
flamingo audit <url>       health report: console, broken assets, overflow
flamingo crawl <url>       click every control, report dead ones
flamingo tree <url>        clickable elements + coordinates
flamingo scroll <url>      walk the whole page, merged map
flamingo interact <url>    scroll + click + type into fields
flamingo stress <url>      hostile patterns, finds race conditions
flamingo responsive <url>  overflow across viewports
flamingo shot <url>        screenshot
flamingo doctor            env check
flamingo init              wire into project
flamingo schema            full API as JSON (for agents)
flamingo serve             MCP server on stdio
```

```bash
flamingo crawl http://localhost:3000 --max 30 --dwell 800
flamingo audit http://localhost:3000 --json | jq .details
flamingo schema | jq '.tools[].name'
```

All commands support `--json` (one JSON to stdout, nothing else), `--backend webkit|chrome`, `--width`/`--height`, `--profile <dir>` to keep cookies between runs. `flamingo <cmd> --help` for flags.

Exit codes: `0` ok, `1` problems found (for CI), `2` usage, `3` runtime.

## Library

```ts
import { Engine } from "@ayuxy027/flamingo";

await using e = await Engine.open({ url: "http://localhost:3000" });
await e.goto("http://localhost:3000/pricing");
await e.clickCoordinate({ x: 140, y: 220 });
await e.typeInput({ text: "hello@example.com" });
await e.waitFor({ textContains: "Saved" });

const { interactiveElements } = await e.getInteractiveTree();
const r = await e.compileHealthReport();
```

Full methods: [`docs/api.md`](./docs/api.md). Key ones: `observe`, `getInteractiveTree`, `clickCoordinate`, `typeInput`, `pressKey`, `scroll`, `detectPointerBlocker`, `detectDeadClicks`, `crawl`, `scrollScan`, `interact`, `stressTest`, `captureViewport`, `auditResponsiveness`, `compileHealthReport`, `waitFor`/`waitForGone`.

## MCP

Your agent calls tools, not CLI. Hand-written JSON-RPC, no SDK.

```json
{ "mcpServers": { "flamingo": { "command": "bunx", "args": ["flamingo", "serve"] } } }
```

`flamingo init` does this for you. See [`docs/mcp-tools.md`](./docs/mcp-tools.md) for 24 tools.

## Backends

| | `webkit` (default) | `chrome` |
|---|---|---|
| Install | none, system WebKit (macOS) | needs Chrome/Chromium/Brave |
| Works everywhere | macOS only | any OS |
| `hover`, network status | no (errors tell you the fix) | yes |

On `webkit`, `detectDeadClicks` returns `registeredNetworkRequests: null`, which means not measured, not zero.

## Docs

* [`docs/cli.md`](./docs/cli.md): CLI flags + examples
* [`docs/api.md`](./docs/api.md): library API
* [`docs/mcp-tools.md`](./docs/mcp-tools.md): MCP tools + schemas
* [`docs/internals.md`](./docs/internals.md): gotchas we hit (select hangs, poisoned nav, etc.)
* [`STDLIB.md`](./STDLIB.md): 17 packages replaced, how
* `flamingo --help`, `flamingo schema`: everything machine-readable

```bash
bun run build          # -> dist/flamingo (61MB standalone)
bun run proof          # zero-deps check
bun test               # 122 tests, real browser
```

## License

MIT, see [LICENSE](./LICENSE)
