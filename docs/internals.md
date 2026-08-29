# Internals

Why the implementation is shaped the way it is. Everything here was found by
driving a real browser until it broke, not by reading documentation.

## Bun 1.4 defects worked around

| Defect | Consequence | Handling |
| :-- | :-- | :-- |
| `WebView.title` is populated asynchronously by the host | Empty on any page that takes a moment, correct on fast ones — so it looks like it works | `observe`, `goto` and `reload` read `document.title`, which costs nothing when an evaluate is already being made |
| `bun.d.ts` declares `back()`/`forward()`; the runtime implements `goBack()`/`goForward()` | Calling the documented name throws | Call the runtime name through a cast |
| `goBack()` on the chrome backend never resolves once history runs out | Hangs forever, and the pending navigation poisons the view | Every navigation runs under a deadline |
| The `console` constructor option only sees explicit `console.*` calls | A real `throw` or unhandled rejection is invisible | `error` and `unhandledrejection` listeners are injected and forward to `console.error` |
| `evaluate()` allows one call in flight per view | A second concurrent call throws `ERR_INVALID_STATE` | All page calls funnel through one promise chain |
| `Bun.Image`'s `.width`/`.height` getters return `-1` | Silent wrong dimensions | `await .metadata()` is the real source |

## Browser behaviour that breaks automation

**Clicking a `<select>` blocks the renderer.** The native popup waits for a human
and nothing automated can dismiss it, so `evaluate` never returns again. Selects
are flagged `nativePicker` and read without clicking. Because that cannot be the
only such element, any evaluate that stalls past a deadline rebuilds the view.

**A navigation that never completes poisons the view permanently.** Every later
`navigate` throws `ERR_INVALID_STATE`, and neither `reload()` nor closing helps.
Only rebuilding does — so a timeout marks the view and the next navigation
rebuilds it, keeping one hung link from killing a whole crawl.

**A page can cancel your navigation.** A meta refresh or script redirect firing
as you leave produces `NSURLErrorDomain -999` / `ERR_ABORTED`. That is a race
lost, not a failure: retry once.

**`DOM.documentUpdated` cannot detect click effects.** It fires only when the
whole document is replaced, missing nearly every real click. A `MutationObserver`
installed before the click is the only thing that sees them.

**`history.pushState` fires no load event**, so SPA route changes are invisible
to navigation tracking. The URL is compared instead.

**Shadow DOM is not optional.** Every built-in form control and most component
libraries hide their real controls behind a shadow root that `querySelectorAll`
cannot see. The element walk and hit test both pierce it; closed roots correctly
stay invisible.

## Decisions that are not obvious

**Capture cannot be lazy.** Console and network are enabled before the first
navigation. Enabling them on demand misses load-time failures, which are the ones
that matter most. `about:blank` is navigated first purely to establish the CDP
session so `Network.enable` can be wired ahead of the real page.

**Identity comes from the unclipped document position.** An element's reported
centre is clipped to the viewport so it is always a valid click target, but a
half-scrolled element then has a different centre at every scroll offset. Keying
on that records — and tests — the same control several times.

**Focus counts as a reaction, but only for fields.** Clicking a text input
focuses it and changes nothing else, so without this every input reads as dead.
Buttons take focus on any click, so counting that would mark every unwired button
alive.

**`body` and `html` are never named as blockers.** Landing on them means nothing
is on top — the absence of a blocker, not the presence of one.

**`mailto:`, `tel:`, `sms:` and `download` links do not leave the page.** Treating
them as navigation would let a crawl mark them alive without ever testing them.

**Detection is signal-driven, not timed.** A click is watched for DOM mutations,
focus, dialogs, navigation, SPA routing and network, and resolves the moment any
fires — 4ms for a live control instead of a fixed 600ms window. Proving a control
is *dead* still costs the full window, because absence cannot be observed early.

**Dialogs are answered negatively.** `confirm()` returns `false` and `prompt()`
returns `null`. Auto-confirming while crawling an admin panel would delete things.

**A regex written `/\s+/` inside a template literal degrades to `/s+/`.** The
in-page programs are template literals, so `\s` must be written `\\s`. The
unescaped version silently replaced every `s` in the page with a space.

## Coordinates

Everything reported and accepted is CSS pixels in the current viewport.
Screenshots are device pixels — 2× on retina — so `captureViewport` returns
`deviceScaleFactor` alongside `cssSize` and `pixelSize`. Reading coordinates off
an image without dividing by it mis-clicks by half the page.

The two backends also disagree on what the constructor's `width`/`height` mean:
webkit sizes the CSS viewport, chrome sizes the outer window and loses ~81px to
browser chrome even headless. `Engine.open()` calls `resize()` to normalise both.
