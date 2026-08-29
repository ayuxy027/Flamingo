import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { schemaDoc, SKILL_MD } from "../flamingo.ts";

describe("generated artifacts", () => {
  test("docs, skills and mcp match what the source produces", async () => {
    const proc = Bun.spawn(["bun", "run", "scripts/generate-docs.ts", "--check"], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(`${out}${err}`).not.toContain("out of date");
    expect(code).toBe(0);
  }, 60_000);

  test("the checked-in skill is the one init writes", () => {
    expect(readFileSync("skills/flamingo/SKILL.md", "utf8")).toBe(SKILL_MD);
  });

  test("mcp/tools.json describes every tool the server serves", () => {
    const onDisk = JSON.parse(readFileSync("mcp/tools.json", "utf8"));
    const live = schemaDoc();
    expect(onDisk.tools.map((t: any) => t.name)).toEqual(live.tools.map((t) => t.name));
    expect(onDisk.commands.map((c: any) => c.name)).toEqual(live.commands.map((c) => c.name));
  });

  test("mcp/config.json is a usable server entry", () => {
    const cfg = JSON.parse(readFileSync("mcp/config.json", "utf8"));
    expect(cfg.mcpServers.flamingo.args).toContain("serve");
  });

  test("every constructor option and exported type is documented", () => {
    const source = readFileSync("flamingo.ts", "utf8");
    const api = readFileSync("docs/api.md", "utf8");

    const start = source.indexOf("export interface EngineOptions {");
    const optionsBlock = source.slice(start, source.indexOf("\n}", start));
    const options = [...optionsBlock.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
    expect(options.length).toBeGreaterThan(5);

    const types = [
      ...[...source.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]!),
      ...[...source.matchAll(/^export type (\w+)/gm)].map((m) => m[1]!),
    ];

    expect(options.filter((o) => !api.includes(`\`${o}\``))).toEqual([]);
    expect(types.filter((t) => !api.includes(`\`${t}\``))).toEqual([]);
  });

  test("every public Engine method appears in the API docs", async () => {
    const { Engine } = await import("../flamingo.ts");
    const api = readFileSync("docs/api.md", "utf8");
    const source = readFileSync("flamingo.ts", "utf8");
    const privates = new Set(
      [...source.matchAll(/\n\s+private\s+(?:readonly\s+|async\s+)*([a-zA-Z][a-zA-Z0-9]*)\s*[(<]/g)].map((m) => m[1]!),
    );
    const missing = Object.getOwnPropertyNames(Engine.prototype).filter((n) => {
      if (n === "constructor" || privates.has(n)) return false;
      const d = Object.getOwnPropertyDescriptor(Engine.prototype, n);
      if (!d || typeof d.value !== "function") return false;
      return !api.includes(`\`${n}\``);
    });
    expect(missing).toEqual([]);
  });

  test("every documented file exists and is non-trivial", () => {
    for (const f of ["docs/api.md", "docs/cli.md", "docs/mcp-tools.md", "docs/internals.md"]) {
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f, "utf8").length).toBeGreaterThan(500);
    }
  });
});

describe("source style", () => {
  test("core files carry no comments", () => {
    const files = [
      "flamingo.ts",
      "scripts/generate-docs.ts",
      "scripts/dependency-proof.ts",
      "scripts/verify-reproducible.ts",
      "scripts/serve-website.ts",
    ];
    for (const f of files) {
      const offenders = readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /^\s*(\/\/|\/\*|\*\s)/.test(line));
      expect({ file: f, offenders: offenders.map((o) => `${o.n}: ${o.line.trim()}`) }).toEqual({ file: f, offenders: [] });
    }
  });
});
