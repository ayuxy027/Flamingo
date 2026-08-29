# website

The flamingo site: a landing page and a deliberately broken demo app.

Plain static HTML with no build step and no dependencies, which keeps the
repository's zero-dependency claim true everywhere — including here. Vercel
serves it as-is: point a project at this directory, no framework preset needed.

```
index.html    landing page, five sections
demo.html     the demo app, every fault in it planted on purpose
assets/       mascot artwork, WebP with alpha
```

Artwork is WebP for size (1.5MB of PNG became 284KB) with one PNG kept for the
favicon and social preview. Note that WebKit screenshots omit WebP with alpha, so
capture this site with `--backend chrome`.

Locally:

```bash
bun run website          # from the repository root, serves on :8080
```

Then point the tool at its own demo:

```bash
bun run flamingo.ts crawl    http://localhost:8080/demo.html
bun run flamingo.ts interact http://localhost:8080/demo.html
bun run flamingo.ts stress   http://localhost:8080/demo.html --targets 6
```

Both pages are checked by flamingo itself — no console errors, no layout
overflow from 375px to 1440px, and every control wired.
