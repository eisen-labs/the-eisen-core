#!/usr/bin/env bun
/**
 * Build eisen-host for the current platform with the correct Tauri sidecar name
 * (eisen-host-<target-triple>). Run from app/ so paths are host/ and src-tauri/bin/.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";

function getTargetTriple() {
  try {
    return execSync("rustc --print host-tuple", { encoding: "utf-8" }).trim();
  } catch {
    // Fallback when rustc is not in PATH (e.g. some CI)
    const map = {
      "linux-x64": "x86_64-unknown-linux-gnu",
      "linux-arm64": "aarch64-unknown-linux-gnu",
      "darwin-x64": "x86_64-apple-darwin",
      "darwin-arm64": "aarch64-apple-darwin",
      "win32-x64": "x86_64-pc-windows-msvc",
    };
    const key = `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
    const triple = map[key];
    if (!triple) throw new Error(`Unknown platform: ${key}`);
    return triple;
  }
}

function getBunTarget() {
  const a = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "linux") return `bun-linux-${a}`;
  if (process.platform === "darwin") return `bun-darwin-${a}`;
  if (process.platform === "win32") return "bun-windows-x64";
  throw new Error(`Unsupported platform: ${process.platform}`);
}

const triple = getTargetTriple();
const outName = `eisen-host-${triple}${ext}`;
const outDir = join(__dirname, "..", "src-tauri", "bin");
const outFile = join(outDir, outName);

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const bunTarget = getBunTarget();
const hostDir = join(__dirname, "..", "host");
const entry = join(hostDir, "src", "index.ts");

console.log("[build-host] Building for", triple, "with", bunTarget);
execSync(
  `bun build "${entry}" --compile --target ${bunTarget} --outfile "${outFile}"`,
  { cwd: hostDir, stdio: "inherit" }
);
console.log("[build-host] Wrote", outFile);
