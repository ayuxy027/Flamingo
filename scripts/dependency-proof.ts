#!/usr/bin/env bun

import { readFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";

let failures = 0;
const pass = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

console.log("\n\x1b[1mManifest\x1b[0m");
for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) {
  const value = pkg[field];
  const count = Array.isArray(value) ? value.length : Object.keys(value ?? {}).length;
  count === 0 ? pass(`${field}: empty`) : fail(`${field} has ${count} entr${count === 1 ? "y" : "ies"}: ${JSON.stringify(value)}`);
}

const dev = Object.keys(pkg.devDependencies ?? {});
console.log("\n\x1b[1mDev-only dependencies (permitted, disclosed in STDLIB.md)\x1b[0m");
if (dev.length === 0) pass("none");
for (const d of dev) {
  d.startsWith("@types/") || d.endsWith("-types")
    ? pass(`${d} — type declarations only, erased at runtime`)
    : fail(`${d} — not obviously type-only; justify it in STDLIB.md`);
}

const BUILTINS = new Set([...builtinModules, "bun", "bun:test", "bun:sqlite", "bun:ffi", "bun:jsc"]);
const source = readFileSync(pkg.module, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(?<!:)\/\/[^\n]*/g, "");
const specifiers = new Set<string>();
for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specifiers.add(m[1]!);
for (const m of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1]!);
for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1]!);

console.log(`\n\x1b[1mImports in ${pkg.module}\x1b[0m`);
if (specifiers.size === 0) pass("no imports at all");
for (const spec of [...specifiers].sort()) {
  const bare = spec.replace(/^node:/, "");
  if (spec.startsWith("node:") || BUILTINS.has(bare) || BUILTINS.has(spec)) pass(`${spec} — standard library`);
  else if (spec.startsWith(".") || spec.startsWith("/")) fail(`${spec} — relative import; the shipped artifact must be self-contained`);
  else fail(`${spec} — third-party package`);
}

console.log("\n\x1b[1mShipped files\x1b[0m");
const files: string[] = pkg.files ?? [];
files.length ? pass(`files: ${files.join(", ")}`) : fail("no files field — the whole directory would be published");
for (const f of files) (existsSync(f) ? pass : fail)(`${f} exists`);

console.log(
  failures === 0
    ? "\n\x1b[32m\x1b[1mZERO THIRD-PARTY RUNTIME DEPENDENCIES — verified\x1b[0m\n"
    : `\n\x1b[31m\x1b[1m${failures} check(s) failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
