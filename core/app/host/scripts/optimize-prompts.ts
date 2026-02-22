#!/usr/bin/env bun
/**
 * app/host/scripts/optimize-prompts.ts
 *
 * Generates optimized system prompts for the four Mastra orchestrator agents,
 * tailored to a specific repository. Results are written to the workspace DB's
 * `optimized_prompts` table and picked up automatically on the next orchestration
 * run — no restart required.
 *
 * Run from repo root via:
 *   bun run optimize-prompts [repoPath] [options]
 *
 * Options:
 *   --model <model>   Override the LLM (default: EISEN_ORCHESTRATOR_MODEL env or
 *                     "anthropic/claude-sonnet-4-20250514")
 *   --dry-run         Print generated prompts without writing to DB
 *   --json            Machine-readable JSON output (profile + prompts)
 *   --reset           Delete all optimized prompts, revert to static defaults
 *   --verbose         Show full repo profile and complete prompt text
 *
 * Pipeline:
 *   Phase 1 — Repo profiling  (filesystem only — works on any repo, no DB needed)
 *   Phase 2 — DB enrichment   (reads task_history / agent_performance / region_insights
 *                               if .eisen/workspace.db is present)
 *   Phase 3 — Prompt generation via a Mastra "meta-optimizer" agent
 *   Phase 4 — Write to optimized_prompts table (or stdout with --dry-run)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { WorkspaceDB } from "../src/db/workspace-db";
import { DEFAULT_PROMPTS } from "../src/workflow/agents";
import type { OptimizedPromptStep } from "../src/db/workspace-db";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}
function option(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

// First non-flag argument is the repo path; default to cwd
const repoPath = args.find((a) => !a.startsWith("--")) ?? process.cwd();
const model =
  option("model") ??
  process.env.EISEN_ORCHESTRATOR_MODEL ??
  "anthropic/claude-sonnet-4-20250514";
const dryRun  = flag("dry-run");
const asJson  = flag("json");
const reset   = flag("reset");
const verbose = flag("verbose");

if (!fs.existsSync(repoPath)) {
  console.error(`Error: repo path does not exist: ${repoPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reset mode — wipe all optimized prompts
// ---------------------------------------------------------------------------

if (reset) {
  const db = new WorkspaceDB(repoPath);
  const raw = db as unknown as { client(): Promise<import("bun:sqlite").Database> };
  const dbClient = await raw.client();
  dbClient.exec("DELETE FROM optimized_prompts");
  db.close();
  if (!asJson) console.log("Optimized prompts cleared. Static defaults will be used on next run.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LanguageStat {
  language: string;
  fileCount: number;
  estimatedLoc: number;
}

interface RepoProfile {
  repoPath: string;
  languages: LanguageStat[];
  primaryLanguage: string;
  frameworks: string[];
  architecture: "monolith" | "monorepo" | "multi-module" | "library" | "unknown";
  testFrameworks: string[];
  namingConvention: "camelCase" | "snake_case" | "kebab-case" | "mixed";
  fileCount: number;
  directoryDepth: number;
  hasDb: boolean;
  // Phase 2 — only present when .eisen/workspace.db exists
  topTaskPatterns?: string[];
  bestAgentByLanguage?: Record<string, string>;
  regionSummaries?: string[];
}

// ---------------------------------------------------------------------------
// Phase 1: Filesystem profiling
// ---------------------------------------------------------------------------

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".rs": "rust",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".c": "c",
  ".zig": "zig",
  ".ex": "elixir", ".exs": "elixir",
  ".clj": "clojure",
  ".scala": "scala",
  ".dart": "dart",
  ".lua": "lua",
  ".sh": "shell", ".bash": "shell",
};

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".eisen", "dist", "build", "target",
  ".next", ".nuxt", ".svelte-kit", "__pycache__", ".venv", "venv",
  "vendor", ".cargo", ".cache", "coverage", ".pytest_cache",
]);

function walkDir(
  dir: string,
  depth = 0,
  state = { files: [] as string[], maxDepth: 0 },
  maxDepth = 8,
  maxFiles = 50_000,
): { files: string[]; maxDepth: number } {
  if (depth > maxDepth || state.files.length >= maxFiles) return state;
  state.maxDepth = Math.max(state.maxDepth, depth);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return state;
  }

  for (const entry of entries) {
    if (state.files.length >= maxFiles) break;
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        walkDir(path.join(dir, entry.name), depth + 1, state, maxDepth, maxFiles);
      }
    } else if (entry.isFile()) {
      state.files.push(path.join(dir, entry.name));
    }
  }

  return state;
}

function estimateLoc(filePath: string): number {
  try {
    const buf = Buffer.alloc(65536);
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    let count = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x0a) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function detectFrameworks(repoPath: string): string[] {
  const found: string[] = [];

  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      const map: Record<string, string> = {
        react: "React", next: "Next.js", vue: "Vue", svelte: "Svelte",
        "@angular/core": "Angular", express: "Express", fastify: "Fastify",
        hono: "Hono", "@nestjs/core": "NestJS", vite: "Vite",
        vitest: "Vitest", jest: "Jest", "@tauri-apps/api": "Tauri",
        electron: "Electron", "@mastra/core": "Mastra",
      };
      for (const [dep, label] of Object.entries(map)) {
        if (deps[dep]) found.push(label);
      }
    } catch { /* ignore */ }
  }

  const cargoPath = path.join(repoPath, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    const c = fs.readFileSync(cargoPath, "utf8");
    if (c.includes("tokio")) found.push("Tokio");
    if (c.includes("axum"))  found.push("Axum");
    if (c.includes("actix")) found.push("Actix");
    if (c.includes("tauri")) found.push("Tauri");
    if (c.includes("napi"))  found.push("NAPI-RS");
  }

  const pyprojectPath = path.join(repoPath, "pyproject.toml");
  if (fs.existsSync(pyprojectPath)) {
    const c = fs.readFileSync(pyprojectPath, "utf8");
    if (c.includes("fastapi")) found.push("FastAPI");
    if (c.includes("django"))  found.push("Django");
    if (c.includes("flask"))   found.push("Flask");
    if (c.includes("pytest"))  found.push("pytest");
    if (c.includes("dspy"))    found.push("DSPy");
  }

  const gomodPath = path.join(repoPath, "go.mod");
  if (fs.existsSync(gomodPath)) {
    const c = fs.readFileSync(gomodPath, "utf8");
    if (c.includes("gin-gonic")) found.push("Gin");
    if (c.includes("/echo"))     found.push("Echo");
    if (c.includes("gofiber"))   found.push("Fiber");
  }

  return [...new Set(found)];
}

