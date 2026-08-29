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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/**
 * Is this element pinned to the viewport by a fixed/sticky ancestor? Pinned
 * elements stay reachable at any scroll position, so a scroll pass must dedupe
 * them by identity rather than by document position.
 */
const PINNED = `const isPinned = (el) => {
    for (let n = el, hops = 0; n && n.nodeType === 1 && hops < 40; hops++) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
      const root = n.getRootNode();
      n = n.parentElement || (root && root.host) || null;
    }
    return false;
  };`;

/** What counts as "actionable" for an agent. */
const SELECTOR = `'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'`;

/**
 * Shadow DOM is not optional any more: every built-in form control, and most
 * component libraries, put their real controls behind a shadow root that
 * querySelectorAll cannot see. Both the element walk and the hit test pierce it.
 */
const DEEP = `const collectDeep = (root, sel, out) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.matches && el.matches(sel)) out.push(el);
      if (el.shadowRoot) collectDeep(el.shadowRoot, sel, out);
    }
    return out;
  };
  const deepElementFromPoint = (x, y) => {
    let el = document.elementFromPoint(x, y);
    for (let depth = 0; el && el.shadowRoot && depth < 10; depth++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const deepStack = (x, y) => {
    const stack = document.elementsFromPoint(x, y);
    const top = deepElementFromPoint(x, y);
    return top && top !== stack[0] ? [top, ...stack] : stack;
  };`;

/**
 * Flat list of elements an agent can act on.
 *
 * The filtering is the whole point: without it a page with a mega-menu still
 * returns hundreds of entries and we are back to context exhaustion. Elements
 * are dropped when off-viewport, zero-size, styled invisible, or occluded by
 * something else at their own centre point.
 */
const interactiveTree = (max: number) => `(() => {
  ${DESCRIBE}
  ${DEEP}
  ${PINNED}
  const SEL = ${SELECTOR};
  const vw = innerWidth, vh = innerHeight;
  const out = [], seen = new Set();
  const blockers = new Map();
  let occluded = 0, offscreen = 0, truncated = 0, hidden = 0;
  for (const el of collectDeep(document, SEL, [])) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { hidden++; continue; }
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) { offscreen++; continue; }
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") { hidden++; continue; }
    // Centre of the *visible* part, so half-scrolled elements still hit-test.
    const x = Math.round((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2);
    const y = Math.round((Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2);
    const hit = deepElementFromPoint(x, y);
    // el.contains(hit) keeps <button><span>text</span></button>. An ancestor hit
    // means something else owns that point, so the element is not clickable there.
    const reachable = hit && (el === hit || el.contains(hit) || (el.shadowRoot && el.shadowRoot.contains(hit)));
    if (!reachable) {
      occluded++;
      // A cookie banner or modal blanketing the page shows up here as one ref
      // blocking many controls, which is the actionable form of "12 occluded".
      const by = describe(hit);
      if (by) blockers.set(by, (blockers.get(by) || 0) + 1);
      continue;
    }
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
      // center is clipped to the viewport so it is always clickable; documentX/Y
      // come from the unclipped rect so they are stable identity across scrolls.
      center: { x, y },
      documentX: Math.round(r.left + scrollX),
      documentY: Math.round(r.top + scrollY),
      boundingBox: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
    const t = el.getAttribute("type"); if (t) item.type = t;
    if (el.tagName === "A" && el.href) {
      item.href = el.href;
      // Same document (or a pure hash/javascript: link) means clicking it is a
      // JS question; a different document means clicking it just leaves the page.
      item.leavesPage = el.href.split("#")[0] !== location.href.split("#")[0] && !/^javascript:/i.test(el.getAttribute("href") || "");
    }
    if (el.disabled) item.disabled = true;
    // Clicking a <select> opens a native popup that blocks the renderer until a
    // human dismisses it. Nothing automated may click one.
    if (el.tagName === "SELECT") item.nativePicker = true;
    if (el.getRootNode() !== document) item.inShadowDom = true;
    if (isPinned(el)) item.pinned = true;
    out.push(item);
  }
  // Cross-origin and srcdoc frames run in another context that evaluate() cannot
  // reach. Reporting the count stops an agent concluding the page is empty.
  const frames = [...document.querySelectorAll("iframe,frame")].map((f) => ({
    ref: describe(f), src: f.getAttribute("src") || (f.hasAttribute("srcdoc") ? "srcdoc" : null),
  }));
  const blockedBy = [...blockers.entries()]
    .map(([ref, count]) => ({ ref, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  // A cheap fingerprint of visible text, so a change that touches no interactive
  // element — a result message, a validation error — is still detected.
  let contentHash = 0;
  const body = document.body;
  const shown = body ? String(body.innerText || "").slice(0, 20000) : "";
  for (let i = 0; i < shown.length; i++) contentHash = (contentHash * 31 + shown.charCodeAt(i)) | 0;
  return {
    interactiveElements: out,
    truncated, occluded, offscreen, hidden,
    blockedBy,
    contentHash,
    contentLength: shown.length,
    frames,
    url: location.href,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - vh)) },
    viewport: { width: vw, height: vh },
  };
})()`;

/**
 * Why a click at (x, y) will or will not reach an interactive element.
 *
 * WebView's click(selector) already refuses obscured elements, but it only ever
 * reports "timeout waiting to be actionable". This says what is in the way.
 */
