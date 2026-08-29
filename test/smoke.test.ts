import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Engine } from "../flamingo.ts";
import { serveFixture } from "./fixture.ts";

let server: ReturnType<typeof serveFixture>;
let url: string;

beforeAll(() => {
  server = serveFixture();
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => server.stop(true));

// Every API that does not need CDP must behave identically on both backends.
for (const backend of ["webkit", "chrome"] as const) {
  describe(backend, () => {
    let e: Engine;

    beforeAll(async () => {
      e = await Engine.open({ backend, width: 800, height: 600, url });
    });
    afterAll(() => e?.close());

    test("goto loaded the page", () => {
      expect(e.view.title).toBe("flamingo fixture");
    });

    test("the requested viewport is the actual CSS viewport", async () => {
      const vp = await e.view.evaluate<{ w: number; h: number }>("({w:innerWidth,h:innerHeight})");
      expect(vp).toEqual({ w: 800, h: 600 });
    });

    test("console buffer holds the load-time error (capture began before navigation)", async () => {
      const { consoleLogs, errors } = await e.captureRuntimeLogs();
      expect(errors).toBeGreaterThan(0);
      expect(consoleLogs.some((l) => l.text.includes("boom: load-time failure"))).toBe(true);
    });

    test("getInteractiveTree finds the live button and excludes the occluded one", async () => {
      const { interactiveElements, occluded } = await e.getInteractiveTree();
      const refs = interactiveElements.map((i: any) => i.ref);
      expect(refs).toContain("button#live");
      expect(refs).not.toContain("button#under");
      expect(occluded).toBeGreaterThan(0);
      // the point of the API: a compact payload, not a DOM dump
      expect(interactiveElements.length).toBeLessThan(10);
    });

    test("tree centers are usable click coordinates", async () => {
      const { interactiveElements } = await e.getInteractiveTree();
      const live = interactiveElements.find((i) => i.ref === "button#live");
      expect(live!.center).toEqual({ x: 60, y: 30 });
    });

    test("detectPointerBlocker names the backdrop covering #under", async () => {
      const r = await e.detectPointerBlocker({ x: 60, y: 120 });
      expect(r.isBlocked).toBe(true);
      expect(r.intendedElement).toBe("button#under");
      expect(r.blockingElement).toBe("div#backdrop");
    });

    test("detectPointerBlocker reports an unobstructed button as reachable", async () => {
      const r = await e.detectPointerBlocker({ x: 60, y: 30 });
      expect(r.isBlocked).toBe(false);
      expect(r.intendedElement).toBe("button#live");
    });

    test("detectDeadClicks: false on a button that mutates the DOM", async () => {
      const r = await e.detectDeadClicks({ x: 60, y: 30, timeoutMs: 400 });
      expect(r.registeredDOMChanges).toBeGreaterThan(0);
      expect(r.isDeadClick).toBe(false);
    });

    test("detectDeadClicks: true on an inert div", async () => {
      const r = await e.detectDeadClicks({ x: 60, y: 220, timeoutMs: 400 });
      expect(r.isDeadClick).toBe(true);
      expect(r.registeredDOMChanges).toBe(0);
    });

    test("typeInput lands text via the fast insertText path", async () => {
      await e.clickCoordinate({ x: 110, y: 295 });
      await e.typeInput({ text: "user@example.com" });
      expect(await e.view.evaluate<string>("document.getElementById('field').value")).toBe("user@example.com");
    });

    test("typeInput with realKeys fires per-character keydown events", async () => {
      await e.view.evaluate(
        "(()=>{const f=document.getElementById('field');f.value='';f.focus();window.__k=0;f.addEventListener('keydown',()=>window.__k++);return 1})()",
      );
      const r = await e.typeInput({ text: "ab@c", realKeys: true });
      expect(r.mode).toBe("keyEvents");
      expect(await e.view.evaluate<string>("document.getElementById('field').value")).toBe("ab@c");
      expect(await e.view.evaluate<number>("window.__k")).toBe(4);
    });

    test("captureViewport writes a file and reports the CSS-to-pixel scale", async () => {
      const shot = await e.captureViewport({ path: `.flamingo/test-${backend}.png` });
      expect(shot.sizeInBytes).toBeGreaterThan(0);
      expect(await Bun.file(shot.path).exists()).toBe(true);
      // chrome sizes the outer window, webkit the viewport; open() normalizes both
      expect(shot.cssSize).toEqual({ width: 800, height: 600 });
      // the trap this field exists to prevent: image pixels != click coordinates
      expect(shot.pixelSize.width).toBe(shot.cssSize.width * shot.deviceScaleFactor);
      expect(shot.pixelSize.height).toBe(shot.cssSize.height * shot.deviceScaleFactor);
      expect(shot).not.toHaveProperty("base64");
    });

    test("auditResponsiveness flags the narrow viewport only", async () => {
      const { violations } = await e.auditResponsiveness({
        viewports: [
          { width: 1920, height: 1080 },
          { width: 375, height: 812 },
        ],
      });
      expect(violations.map((v: any) => v.viewport)).toEqual(["375x812"]);
      expect(violations[0]!.offenders[0]!.elementSelector).toBe("div#wide");
    });

    test("scanBrokenAssets finds the 404 image", async () => {
      const { brokenAssets, statusCodesAvailable } = await e.scanBrokenAssets();
      const img = brokenAssets.find((a: any) => a.source.endsWith("/missing.png"));
      expect(img).toBeDefined();
      expect(statusCodesAvailable).toBe(backend === "chrome");
      // status codes live in the network layer, so only chrome can report them
      if (backend === "chrome") expect((img as any).status).toBe(404);
      else expect(img).not.toHaveProperty("status");
    });

    test("compileHealthReport totals match its parts", async () => {
      const r = await e.compileHealthReport({ viewports: [{ width: 375, height: 812 }] });
      expect(r.success).toBe(false);
      const d = r.details;
      expect(r.totalErrors).toBe(d.consoleErrors + d.brokenAssets + d.deadClicks + d.overflowLayouts);
      expect(d.consoleErrors).toBeGreaterThan(0);
      expect(d.brokenAssets).toBeGreaterThan(0);
      expect(d.overflowLayouts).toBe(1);
    });
  });
}

describe("backend capability boundary", () => {
  test("CDP-only APIs fail on webkit with an actionable message", async () => {
    using e = await Engine.open({ backend: "webkit", url });
    expect(e.interceptTraffic()).rejects.toThrow(/requires backend: "chrome"/);
    expect(e.hoverCoordinate({ x: 1, y: 1 })).rejects.toThrow(/requires backend: "chrome"/);
  });

  test("CDP-only APIs work on chrome", async () => {
    using e = await Engine.open({ backend: "chrome", url });
    const { traffic } = await e.interceptTraffic();
    expect(traffic.length).toBeGreaterThan(0);
    expect(traffic.some((t) => t.url.endsWith("/missing.png") && t.status === 404)).toBe(true);
    await e.hoverCoordinate({ x: 60, y: 30 });
  });

  test("network buffer captured the load-time 404 (enabled before navigation)", async () => {
    using e = await Engine.open({ backend: "chrome", url });
    const { traffic } = await e.interceptTraffic({ filterUrlPattern: "missing\\.png" });
    expect(traffic).toHaveLength(1);
    expect(traffic[0].status).toBe(404);
  });
});

describe("crawl", () => {
  test("finds the dead control and clears the wired ones", async () => {
    using e = await Engine.open({ backend: "webkit", width: 800, height: 600, url });
    const r = await e.crawl({ dwellMs: 300 });

    // button#live mutates the DOM; input#field takes focus. Both are alive.
    expect(r.alive).toBeGreaterThanOrEqual(2);
    // button#dud has no handler and only takes focus, which does not count.
    const refs = r.dead.map((d: any) => d.ref);
    expect(refs).toContain("button#dud");
    expect(refs).not.toContain("button#live");
    expect(refs).not.toContain("input#field");
  }, 90_000);

  test("a click swallowed by an overlay is reported as blocked, not merely dead", async () => {
    using e = await Engine.open({ backend: "webkit", width: 800, height: 600, url });
    // #under sits beneath the backdrop, so the tree omits it; drive the coordinate directly.
    const clicked = await e.detectDeadClicks({ x: 60, y: 120, timeoutMs: 300 });
    expect(clicked.isDeadClick).toBe(true);
    const why = await e.detectPointerBlocker({ x: 60, y: 120 });
    expect(why.isBlocked).toBe(true);
    expect(why.blockingElement).toBe("div#backdrop");
  }, 60_000);

  test("clicking a text field counts as a live response", async () => {
    using e = await Engine.open({ backend: "webkit", width: 800, height: 600, url });
    const r = await e.detectDeadClicks({ x: 110, y: 295, timeoutMs: 300 });
    expect(r.focusChanged).toBe(true);
    expect(r.isDeadClick).toBe(false);
  }, 60_000);
});
