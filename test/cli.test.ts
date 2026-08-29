import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { serveFixture } from "./fixture.ts";

let server: ReturnType<typeof serveFixture>;
let base: string;

beforeAll(() => {
  server = serveFixture();
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function cli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", "flamingo.ts", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("usage surface", () => {
  test("--version prints just the version", async () => {
    const r = await cli("--version");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("no arguments prints usage and exits 2", async () => {
    const r = await cli();
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("USAGE");
  });

  test("--help exits 0", async () => {
    const r = await cli("audit", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("EXIT CODES");
  });

  test("unknown command exits 2 with the error on stderr", async () => {
    const r = await cli("frobnicate", base);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown command");
    expect(r.stdout).toBe("");
  });

  test("missing url exits 2", async () => {
    const r = await cli("audit");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("needs a URL");
  });

  test("malformed url exits 2", async () => {
    const r = await cli("audit", "not-a-url");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Not a valid URL");
  });

  test("bad --backend exits 2", async () => {
    const r = await cli("audit", base, "--backend", "firefox");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/webkit.*chrome/);
  });

  test("bad --viewports exits 2", async () => {
    const r = await cli("responsive", base, "--viewports", "wide");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("WIDTHxHEIGHT");
  });

  test("non-numeric --width exits 2", async () => {
    const r = await cli("audit", base, "--width", "big");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("expects a number");
  });
});

describe("exit codes reflect findings", () => {
  test("audit of a broken page exits 1", async () => {
    const r = await cli("audit", `${base}/`, "--json");
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).success).toBe(false);
  }, 60_000);

  test("audit of a clean page exits 0", async () => {
    const r = await cli("audit", `${base}/clean`, "--json");
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.success).toBe(true);
    expect(report.totalErrors).toBe(0);
  }, 60_000);

  test("responsive exits 1 when a viewport overflows, 0 when none do", async () => {
    const bad = await cli("responsive", `${base}/`, "--viewports", "375x812", "--json");
    expect(bad.exitCode).toBe(1);
    const ok = await cli("responsive", `${base}/clean`, "--viewports", "375x812", "--json");
    expect(ok.exitCode).toBe(0);
  }, 90_000);
});

describe("--json output contract", () => {
  test("stdout is exactly one JSON document, diagnostics go to stderr", async () => {
    const r = await cli("audit", `${base}/`, "--json");
    // must parse whole — no progress lines, no ANSI, nothing else on stdout
    const parsed = JSON.parse(r.stdout);
    expect(parsed.targetUrl).toContain(base);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stdout).not.toContain("\x1b[");
  }, 60_000);

  test("human output is colour-free when piped", async () => {
    const r = await cli("tree", `${base}/`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("\x1b[");
    expect(r.stdout).toContain("button#live");
  }, 60_000);

  test("tree --json reports coordinates", async () => {
    const r = await cli("tree", `${base}/`, "--json", "--max", "5");
    const tree = JSON.parse(r.stdout);
    expect(tree.interactiveElements[0].center).toHaveProperty("x");
  }, 60_000);
});

test("shot writes the file it reports", async () => {
  const out = ".flamingo/cli-test.png";
  const r = await cli("shot", `${base}/clean`, "--out", out, "--json");
  expect(r.exitCode).toBe(0);
  const shot = JSON.parse(r.stdout);
  expect(await Bun.file(shot.path).exists()).toBe(true);
  expect(shot.sizeInBytes).toBeGreaterThan(0);
}, 60_000);

test("crawl exits 1 and names the dead control", async () => {
  const r = await cli("crawl", `${base}/`, "--json", "--dwell", "300");
  expect(r.exitCode).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.dead.map((d: any) => d.ref)).toContain("button#dud");
  expect(out.alive).toBeGreaterThan(0);
}, 120_000);

test("crawl exits 0 when every control responds", async () => {
  const r = await cli("crawl", `${base}/clean`, "--json", "--dwell", "300");
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).dead).toHaveLength(0);
}, 90_000);

describe("self-describing surface (what an agent needs after install)", () => {
  test("doctor reports the environment and exits 0 when usable", async () => {
    const r = await cli("doctor");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("bun");
    expect(r.stdout).toContain("webkit");
    expect(r.stdout).toContain("chrome");
  }, 30_000);

  test("doctor --json is a single machine-readable document", async () => {
    const r = await cli("doctor", "--json");
    const d = JSON.parse(r.stdout);
    expect(d.ok).toBe(true);
    expect(d.bun.ok).toBe(true);
    expect(d.backends.webkit).toHaveProperty("available");
    expect(d.backends.chrome).toHaveProperty("path");
  }, 30_000);

  test("schema describes every tool and command well enough to call them blind", async () => {
    const r = await cli("schema");
    expect(r.exitCode).toBe(0);
    const d = JSON.parse(r.stdout);

    expect(d.tools.length).toBeGreaterThanOrEqual(16);
    expect(d.commands.length).toBeGreaterThanOrEqual(8);
    expect(d.exitCodes["1"]).toBeDefined();

    for (const t of d.tools) {
      expect(t.name).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
    for (const c of d.commands) {
      expect(c.summary.length).toBeGreaterThan(10);
      expect(c.exits).toBeTruthy();
      expect(Array.isArray(c.examples)).toBe(true);
      expect(c.examples.length).toBeGreaterThan(0);
    }
    // the chrome-only surface must be discoverable, not learned by hitting an error
    expect(d.backends.chromeOnly.join(" ")).toContain("interceptTraffic");
  }, 30_000);

  test("every command has its own help, distinct from the global help", async () => {
    const { stdout: global } = await cli("--help");
    const names = JSON.parse((await cli("schema")).stdout).commands.map((c: any) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(8);

    for (const name of names) {
      const r = await cli(name, "--help");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("DESCRIPTION");
      expect(r.stdout).toContain("EXIT CODES");
      expect(r.stdout).toContain("EXAMPLES");
      expect(r.stdout).not.toBe(global);
    }
  }, 60_000);

  test("the published bin is executable and has a bun shebang", async () => {
    const pkg = await Bun.file("package.json").json();
    const binPath = Object.values(pkg.bin)[0] as string;
    const file = Bun.file(binPath);
    expect(await file.exists()).toBe(true);
    expect((await file.text()).startsWith("#!/usr/bin/env bun")).toBe(true);
    // everything the manifest promises to publish must actually be there
    for (const f of pkg.files) expect(await Bun.file(f).exists()).toBe(true);
  });
});
