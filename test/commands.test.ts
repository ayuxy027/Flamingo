import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Engine } from "../flamingo.ts";
import { serveApp } from "./app.ts";

let server: ReturnType<typeof serveApp>;
let url: string;

beforeAll(() => {
  server = serveApp();
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => server.stop(true));

async function cli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", "flamingo.ts", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

describe("scroll: mapping a page taller than the viewport", () => {
  test("maps the whole page, not just the first viewport", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const viewport = (await e.getInteractiveTree()).interactiveElements.length;
    const map = await e.scrollScan();

    expect(map.elementCount).toBeGreaterThan(viewport);
    expect(map.reachedBottom).toBe(true);
    const refs = map.elements.map((x) => x.ref);
    expect(refs).toContain("button#cta");
    expect(refs).toContain("input#email");
    expect(refs).toContain("button#danger");
  }, 90_000);

  test("detects lazy loading and the pinned header", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const map = await e.scrollScan();
    expect(map.lazyLoaded).toBe(true);
    expect(map.pageHeight).toBeGreaterThan(map.initialPageHeight);
    expect(map.sticky.map((s: any) => s.ref)).toContain("header#topnav");
  }, 90_000);

  test("outline is ordered by document position and free of pinned chrome", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const { outline } = await e.scrollScan();
    const texts = outline.map((o: any) => o.text);
    expect(texts).toContain("Welcome");
    expect(texts).toContain("Pricing");
    const ys = outline.map((o: any) => o.documentY);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(outline.filter((o: any) => o.ref === "header#topnav").length).toBeLessThanOrEqual(1);
  }, 90_000);

  test("every control is recorded exactly once", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const refs = (await e.scrollScan()).elements.map((x) => x.ref);
    expect(new Set(refs).size).toBe(refs.length);
  }, 90_000);
});

describe("interact: exercising a whole page", () => {
  test("finds a field that silently discards what is typed into it", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const r = await e.interact({ dwellMs: 300 });
    const zip = r.rejectedInput.find((x: any) => x.ref === "input#zip");
    expect(zip).toBeDefined();
    expect(zip!.value).toBe("");
    expect(r.results.find((x: any) => x.ref === "input#email")!.status).toBe("alive");
  }, 180_000);

  test("finds the unwired buttons and clears the wired ones", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const r = await e.interact({ dwellMs: 300 });
    const dead = r.dead.map((d: any) => d.ref);
    expect(dead).toContain("button#deadcta");
    expect(dead).toContain("button#lazybtn");
    expect(dead).not.toContain("button#cta");
    expect(dead).not.toContain("button#busy");
  }, 180_000);

  test("refuses to touch a destructive control, and says so", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const r = await e.interact({ dwellMs: 300 });
    const danger = r.skipped.find((x: any) => x.ref === "button#danger");
    expect(danger).toBeDefined();
    expect(danger!.reason).toBe("destructive-label");
    expect(r.results.some((x: any) => x.ref === "button#danger")).toBe(false);
  }, 180_000);

  test("inspects a <select> without clicking it", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const r = await e.interact({ dwellMs: 300 });
    const sel = r.inspected.find((x: any) => x.ref === "select#plan") as any;
    expect(sel.reason).toBe("native-picker");
    expect(sel.options).toEqual(["basic", "pro"]);
  }, 180_000);
});

describe("stress: hostile interaction patterns", () => {
  test("finds a re-entrancy bug that a single click cannot", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const r = await e.stressTest({ maxTargets: 6 });

    const rapid = r.scenarios.find((s: any) => s.name === "rapid-click" && s.target === "button#busy") as any;
    expect(rapid).toBeDefined();
    expect(rapid.errorsTriggered).toBeGreaterThan(0);
    expect(rapid.errors.join(" ")).toContain("re-entrant submit");

    const single = await e.detectDeadClicks({ x: 1, y: 1, timeoutMs: 50 });
    expect(single).toBeDefined();
  }, 300_000);

  test("every scenario actually runs; a scenario that throws is not a pass", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const r = await e.stressTest({ maxTargets: 2 });
    expect(r.scenarios.length).toBeGreaterThan(0);
    expect(r.scenariosFailedToRun).toBe(0);
    for (const s of r.scenarios) expect(s.ran).toBe(true);
  }, 300_000);

  test("the page's own boot errors are not reported as findings", async () => {
    using e = await Engine.open({ width: 1280, height: 800, url });
    const r = await e.stressTest({ maxTargets: 2 });
    const all = r.scenarios.flatMap((s: any) => s.errors ?? []);
    expect(all.some((t: string) => t.includes("app boot"))).toBe(false);
  }, 300_000);
});

describe("CLI exit codes for the new commands", () => {
  test("scroll succeeds, interact and stress report problems", async () => {
    const scroll = await cli("scroll", url, "--json");
    expect(scroll.exitCode).toBe(0);
    expect(JSON.parse(scroll.stdout).reachedBottom).toBe(true);

    const interact = await cli("interact", url, "--json", "--dwell", "300");
    expect(interact.exitCode).toBe(1);
    expect(JSON.parse(interact.stdout).dead.length).toBeGreaterThan(0);

    const stress = await cli("stress", url, "--json", "--targets", "6");
    expect(stress.exitCode).toBe(1);
    expect(JSON.parse(stress.stdout).totalErrors).toBeGreaterThan(0);
  }, 600_000);
});
