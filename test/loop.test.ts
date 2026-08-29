import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Engine } from "../flamingo.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const APP = `<!doctype html><body style="margin:0;font:14px system-ui">
<div id="wall" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9"></div>
<button id="accept" style="position:fixed;top:20px;left:20px;width:120px;height:36px;z-index:10">Accept</button>
<button id="start" style="position:absolute;top:100px;left:20px;width:120px;height:36px">Start</button>
<button id="boom" style="position:absolute;top:160px;left:20px;width:120px;height:36px">Boom</button>
<div id="result"></div>
<script>
  document.getElementById('accept').onclick = () => document.getElementById('wall').remove();
  document.getElementById('start').onclick = () => { document.getElementById('result').textContent = 'Task complete'; };
  document.getElementById('boom').onclick = () => { throw new Error("handler exploded"); };
</script></body>`;

let server: ReturnType<typeof Bun.serve>;
let url: string;
beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response(APP, { headers: { "content-type": "text/html" } }) });
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => server.stop(true));

describe("observe — one step of the agent loop", () => {
  test("reports only reachable controls, and names what blocks the rest", async () => {
    using e = await Engine.open({ width: 800, height: 400, url });
    const o = await e.observe();
    expect(o.elements.map((x) => x.ref)).toEqual(["button#accept"]);
    expect(o.blockedBy[0]!.ref).toBe("div#wall");
    expect(o.url).toBe(url);
  }, 60_000);

  test("changed distinguishes a real effect from a no-op", async () => {
    using e = await Engine.open({ width: 800, height: 400, url });
    await e.observe();

    const accept = (await e.observe()).elements[0]!;
    await e.clickCoordinate({ x: accept.center.x, y: accept.center.y });
    expect((await e.observe()).changed).toBe(true);

    // nothing done between these two looks
    await e.observe();
    expect((await e.observe()).changed).toBe(false);
  }, 60_000);

  test("detects a change that touches no interactive element", async () => {
    using e = await Engine.open({ width: 800, height: 400, url });
    await e.observe();
    const accept = (await e.observe()).elements[0]!;
    await e.clickCoordinate({ x: accept.center.x, y: accept.center.y });

    const before = await e.observe();
    const start = before.elements.find((x) => x.ref === "button#start")!;
    await e.clickCoordinate({ x: start.center.x, y: start.center.y });

    // clicking Start only writes text into a <div> — no control appears or moves,
    // so without a content fingerprint this would wrongly read as a no-op
    expect((await e.observe()).changed).toBe(true);
  }, 60_000);

  test("newErrors is a delta, not a running total", async () => {
    using e = await Engine.open({ width: 800, height: 400, url });
    await e.observe();
    const accept = (await e.observe()).elements[0]!;
    await e.clickCoordinate({ x: accept.center.x, y: accept.center.y });

    const boom = (await e.observe()).elements.find((x) => x.ref === "button#boom")!;
    await e.clickCoordinate({ x: boom.center.x, y: boom.center.y });
    await Bun.sleep(200);

    const withError = await e.observe();
    expect(withError.newErrors.join(" ")).toContain("handler exploded");
    // the same error must not be reported again on the next look
    expect((await e.observe()).newErrors).toHaveLength(0);
  }, 60_000);
});

describe("init — wiring a project up", () => {
  const run = async (dir: string, ...args: string[]) => {
    const proc = Bun.spawn(["bun", "run", "flamingo.ts", "init", "--dir", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  };

  test("creates an MCP entry and a skill, and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flamingo-init-"));
    try {
      const first = await run(dir);
      expect(first.exitCode).toBe(0);
      expect(existsSync(join(dir, ".mcp.json"))).toBe(true);

      const skill = join(dir, ".claude", "skills", "flamingo", "SKILL.md");
      expect(existsSync(skill)).toBe(true);
      const text = readFileSync(skill, "utf8");
      expect(text.startsWith("---\nname: flamingo\n")).toBe(true);
      expect(text).toContain("description:");
      // the skill must teach the loop, not just list tools
      expect(text).toContain("changed: false");

      const second = await run(dir);
      expect(second.stdout).toContain("kept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("merges into an existing .mcp.json instead of overwriting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flamingo-init-"));
    try {
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { existing: { command: "keep-me" } } }));
      await run(dir);
      const cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      expect(cfg.mcpServers.existing.command).toBe("keep-me");
      expect(cfg.mcpServers.flamingo.args).toContain("serve");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("refuses to guess at a malformed .mcp.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flamingo-init-"));
    try {
      writeFileSync(join(dir, ".mcp.json"), "{ this is not json");
      const r = await run(dir);
      expect(r.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("--force replaces an existing entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flamingo-init-"));
    try {
      mkdirSync(join(dir, ".claude", "skills", "flamingo"), { recursive: true });
      writeFileSync(join(dir, ".claude", "skills", "flamingo", "SKILL.md"), "stale");
      const r = await run(dir, "--force");
      expect(r.stdout).toContain("updated");
      expect(readFileSync(join(dir, ".claude", "skills", "flamingo", "SKILL.md"), "utf8")).toContain("name: flamingo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
