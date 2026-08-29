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
  const proc = Bun.spawn(["bun", "run", "nodep.ts", ...args], { stdout: "pipe", stderr: "pipe" });
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
  const out = ".nodep/cli-test.png";
  const r = await cli("shot", `${base}/clean`, "--out", out, "--json");
  expect(r.exitCode).toBe(0);
  const shot = JSON.parse(r.stdout);
  expect(await Bun.file(shot.path).exists()).toBe(true);
  expect(shot.sizeInBytes).toBeGreaterThan(0);
}, 60_000);
