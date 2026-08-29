#!/usr/bin/env bun
/**
 * flamingo — AI-native browser automation and frontend testing.
 *
 * Zero third-party runtime dependencies: the Bun standard library only. The
 * entire project — library, MCP server and CLI — is this one file.
 *
 * Bun.WebView (Bun >= 1.4) provides process lifecycle, the CDP transport, input
 * dispatch, screenshots and console capture. What this file adds is the layer an
 * agent actually needs: compact viewport-filtered element trees, click
 * diagnostics, dead-click detection, responsive auditing and a health report.
 *
 * Library:  import { Engine } from "./flamingo.ts"
 * CLI:      flamingo audit http://localhost:3000 --json
 * MCP:      flamingo serve --backend chrome
 *
 * @license MIT
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// =========================================================================
// SECTION 1 — Programs that run inside the page
//
// Bun.WebView.evaluate() takes an *expression* and serializes the result with
// JSON.stringify page-side, so each of these is an IIFE returning a plain
// object. One round trip each, no DOM node handles to release.
// =========================================================================

/** Renders an element as a short `tag#id.class` reference for report output. */
const DESCRIBE = `const describe = (el) => {
    if (!el) return null;
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList && el.classList.length) s += "." + [...el.classList].slice(0, 2).join(".");
    return s;
  };`;

/** What counts as "actionable" for an agent. */
const SELECTOR = `'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'`;

/**
 * Flat list of elements an agent can actually act on.
 *
 * The filtering is the whole point: without it a page with a mega-menu still
 * returns hundreds of entries and we are back to context exhaustion. Elements
 * are dropped when off-viewport, zero-size, styled invisible, or occluded by
 * something else at their own centre point.
 */
const interactiveTree = (max: number) => `(() => {
  ${DESCRIBE}
  const SEL = ${SELECTOR};
  const vw = innerWidth, vh = innerHeight;
  const out = [], seen = new Set();
  let occluded = 0, offscreen = 0, truncated = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { offscreen++; continue; }
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) { offscreen++; continue; }
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") { offscreen++; continue; }
    // Centre of the *visible* part, so half-scrolled elements still hit-test.
    const x = Math.round((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2);
    const y = Math.round((Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2);
    const hit = document.elementFromPoint(x, y);
    // el.contains(hit) keeps <button><span>text</span></button>. An ancestor hit
    // means something else owns that point, so the element is not clickable there.
    if (!hit || !(el === hit || el.contains(hit))) { occluded++; continue; }
    const key = x + ":" + y;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= ${max}) { truncated++; continue; }
    const text = (el.innerText || el.value || el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") || el.getAttribute("title") || "")
      .trim().replace(/\\s+/g, " ").slice(0, 80);
    const item = {
      ref: describe(el),
      tag: el.tagName.toLowerCase(),
      text,
      center: { x, y },
      boundingBox: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
    const t = el.getAttribute("type"); if (t) item.type = t;
    if (el.disabled) item.disabled = true;
    out.push(item);
  }
  return { interactiveElements: out, truncated, occluded, offscreen, viewport: { width: vw, height: vh } };
})()`;

/**
 * Why a click at (x, y) will or will not reach an interactive element.
 *
 * WebView's click(selector) already refuses obscured elements, but it only ever
 * reports "timeout waiting to be actionable". This says what is in the way.
 */
const hitTest = (x: number, y: number) => `(() => {
  ${DESCRIBE}
  const SEL = ${SELECTOR};
  const x = ${x}, y = ${y};
  const none = { isBlocked: false, intendedElement: null, blockingElement: null, pointerEventsStyle: null, stack: [] };
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { ...none, outsideViewport: true };
  const stack = document.elementsFromPoint(x, y);
  if (!stack.length) return { ...none, outsideViewport: false };
  const idx = stack.findIndex((e) => e.matches(SEL));
  const intended = idx >= 0 ? stack[idx] : null;
  const top = stack[0];
  // Blocked when the topmost element is neither the target nor inside it.
  const isBlocked = !!intended && top !== intended && !intended.contains(top);
  return {
    isBlocked,
    outsideViewport: false,
    topElement: describe(top),
    intendedElement: describe(intended),
    blockingElement: isBlocked ? describe(top) : null,
    pointerEventsStyle: getComputedStyle(isBlocked ? top : (intended || top)).pointerEvents,
    stack: stack.slice(0, 5).map(describe),
  };
})()`;

/** Horizontal overflow at the current viewport, worst offenders first. */
const overflowScan = (max: number) => `(() => {
  ${DESCRIBE}
  const vw = innerWidth;
  const de = document.documentElement;
  const widest = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const docOverflow = widest - vw;
  const offenders = [];
  if (docOverflow > 0) {
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const over = Math.round(r.right - vw);
      if (over > 0) offenders.push({ elementSelector: describe(el), overflowWidth: over });
    }
    offenders.sort((a, b) => b.overflowWidth - a.overflowWidth);
  }
  return {
    horizontalOverflow: docOverflow > 0,
    overflowWidth: Math.max(0, Math.round(docOverflow)),
    offenders: offenders.slice(0, ${max}),
    offenderCount: offenders.length,
    viewport: { width: vw, height: innerHeight },
  };
})()`;

/**
 * Assets the DOM knows are broken. Status codes are not available here — they
 * come from the network buffer, which is why this is joined with CDP data on the
 * chrome backend and reported without codes on webkit.
 */
const brokenAssetsProbe = `(() => {
  const out = [];
  for (const img of document.images) {
    if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) {
      out.push({ type: "image", source: img.currentSrc || img.src });
    }
  }
  for (const l of document.querySelectorAll('link[rel~="stylesheet"]')) {
    if (!l.href) continue;
    let loaded = false;
    for (const s of document.styleSheets) { if (s.href === l.href) { loaded = true; break; } }
    if (!loaded) out.push({ type: "stylesheet", source: l.href });
  }
  for (const s of document.querySelectorAll("script[src]")) {
    if (s.dataset && s.dataset.flamingoFailed) out.push({ type: "script", source: s.src });
  }
  return out;
})()`;

// DOM.documentUpdated (which the PRD names) only fires when the whole document is
// replaced, not on subtree mutations — so it misses nearly every real click. A
// MutationObserver installed before the click is the only thing that sees them.
const installMutationCounter = `(() => {
  if (window.__flamingoObs) window.__flamingoObs.disconnect();
  window.__flamingoMut = 0;
  const a = document.activeElement;
  window.__flamingoFocus = a ? a.tagName + "#" + (a.id || "") : "";
  const o = new MutationObserver((ms) => { window.__flamingoMut += ms.length; });
  o.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__flamingoObs = o;
  return true;
})()`;

/** `mutations: -1` means the counter is gone, i.e. navigation replaced the context. */
const readMutationCounter = `(() => {
  const n = window.__flamingoMut;
  const before = window.__flamingoFocus;
  if (window.__flamingoObs) { window.__flamingoObs.disconnect(); window.__flamingoObs = null; }
  if (typeof n !== "number") return { mutations: -1, focusChanged: false };
  const a = document.activeElement;
  const after = a ? a.tagName + "#" + (a.id || "") : "";
  // Only a field taking focus counts: buttons take focus on every click, so
  // counting that would mark every unwired button as alive.
  const focusChanged = !!a && after !== before &&
    (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable === true);
  return { mutations: n, focusChanged };
})()`;

