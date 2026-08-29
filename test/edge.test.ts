import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Engine } from "../flamingo.ts";

// Each case here corresponds to a bug found by driving a real browser hard.
const PAGES: Record<string, string> = {
  shadow: `<div id="host"></div><script>
    const r = document.getElementById('host').attachShadow({mode:'open'});
    r.innerHTML = '<button id="inner" style="width:90px;height:36px">Shadow</button>';</script>`,
  select: `<select id="plan" style="width:120px;height:30px"><option>a</option><option>b</option></select>
    <button id="after" style="width:90px;height:36px">After</button>`,
  dialog: `<button id="c" style="width:90px;height:36px">Confirm</button>
    <script>window.__answer = "unset";
      document.getElementById('c').onclick = () => { window.__answer = confirm("delete everything?"); };</script>`,
  spa: `<button id="nav" style="width:90px;height:36px">Push</button>
    <script>document.getElementById('nav').onclick = () => history.pushState({}, '', '/pushed');</script>`,
  reject: `<button id="boom" style="width:90px;height:36px">Boom</button>
    <script>document.getElementById('boom').onclick = async () => { throw new Error("async explosion"); };</script>`,
  throws: `<button id="sync" style="width:90px;height:36px">Sync</button>
    <script>document.getElementById('sync').onclick = () => { null.x; };</script>`,
  headings: `<h1>Features   and
    Testimonials</h1><button id="b" style="width:80px;height:30px">B</button>`,
  frames: `<iframe srcdoc="<button>inner</button>" style="width:200px;height:80px"></iframe>
    <button id="outer" style="width:90px;height:36px">Outer</button>`,
  tall: `<div style="height:2400px"></div><button id="deep" style="width:90px;height:36px">Deep</button>`,
  partial: `<div style="height:760px"></div>
    <button id="straddle" style="width:90px;height:120px">Straddle</button>
    <div style="height:1600px"></div>`,
};

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1) || "shadow";
      const body = PAGES[name];
      if (body === undefined) return new Response("nf", { status: 404 });
      return new Response(`<!doctype html><html><head><title>${name}</title></head><body style="margin:0">${body}</body></html>`,
        { headers: { "content-type": "text/html" } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe("elements the naive implementation cannot see", () => {
  test("shadow DOM is pierced", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/shadow` });
    const { interactiveElements } = await e.getInteractiveTree();
    const inner = interactiveElements.find((x) => x.ref === "button#inner");
    expect(inner).toBeDefined();
    expect(inner!.inShadowDom).toBe(true);
  }, 60_000);

  test("iframes are reported even though their contents cannot be reached", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/frames` });
    const tree = await e.getInteractiveTree();
    // Honest reporting matters: an agent must not conclude the page is empty.
    expect(tree.frames.length).toBe(1);
    expect(tree.interactiveElements.map((x) => x.ref)).toContain("button#outer");
  }, 60_000);

  test("below-the-fold controls are invisible to the tree but found by scrollScan", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/tall` });
    expect((await e.getInteractiveTree()).interactiveElements).toHaveLength(0);
    const map = await e.scrollScan();
    expect(map.elements.map((x) => x.ref)).toContain("button#deep");
    expect(map.reachedBottom).toBe(true);
  }, 60_000);
});

describe("hazards that used to hang or mislead", () => {
  test("a <select> is flagged and never clicked — clicking one blocks the renderer", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/select` });
    const tree = await e.getInteractiveTree();
    expect(tree.interactiveElements.find((x) => x.ref === "select#plan")!.nativePicker).toBe(true);

    // If crawl clicked it, this would never return.
    const started = Date.now();
    const r = await e.crawl({ dwellMs: 200 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.dead.map((d: any) => d.ref)).not.toContain("select#plan");
  }, 60_000);

  test("a navigation that never completes times out, and the engine recovers", async () => {
    const dead = Bun.serve({ port: 0, async fetch() { await new Promise(() => {}); return new Response("x"); } });
    try {
      using e = await Engine.open({ width: 400, height: 300 });
      const g = await e.goto(`http://127.0.0.1:${dead.port}/`, { timeoutMs: 2000 });
      expect(g.timedOut).toBe(true);
      // A pending navigation poisons the view; the next goto must rebuild it.
      const back = await e.goto(`${base}/shadow`);
      expect(back.recovered).toBe(true);
      expect((await e.getInteractiveTree()).interactiveElements.length).toBeGreaterThan(0);
    } finally {
      dead.stop(true);
    }
  }, 60_000);

  test("confirm() is answered negatively, and counts as a reaction not a dead click", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/dialog` });
    const r = await e.detectDeadClicks({ x: 45, y: 18, timeoutMs: 800 });
    expect(r.isDeadClick).toBe(false);
    expect(r.reason).toBe("dialog");
    expect(r.openedDialog).toBe(true);
    // Crawling an admin panel must not confirm destructive prompts.
    expect(await e.view.evaluate<boolean>("window.__answer")).toBe(false);
  }, 60_000);

  test("history.pushState is detected — it fires no load event", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/spa` });
    const r = await e.detectDeadClicks({ x: 45, y: 18, timeoutMs: 800 });
    expect(r.isDeadClick).toBe(false);
    expect(r.reason).toBe("spa-navigation");
    expect(r.spaNavigation).toBe(true);
  }, 60_000);
});

