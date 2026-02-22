/**
 * SharedZoneConfig — port of Python zones.py.
 *
 * Defines glob patterns for files that are shared across all agents
 * (package.json, tsconfig.json, etc.). Agents can read these files
 * regardless of their assigned region.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Default shared zone patterns — files any agent may read. */
export const DEFAULT_SHARED_ZONES: string[] = [
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.*.json",
  ".eslintrc*",
  ".prettierrc*",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "poetry.lock",
  ".gitignore",
  ".env.example",
  "README.md",
  "LICENSE",
];

export interface SharedZoneOptions {
  customPatterns?: string[];
  useDefaults?: boolean;
}

export class SharedZoneConfig {
  private readonly customPatterns: string[];
  private readonly useDefaults: boolean;

  constructor(options: SharedZoneOptions = {}) {
    this.customPatterns = options.customPatterns ?? [];
    this.useDefaults = options.useDefaults ?? true;
  }

  /** All active glob patterns (defaults + custom). */
  getAllPatterns(): string[] {
    const patterns = this.useDefaults ? [...DEFAULT_SHARED_ZONES] : [];
    patterns.push(...this.customPatterns);
    return patterns;
  }

  /**
   * Load zone config from `.eisen/config.json` in the workspace.
   * Falls back to defaults if the config file doesn't exist.
   */
  static fromWorkspace(workspacePath: string): SharedZoneConfig {
    const configPath = path.join(workspacePath, ".eisen", "config.json");
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      return new SharedZoneConfig({
        customPatterns: config.sharedZones?.customPatterns,
        useDefaults: config.sharedZones?.useDefaults,
      });
    } catch {
      return new SharedZoneConfig();
    }
  }
}