const viewportInfo = `({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY })`;

// =========================================================================
// SECTION 2 — Engine — the twelve agent-facing APIs
//
// Everything below is backend-agnostic except the three that need CDP, which
// throw a message naming the fix when called on the webkit backend.
// =========================================================================

export type Backend = "webkit" | "chrome";

export interface EngineOptions {
  /**
   * `"webkit"` (default) uses the system WebKit on macOS with no external
   * browser. `"chrome"` drives Chrome/Chromium/Brave over CDP and is required
   * for the network-dependent APIs.
   */
  backend?: Backend;
  /** Chrome executable path. Defaults to `BUN_CHROME_PATH`, then a probe of standard locations. */
  chromePath?: string;
  /** @default 1280 */
  width?: number;
  /** @default 800 */
  height?: number;
  /** Navigate here during `open()`. */
  url?: string;
  /** Max buffered console and network entries, oldest dropped. @default 500 */
  bufferSize?: number;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface OverflowOffender {
  elementSelector: string;
  overflowWidth: number;
}

export interface ResponsiveViolation {
  viewport: string;
  type: "horizontal-overflow";
  overflowWidth: number;
  offenders: OverflowOffender[];
  offenderCount: number;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  errorText?: string;
  timestamp: number;
}

// Brave first: it is the most common Chromium on machines with no Chrome install.
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** The APIs that cannot work without CDP, named here so the error can list them. */
const CHROME_ONLY = "interceptTraffic, hoverCoordinate, and HTTP status codes in scanBrokenAssets";

export class Engine {
  readonly backend: Backend;
  /** The underlying Bun.WebView. Public escape hatch for anything not wrapped here. */
  readonly view: Bun.WebView;

  private consoleBuf: ConsoleEntry[] = [];
  private networkBuf: NetworkEntry[] = [];
  private byRequestId = new Map<string, NetworkEntry>();
  private cap: number;
  private readonly width: number;
  private readonly height: number;
  private navCount = 0;
  private evalChain: Promise<unknown> = Promise.resolve();
  private shotSeq = 0;
  private closed = false;

  private constructor(opts: EngineOptions) {
    this.backend = opts.backend ?? "webkit";
    this.cap = opts.bufferSize ?? 500;
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 800;

    let backend: Bun.WebView.Backend;
    if (this.backend === "chrome") {
      const path = opts.chromePath ?? Bun.env.BUN_CHROME_PATH ?? CHROME_CANDIDATES.find((p) => existsSync(p));
      // url:false keeps us from auto-attaching to the user's own running Chrome,
      // which would pop an "Allow remote debugging?" dialog on every connection.
      backend = { type: "chrome", url: false, ...(path ? { path } : {}) };
    } else {
      backend = "webkit";
    }

    this.view = new Bun.WebView({
      width: this.width,
      height: this.height,
      backend,
      // Wired at construction so page errors are captured before any navigation.
      console: (type: string, ...args: unknown[]) => this.pushConsole(type, args),
    });
    this.view.onNavigated = () => { this.navCount++; };
  }

  static async open(opts: EngineOptions = {}): Promise<Engine> {
    const engine = new Engine(opts);
    try {
      // about:blank first: it establishes the CDP session, which is what lets
      // Network.enable be wired BEFORE the first real navigation. Enabling after
      // would miss every request the page fires on load — including the failures.
      await engine.view.navigate("about:blank");
      // The two backends read the constructor's width/height differently: webkit
      // sizes the CSS viewport, chrome sizes the outer window and loses ~81px to
      // browser chrome even headless. resize() means viewport on both, so this
      // makes "the viewport you asked for" true regardless of backend.
      await engine.view.resize(engine.width, engine.height);
      if (engine.backend === "chrome") await engine.enableNetwork();
      if (opts.url) await engine.goto(opts.url);
    } catch (e) {
      engine.close();
      throw e;
    }
    return engine;
  }

  // ---------------------------------------------------------------- internals

  private pushConsole(type: string, args: unknown[]) {
    const text = args
      .map((a) => (typeof a === "string" ? a : (a as any)?.description ?? Bun.inspect(a)))
      .join(" ");
    this.consoleBuf.push({ type, text, timestamp: Date.now() });
    if (this.consoleBuf.length > this.cap) this.consoleBuf.shift();
  }

  /** Subscribe to a CDP event and hand the listener just the params. */
  private onCdp(event: string, fn: (data: any) => void) {
    this.view.addEventListener(event, (e) => fn((e as MessageEvent).data));
  }

  private async enableNetwork() {
    await this.view.cdp("Network.enable");
    this.onCdp("Network.requestWillBeSent", (d) => {
      const entry: NetworkEntry = {
        requestId: d.requestId,
        url: d.request.url,
        method: d.request.method,
        timestamp: Date.now(),
      };
      this.byRequestId.set(d.requestId, entry);
      this.networkBuf.push(entry);
      if (this.networkBuf.length > this.cap) {
        const dropped = this.networkBuf.shift();
        if (dropped) this.byRequestId.delete(dropped.requestId);
      }
    });
    this.onCdp("Network.responseReceived", (d) => {
      const entry = this.byRequestId.get(d.requestId);
      if (!entry) return;
      entry.status = d.response.status;
      entry.mimeType = d.response.mimeType;
    });
    this.onCdp("Network.loadingFailed", (d) => {
      const entry = this.byRequestId.get(d.requestId);
      if (entry) entry.errorText = d.errorText;
    });
  }

  private requireChrome(api: string): void {
    if (this.backend === "chrome") return;
    throw new Error(
      `${api}() requires backend: "chrome" — CDP is unavailable on the webkit backend. ` +
        `Construct with Engine.open({ backend: "chrome" }). Only ${CHROME_ONLY} need it; ` +
        `every other API works on webkit.`,
    );
  }

  // Bun.WebView allows only one evaluate() in flight per view and throws
  // ERR_INVALID_STATE on a second, so all page calls funnel through one chain.
  private evaluate<T>(expr: string): Promise<T> {
    const run = this.evalChain.then(
      () => this.view.evaluate<T>(expr),
      () => this.view.evaluate<T>(expr),
    );
    this.evalChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // ------------------------------------------------------------- navigation

  /** Navigate and wait for the main frame load to finish. */
  async goto(url: string): Promise<{ url: string; title: string }> {
    await this.view.navigate(url);
    return { url: this.view.url, title: this.view.title };
  }

  /**
   * Wait until no network request has started for `idleMs`.
   * Chrome backend only — webkit has no request visibility, so it just sleeps.
   */
  async waitForIdle({ idleMs = 500, timeoutMs = 10_000 } = {}): Promise<{ idle: boolean }> {
    if (this.backend !== "chrome") {
      await Bun.sleep(idleMs);
      return { idle: true };
    }
    const deadline = Date.now() + timeoutMs;
    let lastSeen = this.networkBuf.length;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (this.networkBuf.length !== lastSeen) {
        lastSeen = this.networkBuf.length;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= idleMs) {
        return { idle: true };
      }
      await Bun.sleep(50);
    }
    return { idle: false };
  }

  // ------------------------------------------------- 4.1 visual and layout