function detectArchitecture(repoPath: string): RepoProfile["architecture"] {
  let topDirs: string[];
  try {
    topDirs = fs.readdirSync(repoPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
      .map((e) => e.name);
  } catch {
    return "unknown";
  }

  const topSet = new Set(topDirs);

  if (topSet.has("packages") || topSet.has("apps")) return "monorepo";

  const withSrc = topDirs.filter((d) => fs.existsSync(path.join(repoPath, d, "src")));
  if (withSrc.length >= 3) return "multi-module";

  if ((topSet.has("lib") || topSet.has("src")) && !topSet.has("app") && !topSet.has("bin") && !topSet.has("cmd")) {
    const hasMain =
      fs.existsSync(path.join(repoPath, "src", "main.ts")) ||
      fs.existsSync(path.join(repoPath, "src", "main.rs")) ||
      fs.existsSync(path.join(repoPath, "src", "main.go"));
    if (!hasMain) return "library";
  }

  return "monolith";
}

function detectNamingConvention(files: string[]): RepoProfile["namingConvention"] {
  const sample = files
    .filter((f) => {
      const b = path.basename(f, path.extname(f));
      return !["index", "main", "mod", "lib"].includes(b) && b.length > 3;
    })
    .slice(0, 30)
    .map((f) => path.basename(f, path.extname(f)));

  let camel = 0, snake = 0, kebab = 0;
  for (const name of sample) {
    if (name.includes("-")) kebab++;
    else if (name.includes("_")) snake++;
    else if (/[A-Z]/.test(name)) camel++;
  }

  const total = camel + snake + kebab;
  if (total === 0) return "mixed";
  if (camel / total > 0.6) return "camelCase";
  if (snake / total > 0.6) return "snake_case";
  if (kebab / total > 0.6) return "kebab-case";
  return "mixed";
}

function detectTestFrameworks(repoPath: string, files: string[]): string[] {
  const found: string[] = [];

  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) found.push("vitest");
      if (deps.jest)   found.push("jest");
      if (deps.mocha)  found.push("mocha");
    } catch { /* ignore */ }
  }

  if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) found.push("cargo-test");
  if (fs.existsSync(path.join(repoPath, "go.mod")))     found.push("go-test");

  const pyproject = path.join(repoPath, "pyproject.toml");
  if (fs.existsSync(pyproject) && fs.readFileSync(pyproject, "utf8").includes("pytest")) {
    found.push("pytest");
  }

  return [...new Set(found)];
}

