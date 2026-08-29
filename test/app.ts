// A deliberately flawed multi-section app, tall enough to need scrolling.
// Each flaw exists to be found by a specific command, so the tests assert
// discovery rather than absence.
export const APP_HTML = `<!doctype html>
<html><head><title>flamingo demo app</title></head>
<body style="margin:0;font:14px system-ui">
<header id="topnav" style="position:fixed;top:0;left:0;right:0;height:56px;background:#222;color:#fff;z-index:10">
  <nav style="padding:16px"><a href="#features" id="navfeat">Features</a> · <a href="#pricing" id="navprice">Pricing</a></nav>
</header>
<main style="padding-top:56px">
  <section id="hero" style="height:600px;padding:24px"><h1>Welcome</h1>
    <button id="cta" style="width:140px;height:40px">Get Started</button>
    <button id="deadcta" style="width:140px;height:40px">Learn More</button>
  </section>
  <section id="features" style="height:700px;padding:24px"><h2>Features</h2>
    <button id="feat1" style="width:120px;height:36px">Expand</button>
    <button id="busy" style="width:120px;height:36px">Submit</button>
  </section>
  <section id="pricing" style="height:700px;padding:24px"><h2>Pricing</h2>
    <button id="buy" style="width:120px;height:36px">Buy</button>
    <button id="hidden" style="width:120px;height:36px">Blocked</button>
    <div id="veil" style="position:absolute;margin-top:-36px;width:130px;height:40px;background:rgba(0,0,0,.15)"></div>
  </section>
  <section id="contact" style="height:700px;padding:24px"><h2>Contact</h2>
    <form id="f" onsubmit="return false">
      <input id="email" type="email" placeholder="email" style="width:220px;height:30px"><br><br>
      <input id="zip" type="text" placeholder="zip" style="width:220px;height:30px"><br><br>
      <select id="plan"><option>basic</option><option>pro</option></select>
    </form>
    <button id="danger" style="width:160px;height:36px">Delete account</button>
  </section>
</main>
<script>
  console.error("app boot: metrics endpoint unreachable");
  const wire = (id, fn) => document.getElementById(id).addEventListener("click", fn);
  wire("cta", () => document.body.appendChild(document.createElement("span")));
  wire("feat1", () => document.body.appendChild(document.createElement("span")));
  wire("buy", () => document.body.appendChild(document.createElement("span")));
  // #deadcta and #hidden are deliberately unwired.

  // #zip silently discards everything typed into it — a bug only found by typing.
  document.getElementById("zip").addEventListener("input", (e) => { e.target.value = ""; });

  // Re-entrancy bug: a second click while busy throws. Only rapid clicking finds it.
  let busy = false;
  wire("busy", async () => {
    if (busy) throw new Error("re-entrant submit while a request is in flight");
    busy = true;
    document.body.appendChild(document.createElement("i"));
    await new Promise((r) => setTimeout(r, 400));
    busy = false;
  });

  // Lazy loading: the page grows the first time you scroll near the bottom.
  let grown = false;
  addEventListener("scroll", () => {
    if (grown || scrollY < 1200) return;
    grown = true;
    const s = document.createElement("section");
    s.style.cssText = "height:600px;padding:24px";
    s.innerHTML = "<h2>Testimonials</h2><button id='lazybtn' style='width:120px;height:36px'>Lazy</button>";
    document.querySelector("main").appendChild(s);
  });
</script>
</body></html>`;

export function serveApp() {
  return Bun.serve({
    port: 0,
    fetch: () => new Response(APP_HTML, { headers: { "content-type": "text/html" } }),
  });
}