  /**
   * 1. Screenshot the viewport.
   *
   * Returns a file path rather than base64 by default: a 1080p PNG is ~1-3MB of
   * base64 text, which would defeat the point of a context-preserving tool. Pass
   * `base64: true` when you actually need the bytes inline.
   *
   * Note `deviceScaleFactor`: on a retina display the image is 2x the CSS size,
   * while every coordinate this library returns is CSS-space. Divide image pixels
   * by this factor before feeding them back into click coordinates.
   */
  async captureViewport(
    opts: { format?: "png" | "jpeg" | "webp"; quality?: number; path?: string; base64?: boolean } = {},
  ) {
    const format = opts.format ?? "png";
    if (format === "webp" && this.backend !== "chrome") {
      throw new Error(`captureViewport({ format: "webp" }) requires backend: "chrome". Use "png" or "jpeg" on webkit.`);
    }
    const buf = await this.view.screenshot({ encoding: "buffer", format, quality: opts.quality });
    const meta = await new Bun.Image(buf).metadata();
    const vp = await this.evaluate<{ width: number; height: number; deviceScaleFactor: number }>(viewportInfo);

    const path = resolve(opts.path ?? `.flamingo/viewport-${Date.now()}-${this.shotSeq++}.${format}`);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, buf);

    return {
      path,
      sizeInBytes: buf.length,
      format,
      pixelSize: { width: meta.width, height: meta.height },
      cssSize: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      ...(opts.base64 ? { base64: buf.toString("base64") } : {}),
    };
  }

  /**
   * 2. Resize through viewports and report horizontal overflow at each.
   *
   * There is no "layout settled" signal in either backend, so `settleMs` is a
   * heuristic wait after each resize. Raise it for animation-heavy pages.
   */
  async auditResponsiveness(
    opts: { viewports?: Array<{ width: number; height: number }>; settleMs?: number; maxOffenders?: number } = {},
  ) {
    const viewports = opts.viewports ?? [
      { width: 1920, height: 1080 },
      { width: 768, height: 1024 },
      { width: 375, height: 812 },
    ];
    const settleMs = opts.settleMs ?? 250;
    const original = await this.evaluate<{ width: number; height: number }>(viewportInfo);
    const violations: ResponsiveViolation[] = [];

    for (const vp of viewports) {
      await this.view.resize(vp.width, vp.height);
      await Bun.sleep(settleMs); // ponytail: fixed wait, no settle event exists; --settle-ms if pages need more
      const scan = await this.evaluate<any>(overflowScan(opts.maxOffenders ?? 5));
      if (scan.horizontalOverflow) {
        violations.push({
          viewport: `${vp.width}x${vp.height}`,
          type: "horizontal-overflow",
          overflowWidth: scan.overflowWidth,
          offenders: scan.offenders,
          offenderCount: scan.offenderCount,
        });
      }
    }
    await this.view.resize(original.width, original.height);
    await Bun.sleep(settleMs);
    return { violations, viewportsTested: viewports.length };
  }

  /** 3. Explain whether a click at (x, y) reaches an interactive element, and what blocks it. */
  async detectPointerBlocker({ x, y }: { x: number; y: number }) {
    return this.evaluate<any>(hitTest(x, y));
  }

  // ------------------------------------------ 4.2 hardware-level interaction

  /**
   * 4. Click. Pass coordinates for raw dispatch, or a selector to wait for the
   * element to become actionable first (attached, visible, stable, not obscured).
   */
  async clickCoordinate(
    opts:
      | { x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: 1 | 2 | 3 }
      | { selector: string; button?: "left" | "right" | "middle"; clickCount?: 1 | 2 | 3; timeout?: number },
  ) {
    const { button = "left", clickCount = 1 } = opts as any;
    if ("selector" in opts) {
      await this.view.click(opts.selector, { button, clickCount, timeout: opts.timeout ?? 30_000 });
      return { success: true, selector: opts.selector };
    }
    await this.view.click(opts.x, opts.y, { button, clickCount });
    return { success: true, targetCoordinates: { x: opts.x, y: opts.y } };
  }

  /**
   * 5. Type into the focused element.
   *
   * Default uses WebView's InsertText path: atomic and fast, but fires no
   * keydown. Set `realKeys` (or any `typingDelayMs`) to send per-character key
   * events instead, for fields whose validation listens to keydown.
   *
   * The `evaluate("1")` after each key is a required barrier, not a nicety —
   * keyboard dispatch has no completion signal, and without it characters
   * arrive late and out of order.
   */
  async typeInput({
    text,
    typingDelayMs = 0,
    realKeys = false,
  }: {
    text: string;
    typingDelayMs?: number;
    realKeys?: boolean;
  }) {
    if (!realKeys && typingDelayMs <= 0) {
      await this.view.type(text);
      return { success: true, charactersTyped: text.length, mode: "insertText" as const };
    }
    for (const ch of text) {
      await this.view.press(ch);
      await this.evaluate("1"); // barrier: see doc comment
      if (typingDelayMs > 0) await Bun.sleep(typingDelayMs);
    }
    return { success: true, charactersTyped: [...text].length, mode: "keyEvents" as const };
  }

  /** Press a named key (`"Enter"`, `"Tab"`, `"Escape"`, ...) or a chord. */
  async pressKey({ key, modifiers }: { key: string; modifiers?: Array<"Shift" | "Control" | "Alt" | "Meta"> }) {
    await this.view.press(key, modifiers ? { modifiers } : undefined);
    await this.evaluate("1");
    return { success: true, key };
  }

  /**
   * 6. Hover to reveal popovers and CSS dropdowns.
   *
   * Chrome only: WebView exposes no hover primitive, so this goes through CDP.
   */
  async hoverCoordinate({ x, y }: { x: number; y: number }) {
    this.requireChrome("hoverCoordinate");
    await this.view.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    return { success: true, targetCoordinates: { x, y } };
  }

  /** Scroll by a pixel delta, or bring a selector into view. */
  async scroll(opts: { dx?: number; dy?: number } | { selector: string; block?: "start" | "center" | "end" | "nearest" }) {
    if ("selector" in opts) {
      await this.view.scrollTo(opts.selector, { block: opts.block ?? "center" });
      return { success: true, selector: opts.selector };
    }
    await this.view.scroll(opts.dx ?? 0, opts.dy ?? 0);
    return { success: true, delta: { dx: opts.dx ?? 0, dy: opts.dy ?? 0 } };
  }

  // ------------------------------------------- 4.3 integration and system sync

  /** 7. Read buffered network traffic. Chrome only. */
  async interceptTraffic({ filterUrlPattern }: { filterUrlPattern?: string } = {}) {
    this.requireChrome("interceptTraffic");
    const re = filterUrlPattern ? new RegExp(filterUrlPattern) : null;
    const traffic = this.networkBuf.filter((e) => !re || re.test(e.url));
    return { traffic, total: this.networkBuf.length, filtered: traffic.length };
  }

  /**
   * 8. Read buffered console output and page exceptions.
   * Works on both backends — capture starts at construction, before any navigation.
   */
  async captureRuntimeLogs({ type }: { type?: string } = {}) {
    const consoleLogs = type ? this.consoleBuf.filter((l) => l.type === type) : [...this.consoleBuf];
    return { consoleLogs, total: this.consoleBuf.length, errors: this.consoleBuf.filter((l) => l.type === "error").length };
  }

