---
name: flamingo
description: Drive and test a running web frontend through a real browser. Use when asked to test, QA, debug, explore or interact with a web app - to find dead buttons, broken assets, layout breaks, console errors, or to verify a UI flow actually works end to end.
---

# flamingo

A browser you can drive in a loop. Every action returns the resulting page state,
so you act, look at what changed, and act again until the goal is met.

## The loop

1. \`observe\` - where you are, what you can click, what changed since last time.
2. Act (\`clickCoordinate\`, \`typeInput\`, \`pressKey\`, \`scroll\`).
3. Read the \`observation\` that comes back with the action. Repeat.

Every acting tool returns a fresh observation automatically. You do not need to
call \`observe\` after acting - only to start, or to re-orient.

### Reading an observation

Observations are compact text, one element per line:

    (94,171) button#cta "Get Started"

Leading \`(x,y)\` are the click coordinates, then a reference, its label, then
flags. Pass \`format: "json"\` if you want the structured object instead.

- element lines - only what is genuinely clickable: on screen, visible, not covered.
  Use the leading coordinates straight with \`clickCoordinate\`.
- \`changed: false\` - your last action did nothing. **Do not repeat it.** Try a
  different element, scroll, or check \`blockedBy\`.
- \`blockedBy\` - something is covering the page. A cookie wall or modal. Dismiss
  it first; the controls behind it are unreachable until you do.
- \`newErrors\` - console errors since your last look, including uncaught
  exceptions and unhandled rejections. This is your failure signal.
- \`scroll.atBottom\` - false means there is more page below.

## Coordinates

All coordinates are CSS pixels in the current viewport, taken from \`observe\`.
Screenshots are 2x on retina - never read coordinates off an image; use
\`observe\`. Coordinates go stale after anything changes the page, so use the ones
from the most recent observation.

## Waiting

After an action that starts async work, do not sleep:

- \`waitFor({ textContains: "Saved" })\` - wait for something to appear.
- \`waitForGone({ selector: ".spinner" })\` - wait for something to clear.

Both return on their deadline rather than hanging.

## Beyond one screen

\`observe\` reports the current viewport only. For the whole page:

- \`scrollScan\` - map the entire page: every control in document coordinates, the
  heading outline, pinned headers, whether it lazy-loads, and containers that
  scroll separately.
- \`scroll({ dy })\` to move, or \`scroll({ selector })\` to bring something into view.

## Checking a page rather than driving it

- \`compileHealthReport\` - console errors, broken assets, layout overflow, in one go.
- \`crawl\` - click every control in view, report which do nothing and why.
- \`interact\` - the whole page: clicks controls and types into fields to check
  they accept input.
- \`stressTest\` - rapid clicks, reload mid-action, navigate away mid-action. Finds
  race conditions and unhandled rejections a single click never will.
- \`auditResponsiveness\` - horizontal overflow across viewports.

## Things that will trip you up

- A \`<select>\` is marked \`nativePicker\` and must never be clicked - the native
  popup blocks the browser. Read its options from \`interact\` instead.
- Elements marked \`leavesPage\` navigate away. Clicking one abandons the page you
  were testing.
- Controls with destructive labels (delete, log out, revoke) are skipped by the
  sweep tools by default, and \`confirm()\` is always answered "no". If you need a
  destructive action, click it deliberately by coordinate.
- \`interceptTraffic\` and \`hoverCoordinate\` need the chrome backend. On the
  default webkit backend they return a clear error naming the fix.

## Worked example

Goal: confirm the signup form rejects a bad email.

1. \`goto\` the page. The observation shows \`blockedBy: [{ref: "div#cookiewall"}]\`.
2. Click the one reachable control (Accept). \`changed: true\`, more elements appear.
3. \`clickCoordinate\` the email field, \`typeInput\` "not-an-email".
4. Click Submit. Read \`newErrors\` and \`changed\`.
5. \`waitFor({ textContains: "valid email" })\` to confirm the validation message.

If step 4 returns \`changed: false\` and no error, the button is not wired -
confirm with \`detectDeadClicks\` at the same coordinates.
