# website

The flamingo site: a landing page and a deliberately broken demo app.

Plain static HTML with no build step and no runtime dependencies, which keeps the
repository's zero-dependency claim true everywhere, including here. Vercel serves
it as-is: point a project at this directory, no framework preset needed.

```
index.html    landing page: hero, the loop, size, findings
demo.html     the demo app, every fault in it planted on purpose
assets/       mascot artwork, WebP with alpha (9 files, 344K) + one PNG favicon
```

Artwork is WebP with straight alpha so it sits on any background, light or dark.
One 256px PNG is kept alongside it for the favicon and the social preview, since
those consumers cannot be relied on to accept WebP.

## Screenshotting this site

WebKit decodes WebP with alpha correctly, but `flamingo shot` captures as soon as
the page reports loaded, which can be before those images have painted. An empty
image box in a screenshot is a timing artifact, not a missing format. Drive the
engine and wait if you need them:

```ts
await using e = await Engine.open({ url, reducedMotion: false });
await Bun.sleep(1500);
await e.captureViewport({ path: "shot.png" });
```

The landing page also animates in with GSAP, which needs the same wait. It
degrades to fully visible content if GSAP fails to load or the reader prefers
reduced motion.

## Locally

```bash
bun run website          # from the repository root, serves on :8080
```

Then point the tool at its own demo:

```bash
bun run flamingo.ts crawl    http://localhost:8080/demo.html
bun run flamingo.ts interact http://localhost:8080/demo.html
bun run flamingo.ts stress   http://localhost:8080/demo.html --targets 6
```

The landing page is checked by flamingo itself: no console errors, no broken
assets, and no horizontal overflow from 375px to 1440px. The demo app is expected
to fail those checks, which is the point of it.