  /**
   * 9. Click a coordinate and report whether anything at all happened.
   *
   * Signals watched: DOM mutations (MutationObserver installed before the click),
   * console output, navigation, and — chrome only — network requests. On webkit
   * `registeredNetworkRequests` is null rather than 0, so a missing signal is
   * never mistaken for a measured zero.
   */
  async detectDeadClicks({ x, y, timeoutMs = 1000 }: { x: number; y: number; timeoutMs?: number }) {
    await this.evaluate(installMutationCounter);
    const net0 = this.networkBuf.length;
    const log0 = this.consoleBuf.length;
    const nav0 = this.navCount;

    await this.view.click(x, y);
    await Bun.sleep(timeoutMs);

    const probe = await this.evaluate<{ mutations: number; focusChanged: boolean }>(readMutationCounter);
    // mutations < 0 means the counter is gone, i.e. navigation replaced the context.
    let mutations = probe.mutations;
    const navigated = this.navCount > nav0 || mutations < 0;
    if (mutations < 0) mutations = 0;

    const networkRequests = this.backend === "chrome" ? this.networkBuf.length - net0 : null;
    const consoleLogs = this.consoleBuf.length - log0;
    const isDeadClick =
      !navigated && !probe.focusChanged && mutations === 0 && consoleLogs === 0 && (networkRequests ?? 0) === 0;

    return {
      isDeadClick,
      coordinates: { x, y },
      navigated,
      focusChanged: probe.focusChanged,
      registeredDOMChanges: mutations,
      registeredNetworkRequests: networkRequests,
      registeredConsoleLogs: consoleLogs,
      ...(networkRequests === null ? { note: 'network signal unavailable on webkit; use backend "chrome" for full fidelity' } : {}),
    };
  }

  // ------------------------------------------- 4.4 agentic context and health

  /** 10. Compact, viewport-filtered list of everything an agent can act on. */
  async getInteractiveTree({ max = 100 }: { max?: number } = {}) {
    return this.evaluate<any>(interactiveTree(max));
  }

  /**
   * 11. Broken images, stylesheets and scripts.
   * HTTP status codes are joined in from the network buffer on chrome; on webkit
   * the DOM alone cannot see them, so `status` is omitted and the flag says so.
   */
  async scanBrokenAssets() {
    const found = await this.evaluate<Array<{ type: string; source: string }>>(brokenAssetsProbe);
    const statusCodesAvailable = this.backend === "chrome";
    const byUrl = new Map(this.networkBuf.map((e) => [e.url, e]));

    const brokenAssets = found.map((a) => {
      const net = byUrl.get(a.source);
      return { ...a, ...(net?.status !== undefined ? { status: net.status } : {}), ...(net?.errorText ? { errorReason: net.errorText } : {}) };
    });

    // Chrome also sees failures the DOM never exposes (fonts, XHR, preloads).
    if (statusCodesAvailable) {
      const seen = new Set(brokenAssets.map((a) => a.source));
      for (const e of this.networkBuf) {
        if (seen.has(e.url)) continue;
        if ((e.status !== undefined && e.status >= 400) || e.errorText) {
          brokenAssets.push({ type: "request", source: e.url, ...(e.status !== undefined ? { status: e.status } : {}), ...(e.errorText ? { errorReason: e.errorText } : {}) } as any);
        }
      }
    }
    return { brokenAssets, statusCodesAvailable };
  }

  /** 12. Consolidated scorecard. Responsive auditing is opt-in because it resizes the page. */
  async compileHealthReport(opts: { viewports?: Array<{ width: number; height: number }>; deadClickTargets?: Array<{ x: number; y: number }> } = {}) {
    const logs = await this.captureRuntimeLogs();
    const assets = await this.scanBrokenAssets();
    const responsive = opts.viewports ? await this.auditResponsiveness({ viewports: opts.viewports }) : { violations: [] };

    const deadClicks: Array<Record<string, unknown>> = [];
    for (const t of opts.deadClickTargets ?? []) {
      const r = await this.detectDeadClicks(t);
      if (r.isDeadClick) deadClicks.push({ coordinates: r.coordinates });
    }

    const consoleErrors = logs.errors;
    const brokenAssets = assets.brokenAssets.length;
    const overflowLayouts = responsive.violations.length;
    const totalErrors = consoleErrors + brokenAssets + deadClicks.length + overflowLayouts;

    return {
      success: totalErrors === 0,
      targetUrl: this.view.url,
      timestamp: new Date().toISOString(),
      totalErrors,
      details: { consoleErrors, brokenAssets, deadClicks: deadClicks.length, overflowLayouts },
      errors: {
        console: logs.consoleLogs.filter((l) => l.type === "error").map((l) => ({ type: l.type, message: l.text })),
        brokenAssets: assets.brokenAssets,
        deadClicks,
        responsive: responsive.violations,
      },
      backend: this.backend,
      statusCodesAvailable: assets.statusCodesAvailable,
    };
  }

  /**
   * Click every actionable control and report the ones that do nothing.
   *
   * Composes three of the APIs above: the tree supplies the targets,
   * detectDeadClicks decides whether anything happened, and when nothing did,
   * detectPointerBlocker explains why — an overlay swallowing the click reads
   * very differently from a button with no handler.
   *
   * The page reloads only after a click that *changed* something. A dead click
   * by definition leaves the layout alone, so the coordinates captured up front
   * stay valid and cost nothing to reuse.
   */
  async crawl({ max = 20, dwellMs = 700 }: { max?: number; dwellMs?: number } = {}) {
    const targetUrl = this.view.url;
    const tree = await this.getInteractiveTree({ max });
    const candidates = tree.interactiveElements.filter((el: any) => !el.disabled);
    const skipped = tree.interactiveElements.length - candidates.length;

    const dead: Array<Record<string, unknown>> = [];
    let alive = 0;

    for (const el of candidates) {
      const clicked = await this.detectDeadClicks({ x: el.center.x, y: el.center.y, timeoutMs: dwellMs });
      if (!clicked.isDeadClick) {
        alive++;
        // Whatever it changed invalidates the coordinates we captured; reset.
        await this.goto(targetUrl);
        continue;
      }
      const blocker = await this.detectPointerBlocker({ x: el.center.x, y: el.center.y });
      dead.push({
        ref: el.ref,
        text: el.text,
        center: el.center,
        reason: blocker.isBlocked ? "blocked" : "no-handler",
        blockedBy: blocker.isBlocked ? blocker.blockingElement : null,
        registeredDOMChanges: clicked.registeredDOMChanges,
        registeredNetworkRequests: clicked.registeredNetworkRequests,
        registeredConsoleLogs: clicked.registeredConsoleLogs,
      });
    }

    return {
      targetUrl,
      controlsFound: tree.interactiveElements.length,
      controlsTested: candidates.length,
      skipped,
      alive,
      dead,
      occluded: tree.occluded,
      truncated: tree.truncated,
    };
  }

  // -------------------------------------------------------------- lifecycle

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.view.close();
    } catch {}
  }

  [Symbol.dispose]() {
    this.close();
  }
  [Symbol.asyncDispose]() {
    this.close();
  }
}

// =========================================================================
// SECTION 3 — MCP server (stdio JSON-RPC, no SDK)
//
// Line-delimited JSON-RPC on stdin/stdout. Nothing but protocol frames may be
// written to stdout, so page console output goes to the engine's buffer.
// =========================================================================

const numSchema = { type: "number" } as const;
const strSchema = { type: "string" } as const;
const boolSchema = { type: "boolean" } as const;
const XY = { type: "object", properties: { x: numSchema, y: numSchema }, required: ["x", "y"] } as const;

