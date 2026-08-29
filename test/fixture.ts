// A deliberately broken page: 404 image, load-time console error, a button
// hidden under a backdrop, a dead div, and content that overflows narrow viewports.
export const HTML = `<!doctype html>
<html><head><title>nodep fixture</title></head>
<body style="margin:0;font:14px sans-serif">
<script>console.error("boom: load-time failure");</script>
<img src="/missing.png" width="20" height="20" style="position:absolute;left:250px;top:10px">
<button id="live" style="position:absolute;left:10px;top:10px;width:100px;height:40px">Live</button>
<button id="under" style="position:absolute;left:10px;top:100px;width:100px;height:40px">Under</button>
<div id="backdrop" style="position:absolute;left:0;top:90px;width:300px;height:60px;background:rgba(0,0,0,.3)"></div>
<div id="inert" style="position:absolute;left:10px;top:200px;width:100px;height:40px;background:#eee">Inert</div>
<input id="field" placeholder="email" style="position:absolute;left:10px;top:280px;width:200px;height:30px">
<div id="wide" style="position:absolute;left:0;top:340px;width:1400px;height:8px;background:red"></div>
<script>
  document.getElementById("live").addEventListener("click", () => {
    document.body.appendChild(document.createElement("span"));
  });
</script>
</body></html>`;

/** A page with nothing wrong with it, for asserting the success exit code. */
export const CLEAN_HTML = `<!doctype html>
<html><head><title>clean</title></head>
<body style="margin:0"><button id="ok" style="width:80px;height:30px">OK</button></body></html>`;

export function serveFixture() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(HTML, { headers: { "content-type": "text/html" } });
      if (path === "/clean") return new Response(CLEAN_HTML, { headers: { "content-type": "text/html" } });
      if (path === "/missing.png") return new Response("not here", { status: 404 });
      return new Response("not found", { status: 404 });
    },
  });
}
