# Product Requirement Document (PRD)
## Zero-Dependency, AI-Native Frontend Testing & Browser Automation Engine

This document defines the core product specification, system architecture, and API surface for a lightweight, zero-dependency browser automation framework built natively on the **Bun** runtime. 

The framework requires **zero third-party dependencies**, has **no `package.json` file**, and compiles into a **single standalone binary**. It operates by communicating directly with Chrome/Chromium over the **Chrome DevTools Protocol (CDP)** using Bun's standard library.

---

## 1. Core Purpose

Modern end-to-end (E2E) testing tools (like Playwright and Puppeteer) are built for human developers writing local scripts. They suffer from three critical flaws when integrated into AI-agent workflows:
1. **Bloat and Footprint:** They require gigabytes of node module dependencies, complex configuration files, and heavy external runner packages.
2. **Context Window Exhaustion:** They require parsing massive, nested HTML DOM trees. When an AI agent needs to locate an element, sending the entire raw HTML of a modern web page wastes thousands of LLM tokens.
3. **Selector Fragility:** They rely on brittle CSS selectors (`div > span.submit-btn`). If an agent shifts the layout slightly, the selector breaks.

This engine is designed from the ground up to be **AI-Native**:
* **Deterministic and Raw:** It translates the web into compact, structured JSON payloads that LLMs can parse natively.
* **Coordinate-Based Driving:** Instead of fragile DOM selectors, it interacts with the screen using raw pixel coordinates (`x, y`) and bounding boxes, simulating real hardware events.
* **Verification of System Sync:** It intercepts network traffic and console errors to prove that the frontend interface is successfully synced with the backend API under the hood.

---

## 2. System Architecture

The engine runs entirely within the **Bun** standard library. It does not import any external dependencies from npm.

```
+-------------------------------------------------------------+
|                        Bun Runtime                          |
|                                                             |
|  +------------------+   Bun.spawn()   +------------------+  |
|  |                  | --------------> |                  |  |
|  |   CLI / Script   |                 |  Headless Chrome |  |
|  |                  | <-------------- |                  |  |
|  +------------------+  /json/list (HTTP)+----------------+  |
|           |                                                 |
|           | ws.send(CDP JSON Frame)                         |
|           v                                                 |
|  +------------------+                                       |
|  |  Native WebSocket|                                       |
|  +------------------+                                       |
+-------------------------------------------------------------+
```

### 2.1 Browser Lifecycle Management
1. **Process Spawning:** The engine uses `Bun.spawn` to launch the host system's native Google Chrome, Chromium, or Microsoft Edge executable in headless debugging mode.
2. **Port Allocation:** It allocates a dedicated debugging port (default: `9222`) and exposes remote debugging permissions.
3. **WebSocket Handshake:** The engine hits the local HTTP endpoint `http://localhost:9222/json/list` using Bun's native `fetch` API to retrieve the current browser targets and their unique `webSocketDebuggerUrl`.
4. **Active Connection:** It establishes an active, persistent connection using Bun's global `WebSocket` client to transmit and receive raw JSON-RPC 2.0 frames directly over the Chrome DevTools Protocol.

---

## 3. Standard Library Substitutions (Zero-Dependency Mapping)

To guarantee absolute compliance with the zero-dependency challenge, the engine maps legacy NPM packages to native Bun and Web APIs:

| Legacy NPM Package | Native Substitution | Implementation Strategy |
| :--- | :--- | :--- |
| `puppeteer` / `playwright` | `Bun.spawn` + `WebSocket` | Spawn local Chrome binary; communicate via raw WebSocket JSON-RPC over CDP. |
| `globby` / `fast-glob` | `import { glob } from "bun"` | Leverage Bun's native fast-glob engine for scanning directories. |
| `chalk` / `picocolors` | ANSI Escape Sequences | Use direct string formatting (e.g., `\x1b[31m` for red text). |
| `yargs` / `commander` | Manual Argument Parser | Loop through `Bun.argv` using a custom, lightweight state machine. |
| `dotenv` | `Bun.env` | Use Bun's native parsing of local `.env` files. |
| `cli-progress` | Terminal Cursor Controls | Stream progress percentages directly using raw carriage returns `\r`. |

---

## 4. The 12 AI-Native APIs

These APIs are structured to receive deterministic JSON parameters and return ultra-compact, high-utility JSON responses designed for LLM consumption.

### 4.1 Visual & Layout APIs

#### 1. `captureViewport`
Captures a visual snapshot of the current browser viewport.
* **CDP Method:** `Page.captureScreenshot`
* **Input JSON:** `{ format: "png", quality?: number }`
* **Output JSON:** `{ base64: "iVBORw0KGgo...", sizeInBytes: 124050 }`

#### 2. `auditResponsiveness`
Sequentially shifts the browser through multiple viewports to identify layout breaks, overflow horizontal scrolling, or hidden elements.
* **CDP Method:** `Emulation.setDeviceMetricsOverride`
* **Input JSON:** `{ viewports: [{ width: 1920, height: 1080 }, { width: 375, height: 812 }] }`
* **Output JSON:** `{ violations: [{ viewport: "375x812", type: "horizontal-overflow", elementSelector: "nav.menu", overflowWidth: 42 }] }`

#### 3. `detectPointerBlocker`
Asserts whether clicking an element at `(x, y)` will actually hit the intended DOM target, or if it is being blocked by a modal backdrop, sticky overlay, or negative-index container.
* **CDP Method:** `DOM.getNodeForLocation` -> evaluates hit target
* **Input JSON:** `{ x: 250, y: 400 }`
* **Output JSON:** `{ isBlocked: true, intendedElement: "button#submit", blockingElement: "div.modal-backdrop", pointerEventsStyle: "auto" }`