const CHROME_NOTE = ' Requires --backend chrome.';

interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (e: Engine, a: any) => Promise<unknown>;
}

const TOOLS: Record<string, Tool> = {
  goto: {
    description: "Navigate to a URL and wait for the main frame to finish loading.",
    inputSchema: { type: "object", properties: { url: strSchema }, required: ["url"] },
    run: (e, a) => e.goto(a.url),
  },
  getInteractiveTree: {
    description:
      "Compact list of every element that can actually be acted on, with click-ready CSS-space centre coordinates. Filtered to the viewport and to elements that are not occluded, so it stays small on large pages. Start here to decide what to click.",
    inputSchema: { type: "object", properties: { max: numSchema } },
    run: (e, a) => e.getInteractiveTree(a),
  },
  detectPointerBlocker: {
    description:
      "Explain whether a click at (x, y) reaches an interactive element, and name the element blocking it if not. Use when a click did nothing.",
    inputSchema: XY,
    run: (e, a) => e.detectPointerBlocker(a),
  },
  clickCoordinate: {
    description:
      "Click. Give x/y for a raw coordinate click, or selector to wait for the element to become actionable first.",
    inputSchema: {
      type: "object",
      properties: { x: numSchema, y: numSchema, selector: strSchema, button: { enum: ["left", "right", "middle"] }, clickCount: numSchema },
    },
    run: (e, a) => e.clickCoordinate(a),
  },
  typeInput: {
    description:
      "Type into the focused element. Default is a fast paste-style insert; set realKeys or typingDelayMs to send per-character key events for fields that validate on keydown.",
    inputSchema: { type: "object", properties: { text: strSchema, typingDelayMs: numSchema, realKeys: boolSchema }, required: ["text"] },
    run: (e, a) => e.typeInput(a),
  },
  pressKey: {
    description: 'Press a named key ("Enter", "Tab", "Escape", arrows) or a chord with modifiers.',
    inputSchema: {
      type: "object",
      properties: { key: strSchema, modifiers: { type: "array", items: { enum: ["Shift", "Control", "Alt", "Meta"] } } },
      required: ["key"],
    },
    run: (e, a) => e.pressKey(a),
  },
  hoverCoordinate: {
    description: "Hover to reveal popovers, dropdowns and hidden overlays." + CHROME_NOTE,
    inputSchema: XY,
    run: (e, a) => e.hoverCoordinate(a),
  },
  scroll: {
    description: "Scroll by a pixel delta (dx/dy) or bring a selector into view.",
    inputSchema: {
      type: "object",
      properties: { dx: numSchema, dy: numSchema, selector: strSchema, block: { enum: ["start", "center", "end", "nearest"] } },
    },
    run: (e, a) => e.scroll(a),
  },
  detectDeadClicks: {
    description:
      "Click a coordinate and report whether anything happened: DOM mutations, console output, navigation, and network requests. Use to prove a control is wired up.",
    inputSchema: { type: "object", properties: { x: numSchema, y: numSchema, timeoutMs: numSchema }, required: ["x", "y"] },
    run: (e, a) => e.detectDeadClicks(a),
  },
  crawl: {
    description:
      "Click every actionable control on the page and report which ones do nothing, and why — swallowed by an overlay, or no handler fired at all. The fastest way to find broken buttons across a page.",
    inputSchema: { type: "object", properties: { max: numSchema, dwellMs: numSchema } },
    run: (e, a) => e.crawl(a),
  },
  captureRuntimeLogs: {
    description:
      "Buffered console output and page exceptions. Capture starts before the first navigation, so load-time errors are included.",
    inputSchema: { type: "object", properties: { type: strSchema } },
    run: (e, a) => e.captureRuntimeLogs(a),
  },
  interceptTraffic: {
    description: "Buffered network requests with methods and response status codes." + CHROME_NOTE,
    inputSchema: { type: "object", properties: { filterUrlPattern: strSchema } },
    run: (e, a) => e.interceptTraffic(a),
  },
  scanBrokenAssets: {
    description: "Broken images, stylesheets and failed requests. HTTP status codes are included on the chrome backend only.",
    inputSchema: { type: "object", properties: {} },
    run: (e) => e.scanBrokenAssets(),
  },
  auditResponsiveness: {
    description:
      "Resize through viewports and report horizontal overflow with the worst offending elements at each size.",
    inputSchema: {
      type: "object",
      properties: {
        viewports: { type: "array", items: { type: "object", properties: { width: numSchema, height: numSchema }, required: ["width", "height"] } },
        settleMs: numSchema,
      },
    },
    run: (e, a) => e.auditResponsiveness(a),
  },
  captureViewport: {
    description:
      "Screenshot the viewport to a file. Returns the path plus cssSize, pixelSize and deviceScaleFactor — image pixels are scaled by that factor, while all click coordinates are CSS-space. Set base64 only if you need the bytes inline; they are large.",
    inputSchema: {
      type: "object",
      properties: { format: { enum: ["png", "jpeg", "webp"] }, quality: numSchema, path: strSchema, base64: boolSchema },
    },
    run: (e, a) => e.captureViewport(a),
  },
  compileHealthReport: {
    description:
      "Consolidated scorecard: console errors, broken assets, dead clicks and layout overflow, with a pass/fail total.",
    inputSchema: {
      type: "object",
      properties: {
        viewports: { type: "array", items: { type: "object", properties: { width: numSchema, height: numSchema }, required: ["width", "height"] } },
        deadClickTargets: { type: "array", items: XY },
      },
    },
    run: (e, a) => e.compileHealthReport(a),
  },
};

/**
 * Write one protocol frame and resolve once it has actually reached the OS.
 *
 * `process.stdout.write` buffers when stdout is a pipe, so a reply written just
 * before the process exits can be lost. Every caller awaits this, which makes
 * the loop below both ordered and flush-safe.
 */
function send(msg: unknown): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(msg) + "\n", () => resolve());
  });
}

async function handle(msg: any, getEngine: () => Promise<Engine>) {
  const { id, method, params } = msg;
  // Notifications carry no id and take no response.
  if (id === undefined) return;

  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "flamingo", version: "0.1.0" },
        },
      });
    }

    if (method === "tools/list") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: Object.entries(TOOLS).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
    }

    if (method === "tools/call") {
      const tool = TOOLS[params?.name];
      if (!tool) {
        return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      }
      try {
        const result = await tool.run(await getEngine(), params.arguments ?? {});
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      } catch (e: any) {
        // Tool failures are results, not protocol errors — the agent should see
        // the message (e.g. "requires backend: chrome") and adapt.
        return send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true },
        });
      }
    }

    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });

    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e: any) {
    return send({ jsonrpc: "2.0", id, error: { code: -32603, message: e?.message ?? String(e) } });
  }
}

/**
 * Serve the MCP protocol on stdin/stdout until the client closes stdin.
 * The browser is launched lazily on the first tool call, not at startup.
 */
export async function runMcpServer(opts: EngineOptions = {}): Promise<void> {
  const state: { engine: Engine | null } = { engine: null };
  const getEngine = async (): Promise<Engine> => {
    if (!state.engine) state.engine = await Engine.open(opts);
    return state.engine;
  };

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        await handle(JSON.parse(line), getEngine);
      } catch {
        await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
  }

  // stdin closed: the client is gone.
  // Drain anything still queued before tearing the browser down and exiting.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  state.engine?.close();
  Bun.WebView.closeAll();
}