describe("errors the console option alone never sees", () => {
  test("unhandled promise rejections are captured", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/reject` });
    await e.detectDeadClicks({ x: 45, y: 18, timeoutMs: 600 });
    const { consoleLogs } = await e.captureRuntimeLogs({ type: "error" });
    expect(consoleLogs.some((l) => l.text.includes("async explosion"))).toBe(true);
  }, 60_000);

  test("uncaught synchronous errors are captured", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/throws` });
    await e.detectDeadClicks({ x: 45, y: 18, timeoutMs: 600 });
    const { consoleLogs } = await e.captureRuntimeLogs({ type: "error" });
    expect(consoleLogs.some((l) => l.text.includes("[uncaught]"))).toBe(true);
  }, 60_000);
});

describe("correctness of what gets reported", () => {
  test("heading text keeps its letters and collapses whitespace", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/headings` });
    const map = await e.scrollScan();
    const h = map.outline.find((o: any) => o.tag === "h1") as any;
    // A regex written as /\s+/ inside a template literal degrades to /s+/,
    // which silently replaced every "s" in the page with a space.
    expect(h.text).toBe("Features and Testimonials");
  }, 60_000);

  test("an element straddling the fold is recorded once, not once per scroll step", async () => {
    using e = await Engine.open({ width: 800, height: 600, url: `${base}/partial` });
    const map = await e.scrollScan();
    const hits = map.elements.filter((x) => x.ref === "button#straddle");
    // Identity must come from the unclipped document position, because the
    // viewport-clipped centre changes at every scroll offset.
    expect(hits).toHaveLength(1);
  }, 60_000);
});

describe("navigation primitives that can never resolve", () => {
  test("repeated goBack stays bounded and leaves the engine usable", async () => {
    // Bun 1.4.0 chrome: goBack() can never resolve once history runs out, and the
    // pending navigation it leaves poisons the view. The guarantee worth asserting
    // is boundedness — whether a given call times out is Bun's business, not ours.
    using e = await Engine.open({ backend: "chrome", width: 400, height: 300, url: `${base}/shadow` });
    const started = Date.now();
    for (let i = 0; i < 3; i++) await e.goBack({ timeoutMs: 3000 });
    expect(Date.now() - started).toBeLessThan(20_000);

    // whatever happened, the engine recovers and works
    await e.goto(`${base}/shadow`);
    expect((await e.getInteractiveTree()).interactiveElements.length).toBeGreaterThan(0);
  }, 90_000);

  test("stress completes on the chrome backend rather than hanging", async () => {
    using e = await Engine.open({ backend: "chrome", width: 800, height: 600, url: `${base}/spa` });
    const started = Date.now();
    const r = await e.stressTest({ maxTargets: 1, settleMs: 100 });
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(r.scenarios.length).toBeGreaterThan(0);
    // a scenario blocked by a browser limitation is reported, never silently passed
    for (const s of r.scenarios) {
      if (s.ran === false) expect(String(s.threw).length).toBeGreaterThan(0);
    }
  }, 180_000);

  test("reload is guarded the same way", async () => {
    using e = await Engine.open({ width: 400, height: 300, url: `${base}/shadow` });
    const r = await e.reload();
    expect(r.timedOut).toBe(false);
    expect((await e.getInteractiveTree()).interactiveElements.length).toBeGreaterThan(0);
  }, 60_000);
});