---

### 4.2 Hardware-Level Interaction APIs

#### 4. `clickCoordinate`
Dispatches precise OS/hardware-level mouse events to target coordinates, bypassing the fragility of CSS queries.
* **CDP Method:** `Input.dispatchMouseEvent` (cycles: `mousePressed` -> `mouseReleased`)
* **Input JSON:** `{ x: number, y: number, button?: "left" | "right" | "middle" }`
* **Output JSON:** `{ success: true, targetCoordinates: { x: 120, y: 350 } }`

#### 5. `typeInput`
Simulates realistic, human-paced keystrokes into active fields with variable delay to pass input validations.
* **CDP Method:** `Input.dispatchKeyEvent` (cycles: `keyDown` -> `keyUp` per char)
* **Input JSON:** `{ text: "example@domain.com", typingDelayMs: 50 }`
* **Output JSON:** `{ success: true, charactersTyped: 18 }`

#### 6. `hoverCoordinate`
Triggers real hover states to reveal hidden overlays, popovers, and CSS dropdown layouts.
* **CDP Method:** `Input.dispatchMouseEvent` (type: `mouseMoved`)
* **Input JSON:** `{ x: number, y: number }`
* **Output JSON:** `{ success: true }`

---

### 4.3 Integration & System Sync APIs

#### 7. `interceptTraffic`
Enables a high-fidelity hook that logs all outbound API requests, headers, and response statuses initiated by user interactions.
* **CDP Method:** `Network.enable` + listeners for `Network.requestWillBeSent` and `Network.responseReceived`
* **Input JSON:** `{ filterUrlPattern?: string }`
* **Output JSON:** `{ traffic: [{ url: "https://api.app/v1/auth", method: "POST", requestHeaders: {...}, responseStatus: 401, errorReason: "Unauthorized" }] }`

#### 8. `captureRuntimeLogs`
Aggregates active stdout, warnings, and unhandled fatal JS exceptions that bubble up on the page.
* **CDP Method:** `Runtime.enable` + listeners for `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`
* **Input JSON:** `{}`
* **Output JSON:** `{ consoleLogs: [{ type: "error", text: "Uncaught TypeError: Cannot read properties of undefined", timestamp: 1718042940213 }] }`

#### 9. `detectDeadClicks`
Monitors coordinates that are clicked but fail to trigger any state change, network request, DOM alteration, or console output within a specific window.
* **CDP Method:** Listeners for `DOM.documentUpdated` and `Network.requestWillBeSent` evaluated post-click.
* **Input JSON:** `{ x: 500, y: 120, timeoutMs: 300 }`
* **Output JSON:** `{ isDeadClick: true, registeredDOMChanges: 0, registeredNetworkRequests: 0, registeredConsoleLogs: 0 }`

---

### 4.4 Agentic Context & Health APIs

#### 10. `getInteractiveTree`
Parses the current viewport and returns a compact, flat list containing *only* actionable elements (inputs, buttons, links) along with their text content and screen coordinates. This reduces context payloads from thousands of lines of HTML to less than a single page of clean JSON.
* **CDP Method:** `DOM.getDocument` -> traverses accessibility/interactivity attributes
* **Input JSON:** `{}`
* **Output JSON:** `{ interactiveElements: [{ tag: "button", text: "Sign Up", boundingBox: { x: 100, y: 200, width: 80, height: 40 }, center: { x: 140, y: 220 } }] }`

#### 11. `scanBrokenAssets`
Scans the active layout to isolate stylesheet loading errors, missing assets, or broken image tags.
* **CDP Method:** Evaluates loaded image metrics and response states of resource files.
* **Input JSON:** `{}`
* **Output JSON:** `{ brokenAssets: [{ type: "image", source: "/assets/missing_avatar.png", status: 404 }] }`

#### 12. `compileHealthReport`
Consolidates visual, console, and network logs into a single, comprehensive scorecard.
* **Input JSON:** `{}`
* **Output JSON:** `{ success: false, totalErrors: 3, details: { consoleErrors: 1, brokenAssets: 1, deadClicks: 1, overflowLayouts: 0 } }`

---

## 5. Execution & CLI Surface

The engine executes from a single standalone binary. It parses input flags manually:

### 5.1 CLI API
```bash
# Run a live test session on a target URL
./engine run http://localhost:3000

# Perform a quick responsive audit across desktop and mobile
./engine responsive http://localhost:3000

# Execute a health report audit and output structured JSON to stdout
./engine audit http://localhost:3000 --json
```

### 5.2 Deterministic Output Model
When executed with the `--json` flag, the engine suppresses all default terminal logging and writes a raw, stringified JSON payload to standard output. This allows AI agents to pipe results directly into subsequent analysis tools:

```json
{
  "targetUrl": "http://localhost:3000",
  "status": "fail",
  "timestamp": "2026-08-27T14:39:52-07:00",
  "errors": {
    "console": [
      {
        "type": "error",
        "message": "Failed to load resource: the server responded with a status of 500 (Internal Server Error)"
      }
    ],
    "deadClicks": [
      {
        "coordinates": { "x": 120, "y": 450 },
        "element": "button#checkout"
      }
    ],
    "brokenAssets": [
      {
        "url": "http://localhost:3000/images/logo.png",
        "statusCode": 404
      }
    ]
  }
}
```