// ===========================================================================
// SECTION 4 — Command-line interface
//
// Manual argv parsing (no yargs/commander), ANSI escapes for colour (no chalk).
// Contract: stdout carries data, stderr carries diagnostics, and `--json` puts
// nothing but a single JSON document on stdout so it can be piped safely.
// ===========================================================================

const VERSION = "0.1.0";
const TAGLINE = "AI Native Frontend Testing Toolkit";

/**
 * One metadata table drives the global help, the per-command help and the
 * machine-readable `schema` output, so they cannot drift apart.
 */
interface CommandSpec {
  args: string;
  summary: string;
  detail: string;
  flags: string[];
  exits: string;
  examples: string[];
}

const GLOBAL_FLAGS: Array<[string, string]> = [
  ["--json", "Emit a single JSON document on stdout, nothing else"],
  ["--backend <name>", "webkit (default, macOS, no browser install) | chrome"],
  ["--chrome-path <p>", "Chrome/Chromium/Brave executable (or set BUN_CHROME_PATH)"],
  ["--width <n>", "Viewport width (default 1280)"],
  ["--height <n>", "Viewport height (default 800)"],
  ["--no-color", "Disable ANSI colour"],
  ["-h, --help", "Show help; after a command, show that command's help"],
  ["-v, --version", "Show version"],
];

const COMMANDS: Record<string, CommandSpec> = {
  audit: {
    args: "<url>",
    summary: "Health report: console errors, broken assets, layout overflow",
    detail:
      "Loads the page and consolidates everything that looks wrong into one scorecard:\n" +
      "console errors and uncaught exceptions, broken images and stylesheets, and\n" +
      "horizontal overflow across viewports. Console capture starts before the first\n" +
      "navigation, so load-time failures are included.",
    flags: ["--viewports <list>", "--json"],
    exits: "0 if nothing is wrong, 1 if any problem is found",
    examples: [
      "flamingo audit http://localhost:3000",
      "flamingo audit http://localhost:3000 --json | jq .details",
      "flamingo audit https://staging.example.com --backend chrome",
    ],
  },
  crawl: {
    args: "<url>",
    summary: "Click every control and report the dead ones",
    detail:
      "Walks the interactive tree and clicks each control, watching for DOM mutations,\n" +
      "network requests, console output, navigation and focus. Controls that produce\n" +
      "none of those are reported dead, with the reason: swallowed by an overlay, or\n" +
      "no handler wired at all.",
    flags: ["--max <n>", "--dwell <ms>", "--json"],
    exits: "0 if every control responds, 1 if any is dead",
    examples: [
      "flamingo crawl http://localhost:3000",
      "flamingo crawl http://localhost:3000 --max 50 --dwell 1200",
    ],
  },
  tree: {
    args: "<url>",
    summary: "Actionable elements with click-ready coordinates",
    detail:
      "Returns only elements an agent can act on: in the viewport, visible, and not\n" +
      "occluded by anything else at their own centre point. Each carries a CSS-space\n" +
      "centre you can pass straight back to a click.",
    flags: ["--max <n>", "--json"],
    exits: "0 always (unless the page fails to load)",
    examples: ["flamingo tree http://localhost:3000 --json", "flamingo tree http://localhost:3000 --max 20"],
  },
  responsive: {
    args: "<url>",
    summary: "Horizontal-overflow audit across viewports",
    detail:
      "Resizes through each viewport and reports horizontal overflow, naming the worst\n" +
      "offending elements. Neither backend emits a layout-settled signal, so --settle\n" +
      "is a heuristic wait; raise it for animation-heavy pages.",
    flags: ["--viewports <list>", "--settle <ms>", "--json"],
    exits: "0 if no viewport overflows, 1 if any does",
    examples: ["flamingo responsive http://localhost:3000 --viewports 1920x1080,375x812"],
  },
  shot: {
    args: "<url>",
    summary: "Screenshot the viewport to a file",
    detail:
      "Writes an image and reports its path, byte size, pixel size, CSS size and\n" +
      "deviceScaleFactor. On a retina display the image is 2x the CSS size while all\n" +
      "coordinates are CSS-space, so divide by that factor before clicking them.",
    flags: ["--out <path>", "--format <png|jpeg|webp>", "--json"],
    exits: "0 on success",
    examples: ["flamingo shot http://localhost:3000 --out shot.png"],
  },
  serve: {
    args: "",
    summary: "Run the MCP server on stdio",
    detail:
      "Serves every API as an MCP tool over newline-delimited JSON-RPC on stdin/stdout,\n" +
      "so an agent drives the browser through tool calls instead of parsing CLI output.\n" +
      "The browser launches lazily on the first tool call. Run `flamingo schema` to see\n" +
      "the tool definitions without starting a server.",
    flags: ["--backend <name>", "--width <n>", "--height <n>"],
    exits: "0 when the client closes stdin",
    examples: ["flamingo serve", "flamingo serve --backend chrome"],
  },
  doctor: {
    args: "",
    summary: "Check the environment and report what works here",
    detail:
      "Verifies the Bun version, reports the platform, and probes which backends are\n" +
      "usable on this machine, including where a Chrome-family binary was found. Run\n" +
      "this first if anything behaves unexpectedly after install.",
    flags: ["--json"],
    exits: "0 if the toolkit is usable, 1 if a required piece is missing",
    examples: ["flamingo doctor", "flamingo doctor --json"],
  },
  schema: {
    args: "",
    summary: "Print the machine-readable API description as JSON",
    detail:
      "Emits every MCP tool with its JSON Schema, plus every CLI command with its flags\n" +
      "and exit codes. Intended for agents: read this once and you know how to call\n" +
      "everything without reading the docs.",
    flags: [],
    exits: "0 always",
    examples: ["flamingo schema", "flamingo schema | jq '.tools[].name'"],
  },
};

const pad = (rows: Array<[string, string]>, indent = "  ") => {
  const w = Math.max(...rows.map(([l]) => l.length));
  return rows.map(([l, r]) => `${indent}${l.padEnd(w)}  ${r}`).join("\n");
};

function buildUsage(): string {
  const commandRows = Object.entries(COMMANDS).map(
    ([name, c]) => [`${name} ${c.args}`.trim(), c.summary] as [string, string],
  );
  return `flamingo ${VERSION} — ${TAGLINE}

USAGE
  flamingo <command> [url] [options]

COMMANDS
${pad(commandRows)}

OPTIONS
${pad(GLOBAL_FLAGS)}

EXIT CODES
  0  completed, nothing wrong found
  1  completed, problems found      (use in CI)
  2  usage error
  3  runtime failure (browser launch or navigation failed)

EXAMPLES
  flamingo doctor
  flamingo crawl http://localhost:3000
  flamingo audit http://localhost:3000 --json | jq .details
  flamingo schema | jq '.tools[].name'

Run \`flamingo <command> --help\` for detail on any command.`;
}

function commandHelp(name: string): string {
  const c = COMMANDS[name]!;
  const flagRows = c.flags.map((f) => {
    const g = GLOBAL_FLAGS.find(([l]) => l.startsWith(f.split(" ")[0]!));
    return [f, g ? g[1] : LOCAL_FLAG_HELP[f.split(" ")[0]!] ?? ""] as [string, string];
  });
  return `flamingo ${name} ${c.args}`.trim() + ` — ${c.summary}

DESCRIPTION
${c.detail
  .split("\n")
  .map((l) => "  " + l)
  .join("\n")}

OPTIONS
${flagRows.length ? pad(flagRows) : "  (none beyond the global options)"}

EXIT CODES
  ${c.exits}

EXAMPLES
${c.examples.map((e) => "  " + e).join("\n")}`;
}

