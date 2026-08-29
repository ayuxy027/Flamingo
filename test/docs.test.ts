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