const hitTest = (x: number, y: number) => `(() => {
  ${DESCRIBE}
  ${DEEP}
  const SEL = ${SELECTOR};
  const x = ${x}, y = ${y};
  const none = { isBlocked: false, intendedElement: null, blockingElement: null, pointerEventsStyle: null, stack: [] };
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { ...none, outsideViewport: true };
  const stack = deepStack(x, y);
  if (!stack.length) return { ...none, outsideViewport: false };
  const idx = stack.findIndex((e) => e.matches && e.matches(SEL));
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

/**
 * Headings and landmarks with document-space positions, so a scroll pass can
 * assemble an outline of the whole page rather than one viewport at a time.
 */
const outlineProbe = `(() => {
  ${DESCRIBE}
  ${PINNED}
  const out = [];
  const HEADINGS = "h1,h2,h3,h4,[role=heading]";
  const LANDMARKS = "main,nav,header,footer,aside,form,section[aria-label],[role=region][aria-label]";
  const push = (el, text, level) => {
    if (!text) return;
    // Pinned chrome rides along with the scroll, so its document position is
    // meaningless and it would otherwise be re-recorded at every step.
    if (isPinned(el)) return;
    const r = el.getBoundingClientRect();
    out.push({ ref: describe(el), tag: el.tagName.toLowerCase(), level, text, documentY: Math.round(r.top + scrollY) });
  };
  const clean = (v) => (v || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  for (const el of document.querySelectorAll(HEADINGS)) {
    const m = /^H([1-6])$/.exec(el.tagName);
    push(el, clean(el.innerText), m ? Number(m[1]) : Number(el.getAttribute("aria-level")) || null);
  }
  for (const el of document.querySelectorAll(LANDMARKS)) {
    // Landmarks use their label only: innerText on <main> is the whole page.
    push(el, clean(el.getAttribute("aria-label")), null);
  }
  out.sort((a, b) => a.documentY - b.documentY);
  return out;
})()`;

/**
 * Containers that scroll independently of the document. A page-level scroll
 * never reveals their contents, so an agent needs to be told they exist.
 */
const scrollableProbe = `(() => {
  ${DESCRIBE}
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const st = getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(st.overflowY) || /(auto|scroll)/.test(st.overflowX);
    if (!scrolls) continue;
    const hiddenY = el.scrollHeight - el.clientHeight;
    const hiddenX = el.scrollWidth - el.clientWidth;
    if (hiddenY < 20 && hiddenX < 20) continue;
    out.push({ ref: describe(el), hiddenPixelsY: Math.round(hiddenY), hiddenPixelsX: Math.round(hiddenX) });
    if (out.length >= 8) break;
  }
  return out;
})()`;

/** Elements pinned to the viewport — they follow a scroll and can hide content. */
const stickyProbe = `(() => {
  ${DESCRIBE}
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const p = getComputedStyle(el).position;
    if (p !== "fixed" && p !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 8) continue;
    out.push({ ref: describe(el), position: p, height: Math.round(r.height), width: Math.round(r.width) });
    if (out.length >= 10) break;
  }
  return out;
})()`;

/**
 * Resolve once layout has stopped changing, or after `maxMs`.
 *
 * There is no CDP "layout settled" event, so the alternative is a fixed sleep
 * long enough for the worst case — which is wasted on every page that is not the
 * worst case. Two identical frames is a good enough definition of settled.
 */
const settleProbe = (maxMs: number) => `new Promise((resolve) => {
  const started = performance.now();
  let last = null, stable = 0;
  const signature = () => {
    const d = document.documentElement;
    return d.scrollWidth + "x" + d.scrollHeight + "x" + innerWidth + "x" + innerHeight;
  };
  const tick = () => {
    const sig = signature();
    if (sig === last) {
      if (++stable >= 2) return resolve({ settled: true, ms: Math.round(performance.now() - started) });
    } else { stable = 0; last = sig; }
    if (performance.now() - started > ${maxMs}) return resolve({ settled: false, ms: Math.round(performance.now() - started) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

/**
 * First visible element matching a selector and/or containing some text,
 * returned in the same shape as a tree entry so it is immediately clickable.
 */
const findElement = (selector: string | null, textContains: string | null) => `(() => {
  ${DESCRIBE}
  ${DEEP}
  ${PINNED}
  const sel = ${JSON.stringify(selector)};
  const needle = ${JSON.stringify(textContains)} ? ${JSON.stringify(textContains)}.toLowerCase() : null;
  const vw = innerWidth, vh = innerHeight;
  const SKIP = { SCRIPT: 1, STYLE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, NOSCRIPT: 1 };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return null;
    return r;
  };

  const matches = [];
  for (const el of collectDeep(document, sel || "*", [])) {
    if (SKIP[el.tagName]) continue;
    if (needle) {
      const t = el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      if (!String(t).toLowerCase().includes(needle)) continue;
    }
    if (!visible(el)) continue;
    matches.push(el);
    // A selector with no text filter is unambiguous; take the first hit.
    if (!needle) break;
  }
  if (!matches.length) return null;

  // Text matches every ancestor of the text too, so prefer the tightest element:
  // the one that contains no other match.
  const el = matches.find((m) => !matches.some((o) => o !== m && m.contains(o))) || matches[0];
  const r = el.getBoundingClientRect();
  const x = Math.round((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2);
  const y = Math.round((Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2);
  return {
    ref: describe(el),
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.value || "").trim().replace(/\\s+/g, " ").slice(0, 80),
    center: { x, y },
    documentX: Math.round(r.left + scrollX),
    documentY: Math.round(r.top + scrollY),
    boundingBox: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    inViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
    pinned: isPinned(el),
  };
})()`;

/** Scroll geometry, read on its own because it is polled between scroll steps. */
const scrollMetrics = `({
  scrollY: Math.round(scrollY),
  viewportHeight: innerHeight,
  pageHeight: Math.round(document.documentElement.scrollHeight),
  maxScrollY: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight))
})`;

const selectAt = (x: number, y: number) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el || el.tagName !== "SELECT") return null;
  return { value: el.value, optionCount: el.options.length, options: [...el.options].map((o) => o.text).slice(0, 20) };
})()`;

const focusedFieldValue = `(() => {
  const a = document.activeElement;
  if (!a) return null;
  return { tag: a.tagName.toLowerCase(), type: a.getAttribute("type"), value: a.value ?? null, editable: a.isContentEditable === true };
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
//
// The probe only *accumulates*; deciding when to stop is the host's job, so it can
// weigh page signals against network and navigation together and exit the moment
// any of them fires instead of sleeping out a fixed window.
const installReactionProbe = `(() => {
  const w = window;
  if (w.__flamingoCleanup) { try { w.__flamingoCleanup(); } catch (e) {} }
  const a0 = document.activeElement;
  const before = a0 ? a0.tagName + "#" + (a0.id || "") : "";
  w.__flamingoMut = 0;
  w.__flamingoFocus = false;
  w.__flamingoDialogs = 0;
  w.__flamingoUrl0 = location.href;
  // Dialogs are a real reaction and would otherwise read as "nothing happened".
  // They are answered *negatively* on purpose: auto-confirming a crawl through
  // someone's admin panel would happily delete things.
  const nativeDialogs = { alert: w.alert, confirm: w.confirm, prompt: w.prompt };
  w.alert = function () { w.__flamingoDialogs++; };
  w.confirm = function () { w.__flamingoDialogs++; return false; };
  w.prompt = function () { w.__flamingoDialogs++; return null; };
  const obs = new MutationObserver((ms) => { w.__flamingoMut += ms.length; });
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  // Focus is a reaction a MutationObserver cannot see, and clicking a field
  // changes nothing else. Only fields count: buttons take focus on every click.
  const onFocus = (e) => {
    const t = e.target;
    if (!t || !t.tagName) return;
    const now = t.tagName + "#" + (t.id || "");
    if (now === before) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable === true) w.__flamingoFocus = true;
  };
  document.addEventListener("focusin", onFocus, true);
  w.__flamingoCleanup = () => {
    try { obs.disconnect(); } catch (e) {}
    document.removeEventListener("focusin", onFocus, true);
    w.alert = nativeDialogs.alert;
    w.confirm = nativeDialogs.confirm;
    w.prompt = nativeDialogs.prompt;
    w.__flamingoCleanup = null;
  };
  return true;
})()`;

/** `mutations: -1` means the probe is gone, i.e. navigation replaced the context. */
const readReactionProbe = `({
  mutations: typeof window.__flamingoMut === "number" ? window.__flamingoMut : -1,
  focusChanged: window.__flamingoFocus === true,
  dialogs: window.__flamingoDialogs || 0,
  urlChanged: typeof window.__flamingoUrl0 === "string" && location.href !== window.__flamingoUrl0
})`;

/**
 * Forward uncaught errors and unhandled rejections into console.error.
 *
 * Bun.WebView's console capture only sees explicit console.* calls, so a real
 * `throw` — the most important thing a test tool can report — is otherwise
 * invisible. Routing them through console.error is what makes them visible.
 */
const installErrorForwarder = `(() => {
  if (window.__flamingoErrHook) return true;
  window.__flamingoErrHook = true;
  const fmt = (v) => {
    if (!v) return String(v);
    // WebKit's Error.stack carries only frames, Chrome's leads with the message.
    // Build the headline ourselves so both backends report the same thing.
    const head = v.message ? (v.name ? v.name + ": " : "") + v.message : "";
    const stack = v.stack ? String(v.stack) : "";
    if (head && stack) return stack.indexOf(v.message) === 0 || stack.indexOf(head) === 0 ? stack : head + " | " + stack;
    return head || stack || String(v);
  };
  addEventListener("error", (e) => {
    console.error("[uncaught] " + fmt(e.error || e.message).slice(0, 500));
  });
  addEventListener("unhandledrejection", (e) => {
    console.error("[unhandled rejection] " + fmt(e.reason).slice(0, 500));
  });
  return true;
})()`;

const stopReactionProbe = `(() => { if (window.__flamingoCleanup) window.__flamingoCleanup(); return true; })()`;

const viewportInfo = `({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY })`;

// =========================================================================
// SECTION 2 — Engine — the twelve agent-facing APIs
//
// Everything below is backend-agnostic except the three that need CDP, which
// throw a message naming the fix when called on the webkit backend.
// =========================================================================

export type Backend = "webkit" | "chrome";

interface ReactionProbe {
  mutations: number;
  focusChanged: boolean;
  dialogs: number;
  urlChanged: boolean;
}

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
  /** Called as long-running sweeps advance. Use it to show progress. */
  onProgress?: (stage: string, detail: string) => void;
  /**
   * Where cookies, localStorage and IndexedDB live.
   *
   * Ephemeral by default, so runs never contaminate each other. Point it at a
   * directory to keep a session between runs — which is how you test an app
   * that requires a login without logging in every time.
   */
  profileDirectory?: string;
  /** How long an in-page evaluate may stall before the view is rebuilt. @default 10000 */
  evaluateTimeoutMs?: number;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface InteractiveElement {
  ref: string;
  tag: string;
  text: string;
  /** Viewport-space centre, clipped so it is always a valid click target. */
  center: { x: number; y: number };
  /** Document-space position of the element's top-left, stable across scrolling. */
  documentX: number;
  documentY: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  type?: string;
  disabled?: boolean;
  /** Resolved href, for anchors. */
  href?: string;
  /** This anchor points at a different document, so clicking it only navigates away. */
  leavesPage?: boolean;
  /** Held in place by a fixed/sticky ancestor, so reachable at any scroll position. */
  pinned?: boolean;
  inShadowDom?: boolean;
  /** A <select>: clicking it opens a native popup that blocks the renderer. */
  nativePicker?: boolean;
}

export interface InteractiveTree {
  interactiveElements: InteractiveElement[];
  truncated: number;
  occluded: number;
  offscreen: number;
  hidden: number;
  /** What is covering the occluded controls, commonest blocker first. */
  blockedBy: Array<{ ref: string; count: number }>;
  /** Fingerprint of visible text, for detecting change that touches no control. */
  contentHash: number;
  contentLength: number;
  frames: Array<{ ref: string | null; src: string | null }>;
  url: string;
  scroll: { x: number; y: number; maxY: number };
  viewport: { width: number; height: number };
}

/**
 * One step of an agent's feedback loop: where it is, what it can do next, and
 * what changed since it last looked.
 */
export interface Observation {
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  scroll: { y: number; maxY: number; atBottom: boolean };
  /** Actionable elements, already filtered to what is genuinely reachable. */
  elements: InteractiveElement[];
  elementsTruncated: number;
  /** What is covering the unreachable controls, if anything. */
  blockedBy: Array<{ ref: string; count: number }>;
  frames: number;
  /** Console errors since the previous observe() — the loop's failure signal. */
  newErrors: string[];
  /** Requests that failed since the previous observe(). Chrome backend only. */
  newFailedRequests: Array<{ url: string; status?: number; errorReason?: string }>;
  /** False when nothing at all changed since the previous observe(). */
  changed: boolean;
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

/**
 * Labels that read destructive. Controls matching these are skipped by default
 * during automated interaction — crawling someone's admin panel should not
 * delete anything. Override with includeDestructive / --include-destructive.
 */
const DESTRUCTIVE_LABEL =
  /\b(delete|remove|destroy|drop|erase|wipe|purge|log ?out|sign ?out|deactivate|deregister|unsubscribe|revoke|cancel subscription|close account|reset)\b/i;

const FIELD_TAGS = new Set(["input", "textarea", "select"]);

/** Type-appropriate sample data, so a field is tested with something it may accept. */
const SAMPLE_INPUT: Record<string, string> = {
  email: "flamingo@example.com",
  password: "Fl4mingo!test",
  tel: "+15550100",
  url: "https://example.com",
  number: "42",
  search: "flamingo",
  date: "2026-01-01",
  time: "12:30",
  text: "flamingo test",
};

/** A browser host that died underneath us, as opposed to a real usage error. */
function isTransientHostFailure(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /host process|killed by signal|WebView closed|ERR_WEBVIEW/i.test(msg);
}

/** The APIs that cannot work without CDP, named here so the error can list them. */
const CHROME_ONLY = "interceptTraffic, hoverCoordinate, and HTTP status codes in scanBrokenAssets";

export class Engine {
  readonly backend: Backend;

  private _view: Bun.WebView;
  /** The underlying Bun.WebView. Public escape hatch for anything not wrapped here. */
  get view(): Bun.WebView {
    return this._view;
  }

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
  private viewOptions: Bun.WebView.ConstructorOptions;
  /** A navigation that timed out leaves the view permanently unable to navigate. */
  private navigationPoisoned = false;
  private recycles = 0;
  private readonly evaluateTimeoutMs: number;
  private readonly onProgress: (stage: string, detail: string) => void;
  private lastObservation: { consoleIndex: number; networkIndex: number; signature: string } | null = null;

  private constructor(opts: EngineOptions) {
    this.backend = opts.backend ?? "webkit";
    this.cap = opts.bufferSize ?? 500;
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 800;
    this.evaluateTimeoutMs = opts.evaluateTimeoutMs ?? 10_000;
    this.onProgress = opts.onProgress ?? (() => {});

    let backend: Bun.WebView.Backend;
    if (this.backend === "chrome") {
      const path = opts.chromePath ?? Bun.env.BUN_CHROME_PATH ?? CHROME_CANDIDATES.find((p) => existsSync(p));
      // url:false keeps us from auto-attaching to the user's own running Chrome,
      // which would pop an "Allow remote debugging?" dialog on every connection.
      backend = { type: "chrome", url: false, ...(path ? { path } : {}) };
    } else {
      backend = "webkit";
    }

    this.viewOptions = {
      width: this.width,
      height: this.height,
      backend,
      ...(opts.profileDirectory ? { dataStore: { directory: opts.profileDirectory } } : {}),
      // Wired at construction so page errors are captured before any navigation.
      console: (type: string, ...args: unknown[]) => this.pushConsole(type, args),
    };
    this._view = this.buildView();
  }

  /** Construct a view and attach the listeners every view needs. */
  private buildView(): Bun.WebView {
    const view = new Bun.WebView(this.viewOptions);
    view.onNavigated = () => { this.navCount++; };
    return view;
  }

  /**
   * Replace a view that can no longer navigate.
   *
   * Once a navigation is left pending — a server that accepts the connection and
   * never answers — every later navigate on that view throws ERR_INVALID_STATE,
   * and neither reload() nor anything else clears it. Rebuilding is the only
   * recovery. The console and network buffers live on the Engine, so nothing
   * recorded so far is lost; one hung link cannot kill a whole crawl.
   */
  private async recycleView(): Promise<void> {
    const old = this._view;
    this._view = this.buildView();
    this.navigationPoisoned = false;
    this.evalChain = Promise.resolve();
    this.recycles++;
    try { old.close(); } catch { /* already gone */ }
    await this._view.navigate("about:blank");
    await this._view.resize(this.width, this.height);
    if (this.backend === "chrome") await this.enableNetwork();
    await this.installErrorCapture();
  }

  static async open(opts: EngineOptions = {}): Promise<Engine> {
    const engine = new Engine(opts);
    try {
      await engine.initialise(opts.url);
    } catch (e) {
      // The browser host process is shared by every view in this process, and can
      // be torn down underneath one that is still starting. Rebuilding respawns
      // it, which turns a transient death into a hiccup instead of a failed run.
      if (!isTransientHostFailure(e)) {
        engine.close();
        throw e;
      }
      try {
        await engine.recycleView();
        if (opts.url) await engine.goto(opts.url);
      } catch (retryError) {
        engine.close();
        throw retryError;
      }
    }
    return engine;
  }

  private async initialise(url?: string): Promise<void> {
    // about:blank first: it establishes the CDP session, which is what lets
    // Network.enable be wired BEFORE the first real navigation. Enabling after
    // would miss every request the page fires on load — including the failures.
    await this.view.navigate("about:blank");
    // The two backends read the constructor's width/height differently: webkit
    // sizes the CSS viewport, chrome sizes the outer window and loses ~81px to
    // browser chrome even headless. resize() means viewport on both, so this
    // makes "the viewport you asked for" true regardless of backend.
    await this.view.resize(this.width, this.height);
    if (this.backend === "chrome") await this.enableNetwork();
    await this.installErrorCapture();
    if (url) await this.goto(url);
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

  /**
   * Start capturing uncaught errors. On chrome the hook is registered to run
   * before any page script, so load-time throws are caught too; on webkit it can
   * only be installed once a document exists, so it catches everything after load.
   */
  private async installErrorCapture(): Promise<void> {
    if (this.backend === "chrome") {
      const source = installErrorForwarder.replace(/^\(\(\) => \{/, "(() => {");
      await this.view.cdp("Page.addScriptToEvaluateOnNewDocument", { source }).catch(() => {});
    }
    await this.evaluate(installErrorForwarder).catch(() => {});
  }

  private requireChrome(api: string): void {
    if (this.backend === "chrome") return;
    throw new Error(
      `${api}() requires backend: "chrome" — CDP is unavailable on the webkit backend. ` +
        `Construct with Engine.open({ backend: "chrome" }). Only ${CHROME_ONLY} need it; ` +
        `every other API works on webkit.`,
    );
  }

  /**
   * Run an expression in the page, with a watchdog.
   *
   * A blocked renderer never answers — a native `<select>` popup is the known
   * cause, and there is no reason to assume it is the only one. Rather than hang
   * forever we abandon the stuck view, rebuild it, and report it. The buffers
   * survive because they live on the Engine.
   */
  private async evaluateGuarded<T>(expr: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">((resolve) => {
      timer = setTimeout(() => resolve("stalled"), this.evaluateTimeoutMs);
    });
    // The abandoned promise must not surface later as an unhandled rejection.
    const pending = this._view.evaluate<T>(expr).then((value) => ({ value }));
    pending.catch(() => {});
    const outcome = await Promise.race([pending, stalled]);
    clearTimeout(timer);
    if (outcome === "stalled") {
      await this.recycleView();
      throw new Error(
        `page stopped responding to evaluate after ${this.evaluateTimeoutMs}ms; the view was rebuilt. ` +
          `A native picker (for example an open <select> dropdown) blocks the renderer.`,
      );
    }
    return outcome.value;
  }

  // Bun.WebView allows only one evaluate() in flight per view and throws
  // ERR_INVALID_STATE on a second, so all page calls funnel through one chain.
  private evaluate<T>(expr: string): Promise<T> {
    const run = this.evalChain.then(
      () => this.evaluateGuarded<T>(expr),
      () => this.evaluateGuarded<T>(expr),
    );
    this.evalChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // ------------------------------------------------------------- navigation

  /**
   * Navigate and wait for the main frame load to finish.
   *
   * The timeout is not optional comfort: `navigate()` resolves on load, so a
   * server that accepts the connection and never finishes the response would
   * otherwise hang the engine forever. On timeout we return rather than throw —
   * a page stuck on one slow asset usually has a perfectly testable DOM — and
   * flag it so the caller can decide.
   */
  async goto(
    url: string,
    { timeoutMs = 30_000 } = {},
  ): Promise<{ url: string; title: string; timedOut: boolean; recovered: boolean }> {
    const recovered = await this.healIfPoisoned();
    const { timedOut } = await this.navigationOp(() => this.view.navigate(url), timeoutMs);
    // A navigation replaces the JS context, taking the error hook with it.
    await this.evaluate(installErrorForwarder).catch(() => {});
    return { url: this.view.url, title: this.view.title, timedOut, recovered };
  }

  /**
   * Go back in history.
   *
   * Bun 1.4.0, chrome backend: `goBack()` never resolves when there is no further
   * history, and the pending navigation it leaves behind poisons the view for
   * good. Guarding it turns an unrecoverable hang into a reported timeout.
   */
  async goBack({ timeoutMs = 10_000 } = {}): Promise<{ url: string; timedOut: boolean }> {
    await this.healIfPoisoned();
    const { timedOut } = await this.navigationOp(
      () => (this.view as unknown as { goBack(): Promise<void> }).goBack(),
      timeoutMs,
    );
    return { url: this.view.url, timedOut };
  }

  /** Reload the current page. */
  async reload({ timeoutMs = 30_000 } = {}): Promise<{ url: string; timedOut: boolean }> {
    await this.healIfPoisoned();
    const { timedOut } = await this.navigationOp(() => this.view.reload(), timeoutMs);
    await this.evaluate(installErrorForwarder).catch(() => {});
    return { url: this.view.url, timedOut };
  }

  private async healIfPoisoned(): Promise<boolean> {
    if (!this.navigationPoisoned) return false;
    await this.recycleView();
    return true;
  }

  /**
   * Run a navigation with a deadline.
   *
   * Every navigation primitive here can fail to resolve — a server that never
   * answers, or `goBack()` past the start of history — and each one leaves the
   * view unable to navigate again. Timing out and marking the view for rebuild is
   * the only recovery.
   */
  private async navigationOp(op: () => Promise<void>, timeoutMs: number): Promise<{ timedOut: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    const running = op().then(
      () => "done" as const,
      (e) => { failure = e; return "failed" as const; },
    );
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([running, deadline]);
    clearTimeout(timer);
    if (outcome === "failed") throw failure;
    if (outcome === "timeout") this.navigationPoisoned = true;
    return { timedOut: outcome === "timeout" };
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

  /**
   * Wait until something appears.
   *
   * The missing half of click-then-check: an agent that clicks "Save" needs to
   * wait for the confirmation, and without this it can only sleep and hope.
   * Polls at `pollMs` and returns as soon as the element exists and is visible,
   * in the same shape as a tree entry so it can be clicked straight away.
   */
  async waitFor({
    selector,
    textContains,
    timeoutMs = 5_000,
    pollMs = 50,
  }: {
    selector?: string;
    textContains?: string;
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<{ found: boolean; waitedMs: number; element: Record<string, unknown> | null }> {
    if (!selector && !textContains) {
      throw new Error("waitFor needs a selector, textContains, or both.");
    }
    const started = Date.now();
    const deadline = started + timeoutMs;
    const probe = findElement(selector ?? null, textContains ?? null);
    for (;;) {
      let hit: Record<string, unknown> | null = null;
      try {
        hit = await this.evaluate<Record<string, unknown> | null>(probe);
      } catch {
        // A navigation mid-wait destroys the context; keep waiting for the new one.
      }
      if (hit) return { found: true, waitedMs: Date.now() - started, element: hit };
      if (Date.now() >= deadline) return { found: false, waitedMs: Date.now() - started, element: null };
      await Bun.sleep(pollMs);
    }
  }

  /** Wait until an element matching the criteria is gone (a spinner, a modal). */
  async waitForGone({
    selector,
    textContains,
    timeoutMs = 5_000,
    pollMs = 50,
  }: {
    selector?: string;
    textContains?: string;
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<{ gone: boolean; waitedMs: number }> {
    if (!selector && !textContains) {
      throw new Error("waitForGone needs a selector, textContains, or both.");
    }
    const started = Date.now();
    const deadline = started + timeoutMs;
    const probe = findElement(selector ?? null, textContains ?? null);
    for (;;) {
      let hit: unknown = null;
      try {
        hit = await this.evaluate(probe);
      } catch {
        hit = null;
      }
      if (!hit) return { gone: true, waitedMs: Date.now() - started };
      if (Date.now() >= deadline) return { gone: false, waitedMs: Date.now() - started };
      await Bun.sleep(pollMs);
    }
  }

  /**
   * A single step of the agent loop.
   *
   * An agent working towards a goal needs the same four things every turn: where
   * it is, what it can act on, whether anything broke, and whether its last
   * action did anything. Assembling that from five separate calls costs five
   * round trips and leaves the agent to diff the results itself.
   *
   * `newErrors` and `changed` are deltas since the previous observe(), which is
   * what lets a loop tell progress from a no-op without keeping its own state.
   */
  async observe({ maxElements = 40 }: { maxElements?: number } = {}): Promise<Observation> {
    const tree = await this.getInteractiveTree({ max: maxElements });

    const consoleIndex = this.consoleBuf.length;
    const networkIndex = this.networkBuf.length;
    const previous = this.lastObservation;

    const newErrors = this.consoleBuf
      .slice(previous?.consoleIndex ?? 0)
      .filter((l) => l.type === "error")
      .map((l) => l.text.slice(0, 300));

    const newFailedRequests = this.networkBuf
      .slice(previous?.networkIndex ?? 0)
      .filter((n) => (n.status !== undefined && n.status >= 400) || n.errorText)
      .map((n) => ({
        url: n.url,
        ...(n.status !== undefined ? { status: n.status } : {}),
        ...(n.errorText ? { errorReason: n.errorText } : {}),
      }));

    // A cheap fingerprint of the observable state: if it is identical, the last
    // action achieved nothing, which is exactly what a loop needs to know.
    const signature = [
      tree.url,
      tree.scroll.y,
      tree.contentHash,
      tree.contentLength,
      tree.interactiveElements.map((e) => `${e.ref}:${e.documentY}:${e.text}`).join("|"),
    ].join("#");

    this.lastObservation = { consoleIndex, networkIndex, signature };

    return {
      url: tree.url,
      title: this.view.title,
      loading: this.view.loading,
      viewport: tree.viewport,
      scroll: { y: tree.scroll.y, maxY: tree.scroll.maxY, atBottom: tree.scroll.y >= tree.scroll.maxY },
      elements: tree.interactiveElements,
      elementsTruncated: tree.truncated,
      blockedBy: tree.blockedBy,
      frames: tree.frames.length,
      newErrors,
      newFailedRequests,
      changed: previous === null || previous.signature !== signature,
    };
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
      await this.settle(settleMs);
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
    await this.settle(settleMs);
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
  async detectDeadClicks({
    x,
    y,
    timeoutMs = 600,
    pollMs = 15,
  }: {
    x: number;
    y: number;
    timeoutMs?: number;
    pollMs?: number;
  }) {
    await this.evaluate(installReactionProbe);
    const net0 = this.networkBuf.length;
    const log0 = this.consoleBuf.length;
    const nav0 = this.navCount;
    const started = Date.now();

    await this.view.click(x, y);

    let mutations = 0;
    let focusChanged = false;
    let dialogs = 0;
    let urlChanged = false;
    let contextLost = false;
    let reason = "timeout";
    const deadline = started + timeoutMs;

    // Poll instead of sleeping the full window: a live control usually answers in
    // one or two ticks, so this is the difference between ~20ms and ~600ms per click.
    for (;;) {
      let probe: ReactionProbe | undefined;
      try {
        probe = await this.evaluate<ReactionProbe>(readReactionProbe);
      } catch {
        contextLost = true;
        reason = "context-lost";
        break;
      }
      if (!probe || probe.mutations < 0) {
        contextLost = true;
        reason = "context-lost";
        break;
      }
      mutations = probe.mutations;
      focusChanged = probe.focusChanged;
      dialogs = probe.dialogs;
      urlChanged = probe.urlChanged;

      if (mutations > 0) { reason = "dom"; break; }
      if (focusChanged) { reason = "focus"; break; }
      if (dialogs > 0) { reason = "dialog"; break; }
      // history.pushState fires no load event, so an SPA route change is
      // invisible to navigation tracking — the URL is the only tell.
      if (urlChanged) { reason = "spa-navigation"; break; }
      if (this.navCount > nav0) { reason = "navigation"; break; }
      if (this.networkBuf.length > net0) { reason = "network"; break; }
      if (this.consoleBuf.length > log0) { reason = "console"; break; }
      if (Date.now() >= deadline) break;
      await Bun.sleep(pollMs);
    }

    try { await this.evaluate(stopReactionProbe); } catch { /* context gone */ }

    const navigated = this.navCount > nav0 || contextLost;
    const networkRequests = this.backend === "chrome" ? this.networkBuf.length - net0 : null;
    const consoleLogs = this.consoleBuf.length - log0;
    const isDeadClick = reason === "timeout" && !navigated;

    return {
      isDeadClick,
      coordinates: { x, y },
      reason,
      reactionMs: Date.now() - started,
      navigated,
      focusChanged,
      openedDialog: dialogs > 0,
      spaNavigation: urlChanged,
      registeredDOMChanges: mutations,
      registeredNetworkRequests: networkRequests,
      registeredConsoleLogs: consoleLogs,
      ...(networkRequests === null
        ? { note: 'network signal unavailable on webkit; use backend "chrome" for full fidelity' }
        : {}),
    };
  }

  // ------------------------------------------- 4.4 agentic context and health

  /** 10. Compact, viewport-filtered list of everything an agent can act on. */
  async getInteractiveTree({ max = 100 }: { max?: number } = {}): Promise<InteractiveTree> {
    return this.evaluate<InteractiveTree>(interactiveTree(max));
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
  async crawl({ max = 20, dwellMs = 400 }: { max?: number; dwellMs?: number } = {}) {
    const targetUrl = this.view.url;
    const tree = await this.getInteractiveTree({ max });
    // A <select> opens a blocking native popup, so it is never clicked.
    const candidates = tree.interactiveElements.filter((el) => !el.disabled && !el.nativePicker);
    const skipped = tree.interactiveElements.length - candidates.length;

    const dead: Array<Record<string, unknown>> = [];
    let alive = 0;

    for (const el of candidates) {
      if (el.leavesPage) {
        alive++;
        continue;
      }
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
      blockedBy: tree.blockedBy,
      truncated: tree.truncated,
    };
  }

  /**
   * Scroll the whole page and assemble one map of it.
   *
   * A single viewport is a keyhole: the tree honestly reports only what is on
   * screen, so anything below the fold is invisible to an agent. This walks the
   * page in overlapping steps and merges what it sees into document-space
   * coordinates, so every control can be reached later with scrollTo.
   *
   * Also answers two questions a static look cannot: does the page lazy-load
   * (its height grew while scrolling), and what is pinned over the content.
   */
  async scrollScan({
    maxSteps = 20,
    overlap = 0.15,
    settleMs = 120,
    maxElements = 400,
  }: { maxSteps?: number; overlap?: number; settleMs?: number; maxElements?: number } = {}) {
    await this.scrollToY(0);
    await Bun.sleep(settleMs);

    const elements = new Map<string, InteractiveElement>();
    const outline: Array<Record<string, unknown>> = [];
    const outlineSeen = new Set<string>();

    const first = await this.evaluate<{ pageHeight: number; viewportHeight: number; maxScrollY: number }>(scrollMetrics);
    const sticky = await this.evaluate<Array<Record<string, unknown>>>(stickyProbe);
    const scrollableContainers = await this.evaluate<Array<Record<string, unknown>>>(scrollableProbe);

    let steps = 0;
    let reachedBottom = false;
    let truncated = 0;
    let pageHeight = first.pageHeight;
    let lastScrollY = -1;

    for (steps = 0; steps < maxSteps; steps++) {
      const tree = await this.getInteractiveTree({ max: 200 });
      const scrollY = tree.scroll.y;

      for (const el of tree.interactiveElements) {
        // Identity comes from the unclipped document position: an element that is
        // half off-screen has a different clipped centre at every scroll step, and
        // keying on that records the same control several times.
        const key = el.pinned ? `pinned:${el.ref}` : `${el.ref}@${el.documentY}`;
        if (elements.has(key)) continue;
        if (elements.size >= maxElements) { truncated++; continue; }
        elements.set(key, el);
      }

      for (const h of await this.evaluate<Array<Record<string, unknown>>>(outlineProbe)) {
        const key = `${h.ref}:${h.text}`;
        if (outlineSeen.has(key)) continue;
        outlineSeen.add(key);
        outline.push(h);
      }

      const m = await this.evaluate<{ scrollY: number; viewportHeight: number; pageHeight: number; maxScrollY: number }>(scrollMetrics);
      pageHeight = m.pageHeight;

      if (m.scrollY >= m.maxScrollY) { reachedBottom = true; steps++; break; }
      // A page that refuses to move is done, however much height it claims.
      if (m.scrollY === lastScrollY) { steps++; break; }
      lastScrollY = m.scrollY;

      await this.view.scroll(0, Math.max(100, Math.round(m.viewportHeight * (1 - overlap))));
      await Bun.sleep(settleMs);
    }

    outline.sort((a, b) => (a.documentY as number) - (b.documentY as number));
    return {
      url: this.view.url,
      steps,
      reachedBottom,
      pageHeight,
      viewportHeight: first.viewportHeight,
      // Height growing mid-scroll is the signature of infinite scroll / lazy loading.
      lazyLoaded: pageHeight > first.pageHeight,
      initialPageHeight: first.pageHeight,
      sticky,
      scrollableContainers,
      outline,
      elementCount: elements.size,
      truncated,
      elements: [...elements.values()],
    };
  }

  /**
   * Walk the whole page and exercise everything on it.
   *
   * `crawl` tests one viewport; this scrolls and tests the lot, and it types into
   * fields instead of only clicking, so form controls are checked for actually
   * accepting input rather than merely taking focus.
   *
   * Controls whose label reads destructive are skipped by default and reported as
   * skipped — pointing this at a real admin panel should not delete anything.
   */
  async interact({
    maxSteps = 12,
    dwellMs = 400,
    maxControls = 60,
    fillFields = true,
    includeDestructive = false,
    settleMs = 120,
  }: {
    maxSteps?: number;
    dwellMs?: number;
    maxControls?: number;
    fillFields?: boolean;
    includeDestructive?: boolean;
    settleMs?: number;
  } = {}) {
    const startUrl = this.view.url;
    const consoleAtStart = this.consoleBuf.length;

    // Map the whole page first, then visit each control by its document position.
    // Sweeping viewport-by-viewport looks simpler but is not robust: a #hash link
    // scrolls the page itself, and the sweep then loses its place and skips
    // whole sections. Driving from a document-space list is deterministic.
    const map = await this.scrollScan({ maxSteps, settleMs, maxElements: maxControls * 4 });

    const seenRefs = new Set<string>();
    const queue = map.elements.filter((el) => {
      const key = el.pinned ? `pinned:${el.ref}` : `${el.ref}@${el.documentY}`;
      if (seenRefs.has(key)) return false;
      seenRefs.add(key);
      return true;
    });

    const results: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    let tested = 0;

    for (const target of queue) {
      if (tested >= maxControls) { skipped.push({ ref: target.ref, reason: "max-controls-reached" }); continue; }
      if (target.disabled) { skipped.push({ ref: target.ref, reason: "disabled" }); continue; }
      if (!includeDestructive && DESTRUCTIVE_LABEL.test(target.text ?? "")) {
        skipped.push({ ref: target.ref, text: target.text, reason: "destructive-label" });
        continue;
      }

      // Bring it into view, then find it again: the coordinates used to click are
      // always read after the scroll settles, never carried over from the map.
      this.onProgress("interact", target.ref);
      const live = await this.locate(target, map.viewportHeight);
      if (!live) { skipped.push({ ref: target.ref, reason: "not-reachable-after-scroll" }); continue; }
      if (!live.nativePicker && !(await this.stillThere(live.ref, live.center.x, live.center.y))) {
        skipped.push({ ref: live.ref, reason: "moving-target" });
        continue;
      }

      tested++;
      const isField = FIELD_TAGS.has(live.tag) || live.nativePicker || live.type === "text" || live.type === "email";
      results.push(
        fillFields && isField ? await this.exerciseField(live) : await this.exerciseControl(live, dwellMs),
      );

      if (this.view.url !== startUrl) await this.goto(startUrl);
    }

    return {
      url: startUrl,
      controlsFound: map.elementCount,
      controlsTested: tested,
      alive: results.filter((r) => r.status === "alive").length,
      dead: results.filter((r) => r.status === "dead"),
      rejectedInput: results.filter((r) => r.status === "rejected-input"),
      inspected: results.filter((r) => r.status === "inspected"),
      skipped,
      consoleErrorsTriggered: this.consoleBuf
        .slice(consoleAtStart)
        .filter((l) => l.type === "error")
        .map((l) => l.text)
        .slice(0, 20),
      results,
    };
  }

  /**
   * Bring a mapped element into view and find it again there.
   *
   * Coordinates are always re-read after the scroll settles; the ones in the map
   * are only ever used to decide where to scroll to.
   */
  private async locate(target: InteractiveElement, viewportHeight: number): Promise<InteractiveElement | null> {
    if (!target.pinned) {
      await this.scrollToY(Math.max(0, target.documentY - Math.round(viewportHeight / 2)));
      await Bun.sleep(80);
    }
    const tree = await this.getInteractiveTree({ max: 150 });
    const sameRef = tree.interactiveElements.filter((e) => e.ref === target.ref);
    if (!sameRef.length) return null;
    return sameRef.length === 1
      ? sameRef[0]!
      : sameRef.reduce((best, e) =>
          Math.abs(e.documentY - target.documentY) < Math.abs(best.documentY - target.documentY) ? e : best);
  }

  /**
   * Wait for layout to stop changing, up to `maxMs`.
   * Falls back to a plain sleep if the page cannot run the probe.
   */
  private async settle(maxMs: number): Promise<void> {
    try {
      await this.evaluate<{ settled: boolean; ms: number }>(settleProbe(maxMs));
    } catch {
      await Bun.sleep(maxMs);
    }
  }

  /** Scroll to an absolute document position. */
  private async scrollToY(y: number): Promise<void> {
    await this.evaluate(`(() => { scrollTo(0, ${Math.max(0, Math.round(y))}); return 1; })()`);
  }

  /** Type into a field and confirm the value actually landed. */
  private async exerciseField(el: InteractiveElement): Promise<Record<string, unknown>> {
    // Read a <select> without clicking it: the popup would block the renderer.
    if (el.nativePicker) {
      const info = await this.evaluate<{ value: string; optionCount: number; options: string[] } | null>(
        selectAt(el.center.x, el.center.y),
      );
      return { ref: el.ref, kind: "field", status: "inspected", reason: "native-picker", ...(info ?? {}) };
    }
    const sample = SAMPLE_INPUT[el.type ?? ""] ?? SAMPLE_INPUT.text!;
    await this.view.click(el.center.x, el.center.y);
    const focused = await this.evaluate<{ tag: string; value: string | null; editable: boolean } | null>(focusedFieldValue);
    if (!focused) {
      return { ref: el.ref, kind: "field", status: "dead", reason: "click did not focus anything" };
    }

    await this.view.type(sample);
    const after = await this.evaluate<{ value: string | null } | null>(focusedFieldValue);
    const got = after?.value ?? "";
    // A field that silently drops what it was given is worth knowing about;
    // a number input rejecting letters is correct, not broken, so compare loosely.
    const accepted = got.length > 0;
    return {
      ref: el.ref,
      kind: "field",
      status: accepted ? "alive" : "rejected-input",
      typed: sample,
      value: got,
      exact: got === sample,
    };
  }

  /** Click a control and classify what happened. */
  private async exerciseControl(el: InteractiveElement, dwellMs: number): Promise<Record<string, unknown>> {
    // A link to another document is alive by construction, and clicking it only
    // navigates away from the page being tested and forces a reload to come back.
    if (el.leavesPage) {
      return { ref: el.ref, text: el.text, kind: "link", status: "alive", reason: "leaves-page", href: el.href };
    }
    const r = await this.detectDeadClicks({ x: el.center.x, y: el.center.y, timeoutMs: dwellMs });
    if (!r.isDeadClick) {
      return { ref: el.ref, text: el.text, kind: "control", status: "alive", reason: r.reason, reactionMs: r.reactionMs };
    }
    const blocker = await this.detectPointerBlocker({ x: el.center.x, y: el.center.y });
    return {
      ref: el.ref,
      text: el.text,
      kind: "control",
      status: "dead",
      reason: blocker.isBlocked ? "blocked" : "no-handler",
      blockedBy: blocker.isBlocked ? blocker.blockingElement : null,
    };
  }

  /** Is the element named by `ref` still the thing at (x, y)? */
  private async stillThere(ref: string, x: number, y: number): Promise<boolean> {
    const hit = await this.detectPointerBlocker({ x, y });
    return hit.intendedElement === ref || hit.topElement === ref;
  }

  /**
   * Try to break the page on purpose.
   *
   * Ordinary testing exercises the happy path one step at a time. Real users
   * double-click, navigate away mid-request, refresh halfway through and scroll
   * while something is loading — which is where unhandled rejections and torn
   * state actually live. Each scenario is a fixed, repeatable hostile pattern;
   * nothing here is random, so a failure can be reproduced exactly.
   */
  async stressTest({
    maxTargets = 5,
    settleMs = 250,
  }: { maxTargets?: number; settleMs?: number } = {}) {
    const startUrl = this.view.url;

    // Stress whole-page, not just the first viewport, and only controls that
    // actually react: a button with no handler has nothing to break, so
    // hammering it proves nothing.
    const map = await this.scrollScan({ maxSteps: 8, settleMs: 100 });
    const candidates = map.elements.filter(
      (e) =>
        !e.disabled &&
        !e.nativePicker &&
        !DESTRUCTIVE_LABEL.test(e.text ?? "") &&
        (e.tag === "button" || e.tag === "a" || e.type === "submit"),
    );

    const targets: InteractiveElement[] = [];
    const rejected: Array<Record<string, unknown>> = [];
    for (const c of candidates) {
      if (targets.length >= maxTargets) break;
      this.onProgress("probe", c.ref);
      const live = await this.locate(c, map.viewportHeight);
      if (!live) continue;
      const probe = await this.detectDeadClicks({ x: live.center.x, y: live.center.y, timeoutMs: 250 });
      if (this.view.url !== startUrl) await this.goto(startUrl);
      if (probe.isDeadClick) { rejected.push({ ref: c.ref, reason: "no reaction to a plain click" }); continue; }
      targets.push(c);
    }

    if (!targets.length) {
      return {
        url: startUrl,
        targetsUsed: [],
        scenarios: [],
        totalErrors: 0,
        survived: true,
        note: "no live, non-destructive controls found to stress",
        rejected,
      };
    }

    const scenarios: Array<Record<string, unknown>> = [];
    // Errors the page emits on any clean load. A scenario that reloads would
    // otherwise "find" the page's own boot noise every single time.
    const baselineErrors = new Set(
      this.consoleBuf.filter((l) => l.type === "error").map((l) => l.text),
    );

    const reset = async () => {
      if (this.view.url !== startUrl) await this.goto(startUrl);
      await Bun.sleep(settleMs);
    };

    const run = async (name: string, target: InteractiveElement, body: (at: InteractiveElement) => Promise<void>) => {
      this.onProgress("scenario", `${name} → ${target.ref}`);
      const at = await this.locate(target, map.viewportHeight);
      if (!at) { scenarios.push({ name, target: target.ref, skipped: "could not relocate" }); return; }
      const before = this.consoleBuf.length;
      let threw: string | null = null;
      try {
        await body(at);
      } catch (e: any) {
        threw = String(e?.message ?? e).slice(0, 120);
      }
      await Bun.sleep(settleMs);
      const errors = this.consoleBuf
        .slice(before)
        .filter((l) => l.type === "error" && !baselineErrors.has(l.text));
      // "Responsive" means the page can still run script at all.
      let responsive = false;
      try {
        responsive = (await this.evaluate<number>("1")) === 1;
      } catch { /* context gone */ }
      scenarios.push({
        name,
        target: target.ref,
        // A scenario that threw never exercised the page; reporting it as a pass
        // would be worse than not running it at all.
        ran: threw === null,
        errorsTriggered: errors.length,
        errors: errors.map((l) => l.text).slice(0, 5),
        pageResponsive: responsive,
        threw,
      });
      await reset();
    };

    for (const target of targets) {
      // click() resolves when the event has been dispatched, not when an async
      // handler finishes — so the disruption below genuinely lands mid-flight.
      await run("rapid-click", target, async (at) => {
        for (let i = 0; i < 5; i++) await this.view.click(at.center.x, at.center.y);
      });
      await run("double-click", target, async (at) => {
        await this.view.click(at.center.x, at.center.y, { clickCount: 2 });
      });
      await run("reload-mid-action", target, async (at) => {
        await this.view.click(at.center.x, at.center.y);
        const r = await this.reload({ timeoutMs: 15_000 });
        if (r.timedOut) throw new Error("reload never completed");
      });
      await run("navigate-away-mid-action", target, async (at) => {
        await this.view.click(at.center.x, at.center.y);
        await this.goto("about:blank");
      });
      await run("scroll-away-mid-action", target, async (at) => {
        await this.view.click(at.center.x, at.center.y);
        await this.view.scroll(0, 2000);
      });
      await run("resize-mid-action", target, async (at) => {
        await this.view.click(at.center.x, at.center.y);
        await this.view.resize(480, 480);
        await this.view.resize(this.width, this.height);
      });
      await run("back-mid-action", target, async (at) => {
        await this.view.click(at.center.x, at.center.y);
        const r = await this.goBack({ timeoutMs: 5_000 });
        if (r.timedOut) throw new Error("browser back never completed; view rebuilt");
      });
    }

    if (targets.length > 1) {
      const [a, b] = targets;
      await run("interleaved-clicks", a!, async (at) => {
        const other = await this.locate(b!, map.viewportHeight);
        await this.view.click(at.center.x, at.center.y);
        if (other) await this.view.click(other.center.x, other.center.y);
      });
    }

    const totalErrors = scenarios.reduce((n, sc) => n + ((sc.errorsTriggered as number) ?? 0), 0);
    const notRun = scenarios.filter((sc) => sc.ran === false).length;
    return {
      url: startUrl,
      targetsUsed: targets.map((t) => t.ref),
      rejected,
      scenarios,
      scenariosRun: scenarios.length - notRun,
      scenariosFailedToRun: notRun,
      totalErrors,
      survived: scenarios.every((sc) => sc.pageResponsive !== false),
    };
  }

  // -------------------------------------------------------------- lifecycle

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this._view.close();
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
  /**
   * This tool changes the page, so its result carries a fresh observation.
   * An agent loop otherwise spends half its calls asking "what happened?".
   */
  acts?: true;
}

const TOOLS: Record<string, Tool> = {
  goto: {
    acts: true,
    description: "Navigate to a URL and wait for the main frame to finish loading.",
    inputSchema: { type: "object", properties: { observe: boolSchema, url: strSchema }, required: ["url"] },
    run: (e, a) => e.goto(a.url),
  },
  observe: {
    description:
      "One step of the agent loop: current url and title, the actionable elements with click-ready coordinates, what is covering anything unreachable, plus the console errors and failed requests SINCE THE LAST observe, and a `changed` flag that is false when nothing moved. Call this first, act, then read the observation returned by the action. `changed: false` after an action means the action achieved nothing — try something else rather than repeating it.",
    inputSchema: { type: "object", properties: { maxElements: numSchema } },
    run: (e, a) => e.observe(a),
  },
  getInteractiveTree: {
    description:
      "Compact list of every element that can actually be acted on, with click-ready CSS-space centre coordinates. Filtered to the viewport and to elements that are not occluded, so it stays small on large pages. Also reports blockedBy — what is covering the unreachable controls, which is how you spot a cookie wall or modal that must be dismissed first. Start here to decide what to click.",
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
    acts: true,
    description:
      "Click. Give x/y for a raw coordinate click, or selector to wait for the element to become actionable first.",
    inputSchema: {
      type: "object",
      properties: { observe: boolSchema, x: numSchema, y: numSchema, selector: strSchema, button: { enum: ["left", "right", "middle"] }, clickCount: numSchema },
    },
    run: (e, a) => e.clickCoordinate(a),
  },
  typeInput: {
    acts: true,
    description:
      "Type into the focused element. Default is a fast paste-style insert; set realKeys or typingDelayMs to send per-character key events for fields that validate on keydown.",
    inputSchema: { type: "object", properties: { observe: boolSchema, text: strSchema, typingDelayMs: numSchema, realKeys: boolSchema }, required: ["text"] },
    run: (e, a) => e.typeInput(a),
  },
  pressKey: {
    acts: true,
    description: 'Press a named key ("Enter", "Tab", "Escape", arrows) or a chord with modifiers.',
    inputSchema: {
      type: "object",
      properties: { observe: boolSchema, key: strSchema, modifiers: { type: "array", items: { enum: ["Shift", "Control", "Alt", "Meta"] } } },
      required: ["key"],
    },
    run: (e, a) => e.pressKey(a),
  },
  hoverCoordinate: {
    acts: true,
    description: "Hover to reveal popovers, dropdowns and hidden overlays." + CHROME_NOTE,
    inputSchema: { type: "object", properties: { observe: boolSchema, x: numSchema, y: numSchema }, required: ["x", "y"] },
    run: (e, a) => e.hoverCoordinate(a),
  },
  scroll: {
    acts: true,
    description: "Scroll by a pixel delta (dx/dy) or bring a selector into view.",
    inputSchema: {
      type: "object",
      properties: { observe: boolSchema, dx: numSchema, dy: numSchema, selector: strSchema, block: { enum: ["start", "center", "end", "nearest"] } },
    },
    run: (e, a) => e.scroll(a),
  },
  detectDeadClicks: {
    acts: true,
    description:
      "Click a coordinate and report whether anything happened: DOM mutations, console output, navigation, and network requests. Use to prove a control is wired up.",
    inputSchema: { type: "object", properties: { observe: boolSchema, x: numSchema, y: numSchema, timeoutMs: numSchema }, required: ["x", "y"] },
    run: (e, a) => e.detectDeadClicks(a),
  },
  crawl: {
    description:
      "Click every actionable control on the page and report which ones do nothing, and why — swallowed by an overlay, or no handler fired at all. The fastest way to find broken buttons across a page.",
    inputSchema: { type: "object", properties: { max: numSchema, dwellMs: numSchema } },
    run: (e, a) => e.crawl(a),
  },
  waitFor: {
    description:
      "Wait until an element appears and is visible, by CSS selector and/or the text it contains. Returns it with click-ready coordinates. Use after clicking something to wait for the result instead of guessing at a sleep.",
    inputSchema: {
      type: "object",
      properties: { selector: strSchema, textContains: strSchema, timeoutMs: numSchema },
    },
    run: (e, a) => e.waitFor(a),
  },
  waitForGone: {
    description:
      "Wait until an element matching a selector and/or text is gone — a loading spinner, a modal, a toast. Complements waitFor.",
    inputSchema: {
      type: "object",
      properties: { selector: strSchema, textContains: strSchema, timeoutMs: numSchema },
    },
    run: (e, a) => e.waitForGone(a),
  },
  goBack: {
    acts: true,
    description:
      "Go back in browser history. Runs under a deadline and reports timedOut rather than hanging, because back can fail to resolve when there is no history left.",
    inputSchema: { type: "object", properties: { observe: boolSchema, timeoutMs: numSchema } },
    run: (e, a) => e.goBack(a),
  },
  reload: {
    acts: true,
    description: "Reload the current page, under a deadline.",
    inputSchema: { type: "object", properties: { observe: boolSchema, timeoutMs: numSchema } },
    run: (e, a) => e.reload(a),
  },
  scrollScan: {
    description:
      "Scroll the entire page and return one merged map: every interactive element in document-space coordinates, the heading outline, what is pinned over the content, and whether the page lazy-loads. Use this first to understand a page that is taller than one viewport.",
    inputSchema: { type: "object", properties: { maxSteps: numSchema, settleMs: numSchema, maxElements: numSchema } },
    run: (e, a) => e.scrollScan(a),
  },
  interact: {
    description:
      "Scroll the whole page and exercise every control: click buttons and links, type sample data into fields and verify it was accepted. Controls with destructive-looking labels are skipped unless includeDestructive is set. Broader and slower than crawl.",
    inputSchema: {
      type: "object",
      properties: {
        maxControls: numSchema,
        dwellMs: numSchema,
        fillFields: boolSchema,
        includeDestructive: boolSchema,
      },
    },
    run: (e, a) => e.interact(a),
  },
  stressTest: {
    description:
      "Run a fixed sequence of hostile interaction patterns — rapid clicks, double clicks, reload mid-action, navigate away mid-action, resize and scroll mid-action, interleaved clicks — and report the console errors each triggers. Finds race conditions ordinary testing misses. Deterministic and reproducible.",
    inputSchema: { type: "object", properties: { maxTargets: numSchema, settleMs: numSchema } },
    run: (e, a) => e.stressTest(a),
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
          serverInfo: { name: "flamingo", version: VERSION },
          instructions: MCP_INSTRUCTIONS,
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
        const engine = await getEngine();
        const args = params.arguments ?? {};
        const result = await tool.run(engine, args);
        // An action's whole point is its effect, so hand back the resulting state
        // in the same round trip unless the caller explicitly opts out.
        const payload =
          tool.acts && args.observe !== false && result && typeof result === "object"
            ? { ...(result as object), observation: await engine.observe() }
            : result;
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
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

/**
 * The agent-facing skill, written by `flamingo init`.
 *
 * Kept here rather than as a separate file so the project stays one source file
 * and the skill can never drift from the tool surface it documents.
 */
const SKILL_MD = `---
name: flamingo
description: Drive and test a running web frontend through a real browser. Use when asked to test, QA, debug, explore or interact with a web app - to find dead buttons, broken assets, layout breaks, console errors, or to verify a UI flow actually works end to end.
---

# flamingo

A browser you can drive in a loop. Every action returns the resulting page state,
so you act, look at what changed, and act again until the goal is met.

## The loop

1. \\\`observe\\\` - where you are, what you can click, what changed since last time.
2. Act (\\\`clickCoordinate\\\`, \\\`typeInput\\\`, \\\`pressKey\\\`, \\\`scroll\\\`).
3. Read the \\\`observation\\\` that comes back with the action. Repeat.

Every acting tool returns a fresh observation automatically. You do not need to
call \\\`observe\\\` after acting - only to start, or to re-orient.

### Reading an observation

- \\\`elements\\\` - only what is genuinely clickable: on screen, visible, not covered.
  Each has a \\\`center\\\` you pass straight to \\\`clickCoordinate\\\`.
- \\\`changed: false\\\` - your last action did nothing. **Do not repeat it.** Try a
  different element, scroll, or check \\\`blockedBy\\\`.
- \\\`blockedBy\\\` - something is covering the page. A cookie wall or modal. Dismiss
  it first; the controls behind it are unreachable until you do.
- \\\`newErrors\\\` - console errors since your last look, including uncaught
  exceptions and unhandled rejections. This is your failure signal.
- \\\`scroll.atBottom\\\` - false means there is more page below.

## Coordinates

All coordinates are CSS pixels in the current viewport, taken from \\\`observe\\\`.
Screenshots are 2x on retina - never read coordinates off an image; use
\\\`observe\\\`. Coordinates go stale after anything changes the page, so use the ones
from the most recent observation.

## Waiting

After an action that starts async work, do not sleep:

- \\\`waitFor({ textContains: "Saved" })\\\` - wait for something to appear.
- \\\`waitForGone({ selector: ".spinner" })\\\` - wait for something to clear.

Both return on their deadline rather than hanging.

## Beyond one screen

\\\`observe\\\` reports the current viewport only. For the whole page:

- \\\`scrollScan\\\` - map the entire page: every control in document coordinates, the
  heading outline, pinned headers, whether it lazy-loads, and containers that
  scroll separately.
- \\\`scroll({ dy })\\\` to move, or \\\`scroll({ selector })\\\` to bring something into view.

## Checking a page rather than driving it

- \\\`compileHealthReport\\\` - console errors, broken assets, layout overflow, in one go.
- \\\`crawl\\\` - click every control in view, report which do nothing and why.
- \\\`interact\\\` - the whole page: clicks controls and types into fields to check
  they accept input.
- \\\`stressTest\\\` - rapid clicks, reload mid-action, navigate away mid-action. Finds
  race conditions and unhandled rejections a single click never will.
- \\\`auditResponsiveness\\\` - horizontal overflow across viewports.

## Things that will trip you up

- A \\\`<select>\\\` is marked \\\`nativePicker\\\` and must never be clicked - the native
  popup blocks the browser. Read its options from \\\`interact\\\` instead.
- Elements marked \\\`leavesPage\\\` navigate away. Clicking one abandons the page you
  were testing.
- Controls with destructive labels (delete, log out, revoke) are skipped by the
  sweep tools by default, and \\\`confirm()\\\` is always answered "no". If you need a
  destructive action, click it deliberately by coordinate.
- \\\`interceptTraffic\\\` and \\\`hoverCoordinate\\\` need the chrome backend. On the
  default webkit backend they return a clear error naming the fix.

## Worked example

Goal: confirm the signup form rejects a bad email.

1. \\\`goto\\\` the page. The observation shows \\\`blockedBy: [{ref: "div#cookiewall"}]\\\`.
2. Click the one reachable control (Accept). \\\`changed: true\\\`, more elements appear.
3. \\\`clickCoordinate\\\` the email field, \\\`typeInput\\\` "not-an-email".
4. Click Submit. Read \\\`newErrors\\\` and \\\`changed\\\`.
5. \\\`waitFor({ textContains: "valid email" })\\\` to confirm the validation message.

If step 4 returns \\\`changed: false\\\` and no error, the button is not wired -
confirm with \\\`detectDeadClicks\\\` at the same coordinates.
`;

const MCP_SERVER_KEY = "flamingo";

/**
 * Sent in the initialize response, so every MCP client gets the operating
 * instructions — not only the ones that also read a skill file.
 */
const MCP_INSTRUCTIONS = `flamingo drives a real browser in a loop: observe, act, observe.

Call \`observe\` to see where you are. Then act (clickCoordinate, typeInput, pressKey,
scroll) — every acting tool returns a fresh observation in its result, so you do not
need to call observe again after acting.

In an observation:
- \`elements\` are the only genuinely clickable things: on screen, visible, not covered.
  Use an element's \`center\` directly as click coordinates.
- \`changed: false\` means your last action did nothing. Do not repeat it — try a
  different element, scroll, or look at \`blockedBy\`.
- \`blockedBy\` names what is covering the page (a cookie wall, a modal). Dismiss it
  first; anything behind it is unreachable.
- \`newErrors\` are console errors and uncaught exceptions since your last look.

Coordinates are CSS pixels from the latest observation. Never read coordinates off a
screenshot — those are device pixels, 2x on retina.

After starting async work use \`waitFor\` / \`waitForGone\` rather than sleeping.
\`observe\` covers the current viewport only; \`scrollScan\` maps the whole page.

Never click an element marked \`nativePicker\` (a <select>) — the native popup blocks
the browser. Elements marked \`leavesPage\` navigate away from the page under test.
Destructive-looking controls are skipped by the sweep tools and confirm() is answered
"no"; click one deliberately by coordinate if you really mean to.

To check a page rather than drive it: compileHealthReport, crawl, interact,
stressTest, auditResponsiveness.`;

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
  ["--profile <dir>", "Persist cookies and storage here, to stay logged in between runs"],
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
  scroll: {
    args: "<url>",
    summary: "Scroll the whole page and map everything on it",
    detail:
      "One viewport is a keyhole — anything below the fold is invisible. This walks\n" +
      "the page in overlapping steps and merges what it finds into document-space\n" +
      "coordinates, so every control can be reached later with scrollTo. It also\n" +
      "reports the heading outline, what is pinned over the content, and whether the\n" +
      "page lazy-loads (its height grew while scrolling).",
    flags: ["--max-steps <n>", "--settle <ms>", "--json"],
    exits: "0 unless the page fails to load",
    examples: ["flamingo scroll http://localhost:3000", "flamingo scroll http://localhost:3000 --json | jq .outline"],
  },
  interact: {
    args: "<url>",
    summary: "Scroll the page and exercise every control on it",
    detail:
      "crawl tests one viewport; this tests the whole page. Buttons and links are\n" +
      "clicked, and fields are typed into with type-appropriate sample data and\n" +
      "checked for actually accepting it, rather than merely taking focus.\n" +
      "Controls whose label reads destructive (delete, log out, revoke...) are skipped\n" +
      "and reported as skipped; pass --include-destructive to test them anyway.",
    flags: ["--max-controls <n>", "--dwell <ms>", "--no-fill", "--include-destructive", "--json"],
    exits: "0 if everything responded, 1 if any control is dead or drops input",
    examples: [
      "flamingo interact http://localhost:3000",
      "flamingo interact http://localhost:3000 --max-controls 100 --json",
    ],
  },
  stress: {
    args: "<url>",
    summary: "Try to break the page with hostile interaction patterns",
    detail:
      "Real users double-click, refresh halfway through a request, navigate away\n" +
      "mid-action and scroll while something is loading — which is where unhandled\n" +
      "rejections and torn state actually live. Runs a fixed sequence of those\n" +
      "patterns and reports the console errors each one triggers. Nothing is random,\n" +
      "so any failure reproduces exactly.",
    flags: ["--targets <n>", "--json"],
    exits: "0 if nothing broke, 1 if any scenario triggered errors or left the page unresponsive",
    examples: ["flamingo stress http://localhost:3000", "flamingo stress http://localhost:3000 --targets 5 --json"],
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
  init: {
    args: "",
    summary: "Wire flamingo into this project for an AI agent",
    detail:
      "Writes an MCP server entry to .mcp.json so an agent can drive the browser, and\n" +
      "a skill to .claude/skills/flamingo/SKILL.md so it knows how to use it. Merges\n" +
      "into existing config rather than overwriting, and never replaces an existing\n" +
      "flamingo entry without --force.",
    flags: ["--dir <path>", "--backend <name>", "--skill-only", "--mcp-only", "--force", "--json"],
    exits: "0 on success",
    examples: ["flamingo init", "flamingo init --backend chrome", "flamingo init --dir ../my-app"],
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
  "--settle": "Wait after each resize or scroll step (default 250ms / 120ms)",
  "--max-steps": "Maximum scroll steps before stopping (default 20)",
  "--max-controls": "Maximum controls to exercise (default 60)",
  "--no-fill": "Click fields instead of typing into them",
  "--include-destructive": "Also test controls whose label reads destructive",
  "--targets": "How many live controls to run stress scenarios against (default 5)",
  "--dir": "Project directory to write into (default: here)",
  "--skill-only": "Write only the agent skill, not the MCP config",
  "--mcp-only": "Write only the MCP config, not the agent skill",
  "--force": "Overwrite existing flamingo entries",
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
  for (const b of r.blockedBy ?? []) {
    console.log(`  ${yellow("blocked")} ${b.count} control${b.count === 1 ? "" : "s"} behind ${bold(b.ref)} — untestable until it is dismissed`);
  }
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

function printScrollHuman(r: any) {
  console.log(`${bold(r.url)}\n`);
  const bottom = r.reachedBottom ? "reached bottom" : dim("stopped early");
  console.log(`  page ${bold(r.pageHeight + "px")} tall · viewport ${r.viewportHeight}px · ${r.steps} steps · ${bottom}`);
  if (r.lazyLoaded) {
    console.log(`  ${yellow("lazy-loaded")} — grew ${r.pageHeight - r.initialPageHeight}px while scrolling`);
  }
  if (r.sticky.length) {
    console.log(`  ${cyan("pinned")}: ${r.sticky.map((s: any) => `${s.ref} (${s.position}, ${s.height}px)`).join(", ")}`);
  }
  for (const c of r.scrollableContainers ?? []) {
    // Scrolling the page never reveals these; they need scrollTo(selector).
    console.log(`  ${yellow("scrolls separately")}: ${bold(c.ref)} hides ${c.hiddenPixelsY}px below its own fold`);
  }
  if (r.outline.length) {
    console.log(`\n  ${bold("outline")}`);
    for (const h of r.outline.slice(0, 25)) {
      const indent = "  ".repeat(Math.max(0, (h.level ?? 3) - 1));
      console.log(`    ${dim(String(h.documentY).padStart(6))}  ${indent}${h.text}`);
    }
    if (r.outline.length > 25) console.log(dim(`    … ${r.outline.length - 25} more`));
  }
  console.log(`\n  ${bold(r.elementCount)} interactive elements across the page${r.truncated ? dim(` (${r.truncated} beyond the cap)`) : ""}\n`);
}

function printInteractHuman(r: any) {
  console.log(`${bold(r.url)}\n`);
  console.log(`  ${r.controlsTested} of ${r.controlsFound} controls exercised`);
  console.log(`  ${green("✓")} ${r.alive} responded`);
  if (r.dead.length) console.log(`  ${red("✗")} ${r.dead.length} dead`);
  if (r.rejectedInput.length) console.log(`  ${yellow("!")} ${r.rejectedInput.length} dropped the input they were given`);
  if (r.skipped.length) {
    const by: Record<string, number> = {};
    for (const s of r.skipped) by[s.reason] = (by[s.reason] ?? 0) + 1;
    console.log(`  ${dim("⊘")} ${r.skipped.length} skipped ${dim(`(${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ")})`)}`);
  }
  if (r.dead.length || r.rejectedInput.length) console.log();
  for (const d of r.dead) {
    const why = d.blockedBy ? `blocked by ${d.blockedBy}` : "no handler fired";
    console.log(`    ${red("✗")} ${String(d.ref).padEnd(22)} ${yellow(why)}`);
  }
  for (const f of r.rejectedInput) {
    console.log(`    ${yellow("!")} ${String(f.ref).padEnd(22)} typed ${JSON.stringify(f.typed)} → ${JSON.stringify(f.value)}`);
  }
  if (r.consoleErrorsTriggered.length) {
    console.log(`\n  ${bold("console errors triggered")}`);
    for (const e of r.consoleErrorsTriggered.slice(0, 5)) console.log(`    ${red("✗")} ${e}`);
  }
  console.log();
}

function printStressHuman(r: any) {
  console.log(`${bold(r.url)}\n`);
  if (!r.scenarios.length) {
    console.log(dim(`  ${r.note ?? "nothing to stress"}\n`));
    return;
  }
  const verdict = r.totalErrors === 0 && r.survived ? green("held up") : red("broke");
  console.log(`  ${r.scenariosRun}/${r.scenarios.length} scenarios ran · ${r.totalErrors} errors triggered · page ${verdict}`);
  if (r.scenariosFailedToRun) console.log(`  ${yellow(`${r.scenariosFailedToRun} scenario(s) could not run`)}`);
  console.log(dim(`  targets: ${r.targetsUsed.join(", ")}\n`));
  for (const s of r.scenarios) {
    const bad = s.errorsTriggered > 0 || !s.pageResponsive;
    const mark = s.ran === false ? yellow("–") : bad ? red("✗") : green("✓");
    console.log(`    ${mark} ${String(s.name).padEnd(24)} ${dim(String(s.target ?? ""))}${
      s.ran === false ? "  " + yellow("did not run: " + String(s.threw).slice(0, 60)) : ""
    }${
      s.errorsTriggered ? "  " + yellow(`${s.errorsTriggered} error${s.errorsTriggered === 1 ? "" : "s"}`) : ""
    }${s.pageResponsive ? "" : "  " + red("page stopped responding")}`);
    for (const e of (s.errors ?? []).slice(0, 3)) console.log(`        ${dim(e.slice(0, 100))}`);
  }
  console.log();
}

function printTreeHuman(r: any) {
  console.log(`${bold(`${r.interactiveElements.length} actionable element${r.interactiveElements.length === 1 ? "" : "s"}`)} ${dim(`${r.viewport.width}x${r.viewport.height}`)}`);
  console.log(dim(`  ${r.occluded} occluded, ${r.offscreen} off-viewport${r.truncated ? `, ${r.truncated} truncated` : ""}`));
  if (r.blockedBy?.length) {
    for (const b of r.blockedBy) {
      console.log(`  ${yellow("blocked")} ${b.count} control${b.count === 1 ? "" : "s"} behind ${bold(b.ref)}`);
    }
  }
  if (r.frames?.length) console.log(dim(`  ${r.frames.length} iframe(s) present — their contents are not reachable`));
  console.log();
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

/**
 * Wire flamingo into a project: an MCP server entry so an agent can drive the
 * browser, and a skill so it knows how.
 *
 * Merges rather than overwrites, and never touches an existing flamingo entry
 * without `--force`, because clobbering someone's `.mcp.json` is exactly the
 * kind of thing a setup command must not do.
 */
async function runInit(p: Parsed, json: boolean): Promise<number> {
  const root = resolve(str(p.flags, "dir") ?? ".");
  const force = p.flags.has("force");
  const wantSkill = !p.flags.has("mcp-only");
  const wantMcp = !p.flags.has("skill-only");
  const actions: Array<{ path: string; action: string; detail?: string }> = [];

  // Prefer the installed binary; fall back to this file's absolute path when
  // running from a clone, so the generated config actually works either way.
  const selfPath = Bun.main;
  const installed = selfPath.includes("node_modules");
  const command = installed ? "bunx" : "bun";
  const args = installed ? ["flamingo", "serve"] : ["run", selfPath, "serve"];
  const backend = str(p.flags, "backend");
  if (backend) args.push("--backend", backend);

  if (wantMcp) {
    const mcpPath = join(root, ".mcp.json");
    let config: Record<string, any> = {};
    let existed = false;
    if (existsSync(mcpPath)) {
      existed = true;
      try {
        config = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        throw new UsageError(`${mcpPath} exists but is not valid JSON. Fix or move it, then re-run.`);
      }
    }
    config.mcpServers ??= {};
    if (config.mcpServers[MCP_SERVER_KEY] && !force) {
      actions.push({ path: mcpPath, action: "kept", detail: "already configured — pass --force to overwrite" });
    } else {
      config.mcpServers[MCP_SERVER_KEY] = { command, args };
      writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
      actions.push({ path: mcpPath, action: existed ? "updated" : "created", detail: `${command} ${args.join(" ")}` });
    }
  }

  if (wantSkill) {
    const skillDir = join(root, ".claude", "skills", "flamingo");
    const skillPath = join(skillDir, "SKILL.md");
    const skillExisted = existsSync(skillPath);
    if (skillExisted && !force) {
      actions.push({ path: skillPath, action: "kept", detail: "already present — pass --force to overwrite" });
    } else {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillPath, SKILL_MD);
      actions.push({ path: skillPath, action: skillExisted ? "updated" : "created" });
    }
  }

  if (json) {
    console.log(JSON.stringify({ root, actions }));
    return EXIT.ok;
  }

  console.log(`${bold("flamingo")} ${dim(VERSION)} — wired into ${bold(root)}\n`);
  for (const a of actions) {
    const mark = a.action === "kept" ? dim("·") : green("✓");
    console.log(`  ${mark} ${a.action.padEnd(8)} ${a.path.replace(root + "/", "")}${a.detail ? dim(`  ${a.detail}`) : ""}`);
  }
  console.log(`\n  ${bold("next")}`);
  console.log(`    ${dim("1.")} flamingo doctor            ${dim("check this machine can run it")}`);
  console.log(`    ${dim("2.")} restart your agent          ${dim("so it picks up .mcp.json")}`);
  console.log(`    ${dim("3.")} ask it to test your app     ${dim('e.g. "check localhost:3000 for dead buttons"')}\n`);
  return EXIT.ok;
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
    onProgress: json ? undefined : (stage, detail) => process.stderr.write(dim(`  ${stage}: ${detail}\n`)),
    chromePath: str(p.flags, "chrome-path"),
    width: num(p.flags, "width", 1280),
    height: num(p.flags, "height", 800),
    profileDirectory: str(p.flags, "profile"),
  };

  if (p.command === "init") return runInit(p, json);
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
      case "scroll": {
        const r = await engine.scrollScan({
          maxSteps: num(p.flags, "max-steps", 20),
          settleMs: num(p.flags, "settle", 120),
        });
        if (json) console.log(JSON.stringify(r));
        else printScrollHuman(r);
        return EXIT.ok;
      }
      case "interact": {
        const r = await engine.interact({
          maxControls: num(p.flags, "max-controls", 60),
          dwellMs: num(p.flags, "dwell", 400),
          fillFields: !p.flags.has("no-fill"),
          includeDestructive: p.flags.has("include-destructive"),
        });
        if (json) console.log(JSON.stringify(r));
        else printInteractHuman(r);
        return r.dead.length || r.rejectedInput.length ? EXIT.problems : EXIT.ok;
      }
      case "stress": {
        const r = await engine.stressTest({ maxTargets: num(p.flags, "targets", 5) });
        if (json) console.log(JSON.stringify(r));
        else printStressHuman(r);
        return r.totalErrors > 0 || !r.survived ? EXIT.problems : EXIT.ok;
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