/** Help text for flags that are specific to one command. */
const LOCAL_FLAG_HELP: Record<string, string> = {
  "--viewports": "Comma-separated, e.g. 1920x1080,768x1024,375x812",
  "--max": "Max elements to consider (tree 100, crawl 20)",
  "--dwell": "How long to watch for a reaction per click (default 700ms)",
  "--settle": "Wait after each resize (default 250ms)",
  "--out": "Output path for the image",
  "--format": "png (default) | jpeg | webp (webp needs --backend chrome)",
  "--json": "Emit a single JSON document on stdout, nothing else",
};

/** Exit codes, named so the call sites read as intent rather than magic numbers. */
const EXIT = { ok: 0, problems: 1, usage: 2, runtime: 3 } as const;

class UsageError extends Error {}

let COLOR = true;
const paint = (code: string) => (s: string | number) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");
const dim = paint("2");
const bold = paint("1");

interface Parsed {
  command: string;
  url?: string;
  flags: Map<string, string | true>;
}

/**
 * Manual argument parser. Accepts `--flag value`, `--flag=value` and boolean
 * flags; the first non-flag token is the command, the second is the URL.
 */
function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "-h") { flags.set("help", true); continue; }
    if (arg === "-v") { flags.set("version", true); continue; }
    if (!arg.startsWith("--")) throw new UsageError(`Unknown flag: ${arg}`);

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    // A following token that is not itself a flag is this flag's value.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }

  return { command: positional[0] ?? "", url: positional[1], flags };
}

function num(flags: Parsed["flags"], name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got "${raw}"`);
  return n;
}

function str(flags: Parsed["flags"], name: string): string | undefined {
  const raw = flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/** Parse `1920x1080,375x812` into viewport objects. */
function parseViewports(spec: string): Array<{ width: number; height: number }> {
  return spec.split(",").map((pair) => {
    const m = /^(\d+)x(\d+)$/.exec(pair.trim());
    if (!m) throw new UsageError(`--viewports expects WIDTHxHEIGHT pairs, got "${pair.trim()}"`);
    return { width: Number(m[1]), height: Number(m[2]) };
  });
}

function requireUrl(p: Parsed): string {
  if (!p.url) throw new UsageError(`${p.command} needs a URL. Try: flamingo ${p.command} http://localhost:3000`);
  try {
    new URL(p.url);
  } catch {
    throw new UsageError(`Not a valid URL: ${p.url}`);
  }
  return p.url;
}

// -------------------------------------------------------------- human output

function printAuditHuman(r: any) {
  const d = r.details;
  console.log(`${bold(r.targetUrl)}  ${dim(`${r.backend} backend`)}`);
  if (r.success) {
    console.log(green(`\n✓ no problems found\n`));
    return;
  }
  console.log(red(`\n✗ ${r.totalErrors} problem${r.totalErrors === 1 ? "" : "s"}\n`));

  if (d.consoleErrors) {
    console.log(`  ${bold("console errors")} ${dim(`(${d.consoleErrors})`)}`);
    for (const e of r.errors.console.slice(0, 10)) console.log(`    ${red("✗")} ${e.message}`);
  }
  if (d.brokenAssets) {
    console.log(`  ${bold("broken assets")} ${dim(`(${d.brokenAssets})`)}`);
    for (const a of r.errors.brokenAssets.slice(0, 10)) {
      const status = a.status ? dim(` [${a.status}]`) : r.statusCodesAvailable ? "" : dim(" [status needs --backend chrome]");
      console.log(`    ${red("✗")} ${a.type} ${a.source}${status}`);
    }
  }
  if (d.overflowLayouts) {
    console.log(`  ${bold("layout overflow")} ${dim(`(${d.overflowLayouts})`)}`);
    for (const v of r.errors.responsive) {
      const worst = v.offenders[0] ? ` — ${v.offenders[0].elementSelector}` : "";
      console.log(`    ${red("✗")} ${v.viewport} overflows by ${v.overflowWidth}px${worst}`);
    }
  }
  if (d.deadClicks) {
    console.log(`  ${bold("dead clicks")} ${dim(`(${d.deadClicks})`)}`);
    for (const c of r.errors.deadClicks) console.log(`    ${red("✗")} (${c.coordinates.x}, ${c.coordinates.y})`);
  }
  console.log();
}

function printCrawlHuman(r: any) {
  console.log(`${bold(r.targetUrl)}\n`);
  const skipNote = r.skipped ? dim(` (${r.skipped} disabled, skipped)`) : "";
  console.log(`  ${r.controlsFound} control${r.controlsFound === 1 ? "" : "s"} found, ${r.controlsTested} tested${skipNote}`);
  console.log(`  ${green("✓")} ${r.alive} responded`);
  if (!r.dead.length) {
    console.log(green("\n✓ every control is wired up\n"));
    return;
  }
  console.log(`  ${red("✗")} ${r.dead.length} dead\n`);
  const w = Math.max(...r.dead.map((d: any) => String(d.ref).length));
  for (const d of r.dead) {
    const why = d.blockedBy ? `blocked by ${d.blockedBy}` : "no handler fired";
    const label = d.text ? dim(` ${JSON.stringify(d.text)}`) : "";
    console.log(`    ${red("✗")} ${String(d.ref).padEnd(w)}${label}  ${yellow(why)}`);
  }
  console.log();
}

function printTreeHuman(r: any) {
  console.log(`${bold(`${r.interactiveElements.length} actionable element${r.interactiveElements.length === 1 ? "" : "s"}`)} ${dim(`${r.viewport.width}x${r.viewport.height}`)}`);
  console.log(dim(`  ${r.occluded} occluded, ${r.offscreen} off-viewport${r.truncated ? `, ${r.truncated} truncated` : ""}\n`));
  for (const el of r.interactiveElements) {
    const text = el.text ? ` ${JSON.stringify(el.text)}` : "";
    console.log(`  ${cyan(`(${el.center.x}, ${el.center.y})`)}  ${el.ref}${text}${el.disabled ? dim(" [disabled]") : ""}`);
  }
  console.log();
}

function printResponsiveHuman(r: any) {
  if (!r.violations.length) {
    console.log(green(`✓ no horizontal overflow across ${r.viewportsTested} viewport${r.viewportsTested === 1 ? "" : "s"}`));
    return;
  }
  console.log(red(`✗ overflow at ${r.violations.length} of ${r.viewportsTested} viewports\n`));
  for (const v of r.violations) {
    console.log(`  ${bold(v.viewport)} ${yellow(`+${v.overflowWidth}px`)}`);
    for (const o of v.offenders) console.log(`    ${o.elementSelector} ${dim(`+${o.overflowWidth}px`)}`);
  }
  console.log();
}

// ------------------------------------------------------------- introspection

/**
 * Environment check. The first thing to run after installing, and the first
 * thing to ask for when something behaves oddly.
 */
