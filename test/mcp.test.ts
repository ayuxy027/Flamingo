import { test, expect, beforeAll, afterAll } from "bun:test";
import { serveFixture } from "./fixture.ts";

let server: ReturnType<typeof serveFixture>;
let url: string;

beforeAll(() => {
  server = serveFixture();
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => server.stop(true));

/** Drive the server the way a real MCP client does: JSON-RPC lines in, lines out. */
async function rpc(requests: unknown[]): Promise<any[]> {
  const proc = Bun.spawn(["bun", "run", "flamingo.ts", "serve"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("initialize and tools/list return valid JSON-RPC", async () => {
  const [init, list] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);

  expect(init.id).toBe(1);
  expect(init.result.serverInfo.name).toBe("flamingo");
  expect(init.result.capabilities.tools).toBeDefined();

  expect(list.result.tools.length).toBeGreaterThanOrEqual(15);
  const names = list.result.tools.map((t: any) => t.name);
  expect(names).toContain("getInteractiveTree");
  expect(names).toContain("compileHealthReport");
  // every tool must carry a description and a schema, or the agent flies blind
  for (const t of list.result.tools) {
    expect(t.description.length).toBeGreaterThan(20);
    expect(t.inputSchema.type).toBe("object");
  }
}, 30_000);

test("tools/call drives a real browser end to end", async () => {
  const [, gotoRes, treeRes] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goto", arguments: { url } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "getInteractiveTree", arguments: {} } },
  ]);

  // an acting tool returns its own JSON on the first line, then the observation
  const [gotoLine, , ...observation] = (gotoRes.result.content[0].text as string).split("\n");
  expect(JSON.parse(gotoLine!).title).toBe("flamingo fixture");
  expect(observation.join("\n")).toContain("elements");

  const tree = JSON.parse(treeRes.result.content[0].text);
  expect(tree.interactiveElements.map((i: any) => i.ref)).toContain("button#live");
  expect(treeRes.result.isError).toBeUndefined();
}, 60_000);

test("a chrome-only tool on the webkit default fails as a result, not a crash", async () => {
  const [, , res] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goto", arguments: { url } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "interceptTraffic", arguments: {} } },
  ]);
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toMatch(/requires backend: "chrome"/);
}, 60_000);

test("unknown tool and unknown method are protocol errors", async () => {
  const [, bad, missing] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "does/notExist" },
  ]);
  expect(bad.error.code).toBe(-32602);
  expect(missing.error.code).toBe(-32601);
}, 30_000);

test("notifications get no response", async () => {
  const out = await rpc([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "ping" },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe(1);
}, 30_000);

test("initialize carries operating instructions for clients that read them", async () => {
  const [init] = await rpc([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]);
  const text = init.result.instructions as string;
  expect(text.length).toBeGreaterThan(300);
  // the parts an agent gets wrong without being told
  expect(text).toContain("changed: false");
  expect(text).toContain("blockedBy");
  expect(text).toContain("nativePicker");
  expect(text).toContain("waitFor");
}, 30_000);

test("observe returns compact text by default and JSON on request", async () => {
  const [, , compact, structured] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goto", arguments: { url } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "observe", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "observe", arguments: { format: "json" } } },
  ]);

  const compactText = compact.result.content[0].text as string;
  expect(compactText).toContain("elements");
  expect(compactText).toContain("button#live");
  expect(() => JSON.parse(compactText)).toThrow(); // it is text, not JSON

  const jsonText = structured.result.content[0].text as string;
  const parsed = JSON.parse(jsonText);
  expect(parsed.elements.length).toBeGreaterThan(0);
  // the whole point: the default costs far fewer tokens
  expect(compactText.length).toBeLessThan(jsonText.length * 0.6);
}, 60_000);