async function profileRepo(repoPath: string): Promise<RepoProfile> {
  const absPath = path.resolve(repoPath);
  if (verbose && !asJson) console.log(`Profiling: ${absPath}`);

  const { files, maxDepth } = walkDir(absPath);

  const langMap = new Map<string, { count: number; loc: number }>();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const lang = LANGUAGE_EXTENSIONS[ext];
    if (!lang) continue;
    const entry = langMap.get(lang) ?? { count: 0, loc: 0 };
    entry.count++;
    entry.loc += estimateLoc(file);
    langMap.set(lang, entry);
  }

  const languages: LanguageStat[] = [...langMap.entries()]
    .map(([language, { count, loc }]) => ({ language, fileCount: count, estimatedLoc: loc }))
    .sort((a, b) => b.fileCount - a.fileCount);

  return {
    repoPath: absPath,
    languages,
    primaryLanguage: languages[0]?.language ?? "unknown",
    frameworks: detectFrameworks(absPath),
    architecture: detectArchitecture(absPath),
    testFrameworks: detectTestFrameworks(absPath, files),
    namingConvention: detectNamingConvention(files),
    fileCount: files.length,
    directoryDepth: maxDepth,
    hasDb: fs.existsSync(path.join(absPath, ".eisen", "workspace.db")),
  };
}

// ---------------------------------------------------------------------------
// Phase 2: DB enrichment (optional)
// ---------------------------------------------------------------------------