function runDoctor(json: boolean): number {
  const required = ">=1.4.0";
  const bunOk = Bun.semver.satisfies(Bun.version, required);
  const isMac = process.platform === "darwin";
  const chromePath = Bun.env.BUN_CHROME_PATH ?? CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
  const ok = bunOk && (isMac || chromePath !== null);

  const report = {
    version: VERSION,
    bun: { version: Bun.version, required, ok: bunOk },
    platform: { os: process.platform, arch: process.arch },
    backends: {
      webkit: {
        available: isMac,
        detail: isMac ? "system WebKit — no browser install needed" : "macOS only; use --backend chrome",
      },
      chrome: {
        available: chromePath !== null,
        path: chromePath,
        detail: chromePath ? "found" : "no Chrome/Chromium/Brave found — set BUN_CHROME_PATH",
      },
    },
    ok,
  };

  if (json) {
    console.log(JSON.stringify(report));
    return ok ? EXIT.ok : EXIT.problems;
  }

  const mark = (b: boolean) => (b ? green("✓") : red("✗"));
  console.log(`${bold(`flamingo ${VERSION}`)} ${dim("— " + TAGLINE)}\n`);
  console.log(`  ${mark(bunOk)} ${"bun".padEnd(9)} ${Bun.version} ${dim(`(requires ${required})`)}`);
  console.log(`    ${"platform".padEnd(9)} ${process.platform} ${process.arch}`);
  console.log(`  ${mark(isMac)} ${"webkit".padEnd(9)} ${report.backends.webkit.detail}`);
  console.log(`  ${mark(chromePath !== null)} ${"chrome".padEnd(9)} ${chromePath ?? report.backends.chrome.detail}`);
  console.log(ok ? green("\n✓ ready\n") : red("\n✗ not usable here — see above\n"));
  return ok ? EXIT.ok : EXIT.problems;
}

/**
 * The whole API as one JSON document: every MCP tool with its schema, every CLI
 * command with its flags and exit codes. An agent reads this once instead of
 * reading the docs.
 */
function schemaDoc() {
  return {
    name: "@ayuxy027/flamingo",
    version: VERSION,
    tagline: TAGLINE,
    runtime: { bun: ">=1.4.0" },
    backends: {
      default: "webkit",
      available: ["webkit", "chrome"],
      chromeOnly: ["interceptTraffic", "hoverCoordinate", "HTTP status codes in scanBrokenAssets"],
    },
    exitCodes: {
      "0": "completed, nothing wrong found",
      "1": "completed, problems found",
      "2": "usage error",
      "3": "runtime failure (browser launch or navigation failed)",
    },
    commands: Object.entries(COMMANDS).map(([name, c]) => ({
      name,
      args: c.args,
      summary: c.summary,
      flags: c.flags,
      exits: c.exits,
      examples: c.examples,
    })),
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

// ------------------------------------------------------------------ commands

async function runCli(argv: string[]): Promise<number> {
  const p = parseArgs(argv);

  if (p.flags.has("version")) { console.log(VERSION); return EXIT.ok; }
  if (p.flags.has("help")) {
    console.log(p.command && COMMANDS[p.command] ? commandHelp(p.command) : buildUsage());
    return EXIT.ok;
  }
  if (!p.command) { console.log(buildUsage()); return EXIT.usage; }
  if (!COMMANDS[p.command]) {
    throw new UsageError(`Unknown command: ${p.command}. Run \`flamingo --help\` for the list.`);
  }

  const json = p.flags.get("json") === true;
  if (p.command === "schema") {
    console.log(JSON.stringify(schemaDoc(), null, 2));
    return EXIT.ok;
  }
  // Colour is meaningless in a pipe and forbidden in --json output.
  COLOR = !json && !p.flags.has("no-color") && !Bun.env.NO_COLOR && Boolean(process.stdout.isTTY);

  const backend = (str(p.flags, "backend") ?? "webkit") as Backend;
  if (backend !== "webkit" && backend !== "chrome") {
    throw new UsageError(`--backend expects "webkit" or "chrome", got "${backend}"`);
  }

  const engineOpts: EngineOptions = {
    backend,
    chromePath: str(p.flags, "chrome-path"),
    width: num(p.flags, "width", 1280),
    height: num(p.flags, "height", 800),
  };

  if (p.command === "doctor") return runDoctor(json);

  if (p.command === "serve") {
    await runMcpServer(engineOpts);
    return EXIT.ok;
  }

  const url = requireUrl(p);
  const viewportSpec = str(p.flags, "viewports");
  const viewports = viewportSpec ? parseViewports(viewportSpec) : undefined;

  let engine: Engine | undefined;
  try {
    if (!json) process.stderr.write(dim(`launching ${backend}…\n`));
    engine = await Engine.open({ ...engineOpts, url });
  } catch (e: any) {
    process.stderr.write(red(`✗ ${e?.message ?? e}\n`));
    return EXIT.runtime;
  }

  try {
    switch (p.command) {
      case "audit": {
        const r = await engine.compileHealthReport({ viewports: viewports ?? [{ width: 1920, height: 1080 }, { width: 375, height: 812 }] });
        if (json) console.log(JSON.stringify(r));
        else printAuditHuman(r);
        return r.success ? EXIT.ok : EXIT.problems;
      }
      case "crawl": {
        const r = await engine.crawl({ max: num(p.flags, "max", 20), dwellMs: num(p.flags, "dwell", 700) });
        if (json) console.log(JSON.stringify(r));
        else printCrawlHuman(r);
        return r.dead.length ? EXIT.problems : EXIT.ok;
      }
      case "tree": {
        const r = await engine.getInteractiveTree({ max: num(p.flags, "max", 100) });
        if (json) console.log(JSON.stringify(r));
        else printTreeHuman(r);
        return EXIT.ok;
      }
      case "responsive": {
        const r = await engine.auditResponsiveness({ viewports, settleMs: num(p.flags, "settle", 250) });
        if (json) console.log(JSON.stringify(r));
        else printResponsiveHuman(r);
        return r.violations.length ? EXIT.problems : EXIT.ok;
      }
      case "shot": {
        const r = await engine.captureViewport({
          path: str(p.flags, "out"),
          format: (str(p.flags, "format") ?? "png") as "png" | "jpeg" | "webp",
        });
        if (json) console.log(JSON.stringify(r));
        else {
          console.log(`${green("✓")} ${r.path} ${dim(`${r.pixelSize.width}x${r.pixelSize.height}px, ${(r.sizeInBytes / 1024).toFixed(1)}KB`)}`);
          if (r.deviceScaleFactor !== 1) {
            console.log(dim(`  image is ${r.deviceScaleFactor}x the CSS viewport (${r.cssSize.width}x${r.cssSize.height}); click coordinates are CSS-space`));
          }
        }
        return EXIT.ok;
      }
    }
    return EXIT.ok;
  } finally {
    engine.close();
    Bun.WebView.closeAll();
  }
}

// ===========================================================================
// SECTION 5 — Entry point
//
// Guarded so `import { Engine } from "./flamingo.ts"` stays a pure library import.
// ===========================================================================

if (import.meta.main) {
  try {
    process.exit(await runCli(Bun.argv.slice(2)));
  } catch (e: any) {
    if (e instanceof UsageError) {
      process.stderr.write(`${red("✗")} ${e.message}\n\n${dim("Run `flamingo --help` for usage.")}\n`);
      process.exit(EXIT.usage);
    }
    process.stderr.write(`${red("✗")} ${e?.stack ?? e}\n`);
    process.exit(EXIT.runtime);
  }
}
