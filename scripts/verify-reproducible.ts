#!/usr/bin/env bun

import { rmSync, mkdirSync, renameSync, readFileSync } from "node:fs";

const OUT_DIR = "dist";
const OUT = `${OUT_DIR}/flamingo`;
const BUILD = ["bun", "build", "--compile", "--minify", "--sourcemap=none", "flamingo.ts", "--outfile", OUT];

const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

async function build(label: string): Promise<string> {
  const proc = Bun.spawn(BUILD, { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    console.error(await new Response(proc.stderr).text());
    throw new Error(`${label} build failed`);
  }
  const digest = sha256(OUT);
  console.log(`  ${label}  ${digest}`);
  return digest;
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log("\n\x1b[1mBuilding twice to the same path\x1b[0m");
const first = await build("build 1");
renameSync(OUT, `${OUT}.1`);
const second = await build("build 2");

const identical = first === second;
console.log(
  identical
    ? `\n\x1b[32m\x1b[1mREPRODUCIBLE — both builds are byte-identical\x1b[0m\n\n  sha256  ${first}\n`
    : `\n\x1b[31m\x1b[1mNOT REPRODUCIBLE\x1b[0m\n  ${first}\n  ${second}\n`,
);

rmSync(`${OUT}.1`, { force: true });
process.exit(identical ? 0 : 1);