async function enrichProfileFromDb(profile: RepoProfile): Promise<RepoProfile> {
  if (!profile.hasDb) return profile;

  const db = new WorkspaceDB(profile.repoPath);
  try {
    const history = await db.getRecentTaskHistory(50);
    const topTaskPatterns = history
      .filter((t) => (t.qualityScore ?? 0) >= 0.8)
      .slice(0, 5)
      .map((t) => t.userIntent);

    const perf = await db.getAgentPerformance();
    const bestAgentByLanguage: Record<string, string> = {};
    const byLang = new Map<string, typeof perf>();
    for (const p of perf) {
      if (!byLang.has(p.language)) byLang.set(p.language, []);
      byLang.get(p.language)!.push(p);
    }
    for (const [lang, stats] of byLang) {
      const qualified = stats
        .filter((s) => s.successCount + s.failCount >= 3)
        .sort((a, b) => {
          const rA = a.successCount / (a.successCount + a.failCount);
          const rB = b.successCount / (b.successCount + b.failCount);
          return rB - rA;
        });
      if (qualified[0]) bestAgentByLanguage[lang] = qualified[0].agentType;
    }

    const knownRegions = [...new Set(perf.map((p) => p.region).filter(Boolean))];
    const insights = await db.getRegionInsights(knownRegions);
    const regionSummaries = insights
      .filter((r) => r.description)
      .slice(0, 5)
      .map((r) => `${r.region}: ${r.description}`);

    return { ...profile, topTaskPatterns, bestAgentByLanguage, regionSummaries };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Prompt generation
// ---------------------------------------------------------------------------

const OptimizedPromptsSchema = z.object({
  taskDecompose: z.string().describe("Optimized system prompt for the taskDecompose agent"),
  agentSelect:   z.string().describe("Optimized system prompt for the agentSelect agent"),
  promptBuild:   z.string().describe("Optimized system prompt for the promptBuild agent"),
  progressEval:  z.string().describe("Optimized system prompt for the progressEval agent"),
  rationale:     z.string().describe("2–4 sentence explanation of the key tailoring decisions"),
});

type OptimizedPromptsOutput = z.infer<typeof OptimizedPromptsSchema>;

function buildMetaOptimizerInput(profile: RepoProfile): string {
  const lines: string[] = ["## Repository Profile"];
  lines.push(`- Path: ${profile.repoPath}`);
  lines.push(`- Primary language: ${profile.primaryLanguage}`);
  lines.push(
    `- Languages: ${profile.languages
      .map((l) => `${l.language} (${l.fileCount} files, ~${l.estimatedLoc} LOC)`)
      .join(", ")}`,
  );
  lines.push(`- Frameworks: ${profile.frameworks.length > 0 ? profile.frameworks.join(", ") : "none detected"}`);
  lines.push(`- Architecture: ${profile.architecture}`);
  lines.push(`- Test frameworks: ${profile.testFrameworks.length > 0 ? profile.testFrameworks.join(", ") : "none detected"}`);
  lines.push(`- File naming convention: ${profile.namingConvention}`);
  lines.push(`- Total files: ${profile.fileCount}, max directory depth: ${profile.directoryDepth}`);

  if (profile.topTaskPatterns?.length) {
    lines.push("\n## Successful Past Tasks (quality ≥ 0.8)");
    profile.topTaskPatterns.forEach((t) => lines.push(`  - "${t}"`));
  }
  if (profile.bestAgentByLanguage && Object.keys(profile.bestAgentByLanguage).length) {
    lines.push("\n## Best Agent by Language (from performance data)");
    for (const [lang, agent] of Object.entries(profile.bestAgentByLanguage)) {
      lines.push(`  - ${lang}: ${agent}`);
    }
  }
  if (profile.regionSummaries?.length) {
    lines.push("\n## Region Summaries");
    profile.regionSummaries.forEach((s) => lines.push(`  - ${s}`));
  }

  lines.push("\n## Current Default System Prompts (improve upon these)");
  const steps: OptimizedPromptStep[] = ["taskDecompose", "agentSelect", "promptBuild", "progressEval"];
  for (const step of steps) {
    lines.push(`\n### ${step}\n\`\`\`\n${DEFAULT_PROMPTS[step]}\n\`\`\``);
  }

  return lines.join("\n");
}

const META_OPTIMIZER_INSTRUCTIONS = `\
You are an expert prompt engineer specializing in multi-agent coding orchestration systems.

Generate optimized system prompts for a four-agent orchestration pipeline, tailored to a
specific repository. You receive a repository profile and the current default prompts as a baseline.

## The four agents

- **taskDecompose** — breaks a user's natural-language intent into parallel subtasks scoped
  to directory regions of the repo
- **agentSelect** — picks the best sub-agent (claude-code, opencode, codex, openai, gemini,
  goose, amp, aider) for each subtask
- **promptBuild** — constructs the detailed prompt sent to the chosen sub-agent
- **progressEval** — evaluates whether the sub-agent completed its assigned subtask

## Tailoring guidelines

**taskDecompose:**
- monorepo → decompose by package/app boundary (name regions as "packages/foo", "apps/bar")
- monolith → decompose by feature layer ("src/api", "src/db", "src/ui", "tests")
- multi-module → decompose by service boundary
- library → decompose by public API surface vs internal implementation
- Mention detected languages/frameworks so the LLM understands the stack
- Use the detected naming convention for consistent region path descriptions

**agentSelect:**
- CRITICAL (must always appear): If the user's query explicitly names an agent — e.g.
  "use claude", "with codex", "run gemini", "via openai", "spawn aider", "goose agent",
  bare agent name at start of query — always honour that preference and return that agent
  regardless of performance data or any other factor
- Embed best-agent-per-language data from performance history as concrete preferences
- Tailor capability descriptions to the detected stack (Rust-heavy repo → note which
  agents handle Rust well; Python-heavy → note Python strengths)

**promptBuild:**
- Reference the specific test frameworks detected (vitest, pytest, cargo-test, go-test)
- Use the naming convention to guide how agents name new files and functions
- Mention architecture so agents know where new files belong
- Include framework idiom guidance (e.g. Hono patterns, Axum handlers, Next.js conventions)
- The prompt must be fully self-contained — the sub-agent receives no other context

**progressEval:**
- Rust: look for compilation success signals in output
- TypeScript: look for type-check and test pass signals
- Python: look for pytest pass signals
- Go: look for go build / go test pass signals
- Reference the naming convention when checking whether expected files were created

## Non-negotiable rules
- agentSelect MUST include the explicit-agent-routing rule — this is the highest priority
- All prompts must be complete and self-contained
- Keep each prompt under 600 words
- rationale: 2–4 sentences on the most impactful tailoring decisions`;

async function generateOptimizedPrompts(profile: RepoProfile): Promise<OptimizedPromptsOutput> {
  if (!asJson) console.log(`Phase 3: Generating prompts with ${model}...`);

  const metaAgent = new Agent({
    id: "prompt-optimizer",
    name: "Prompt Optimizer",
    model,
    instructions: META_OPTIMIZER_INSTRUCTIONS,
  });

  const result = await metaAgent.generate(buildMetaOptimizerInput(profile), {
    structuredOutput: { schema: OptimizedPromptsSchema },
  });

  return result.object as OptimizedPromptsOutput;
}

// ---------------------------------------------------------------------------
// Phase 4: Write to DB
// ---------------------------------------------------------------------------

async function writeToDb(repoPath: string, profile: RepoProfile, prompts: OptimizedPromptsOutput): Promise<void> {
  const db = new WorkspaceDB(repoPath);
  const profileJson = JSON.stringify(profile);
  const steps: OptimizedPromptStep[] = ["taskDecompose", "agentSelect", "promptBuild", "progressEval"];
  try {
    for (const step of steps) {
      await db.upsertOptimizedPrompt({
        targetStep: step,
        systemPrompt: prompts[step],
        repoProfile: profileJson,
        model,
      });
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!asJson) console.log("Phase 1: Profiling repository...");
  let profile = await profileRepo(repoPath);

  if (profile.hasDb) {
    if (!asJson) console.log("Phase 2: Enriching from .eisen/workspace.db...");
    profile = await enrichProfileFromDb(profile);
  } else {
    if (!asJson) console.log("Phase 2: No .eisen/workspace.db — using filesystem profile only.");
  }

  if (verbose && !asJson) {
    console.log("\nRepo profile:");
    console.log(JSON.stringify(profile, null, 2));
  }

  const generated = await generateOptimizedPrompts(profile);

  const steps = ["taskDecompose", "agentSelect", "promptBuild", "progressEval"] as const;

  if (asJson) {
    console.log(JSON.stringify({ profile, prompts: generated }, null, 2));
    return;
  }

  if (dryRun) {
    console.log("\n--- DRY RUN (not written to DB) ---");
    for (const step of steps) {
      console.log(`\n=== ${step} ===`);
      if (verbose) {
        console.log(generated[step]);
      } else {
        console.log(generated[step].split("\n").slice(0, 4).join("\n") + "\n  [...]");
      }
    }
    console.log(`\nRationale: ${generated.rationale}`);
    console.log("\nRun without --dry-run to write to .eisen/workspace.db");
    return;
  }

  console.log("Phase 4: Writing to .eisen/workspace.db...");
  await writeToDb(repoPath, profile, generated);

  console.log("\nOptimized prompts written:");
  for (const step of steps) console.log(`  ${step}`);
  console.log(`\nRationale: ${generated.rationale}`);
  console.log("\nThe next orchestration run will use these prompts automatically.");
  console.log("To revert: bun run optimize-prompts --reset");
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
