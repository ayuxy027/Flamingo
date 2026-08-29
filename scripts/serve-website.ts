#!/usr/bin/env bun
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "..", "website");
const port = Number(Bun.argv[2] ?? 8080);

const server = Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    const file = Bun.file(join(root, rel));
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  },
});

console.log(`website  http://localhost:${server.port}`);
console.log(`demo     http://localhost:${server.port}/demo.html\n`);
console.log(`Point flamingo at it:`);
console.log(`  bun run flamingo.ts crawl  http://localhost:${server.port}/demo.html`);
console.log(`  bun run flamingo.ts stress http://localhost:${server.port}/demo.html --targets 6`);
