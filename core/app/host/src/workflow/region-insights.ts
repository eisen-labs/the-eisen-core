/**
 * Background region insight generator.
 *
 * Called fire-and-forget after each orchestration run to keep region
 * descriptions, conventions, and dependency summaries fresh. Errors are
 * swallowed — this is non-critical background work.
 */

import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import type { WorkspaceDB } from "../db";
import { createMonitoredAgent } from "../paid";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RegionInsightSchema = z.object({
  description: z.string(),
  conventions: z.string(),
  dependencies: z.string(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Refresh region insights for touched regions in the background.
 *
 * Each region is checked against the 20%-stale threshold: if more than
 * 20% of the region's files changed since the last insight was generated
 * (or no insight exists), a new one is generated via LLM.
 *
 * @param db             WorkspaceDB instance (caller manages lifecycle).
 * @param workspacePath  Absolute workspace path (unused here, reserved for future use).
 * @param touchedRegions Regions touched by the most recent orchestration run.
 * @param model          AI model string (e.g. "anthropic/claude-sonnet-4-20250514").
 */
export async function refreshStaleRegionInsights(
  db: WorkspaceDB,
  workspacePath: string,
  touchedRegions: string[],
  model: string,
): Promise<void> {
  let insightAgent = new Agent({
    id: "region-insight" as const,
    name: "Region Insight",
    model,
    instructions:
      "You are a senior software engineer analysing a codebase region. " +
      "Given the region path, a list of files, and recent commit messages, " +
      "produce a concise description of what the region does, the coding " +
      "conventions it follows, and its external dependencies. " +
      "Be specific and factual — avoid generic statements.",
  });

  // Wrap with Paid monitoring if configured
  insightAgent = createMonitoredAgent(insightAgent, {
    eventName: "region_insight",
    customerId: workspacePath,
    productId: "eisen-region-insights",
  });

  for (const region of touchedRegions) {
    try {
      await refreshRegion(db, region, insightAgent);
    } catch {
      // Non-critical — swallow per-region errors
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function refreshRegion(
  db: WorkspaceDB,
  region: string,
  agent: Agent<"region-insight">,
): Promise<void> {
  const files = await db.getFilesInRegion(region);
  if (files.length === 0) return;

  const existingInsight = await db.getRegionInsight(region);
  const lastUpdated = existingInsight?.lastUpdated ?? 0;

  const changedCount = files.filter(
    (f) => f.lastModified !== null && f.lastModified > lastUpdated,
  ).length;

  // Skip if ≤20% changed and an insight already exists
  if (existingInsight && changedCount / files.length <= 0.2) return;

  const filePaths = files.map((f) => f.path);
  const recentCommits = await db.getRecentCommitsForFiles(filePaths, 10);

  const fileList = filePaths.slice(0, 20).join("\n");
  const commitMsgs = recentCommits
    .map((c) => c.commitMsg)
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Region: ${region}`,
    `Files (up to 20):\n${fileList}`,
    commitMsgs ? `Recent commit messages:\n${commitMsgs}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await agent.generate(prompt, {
    structuredOutput: { schema: RegionInsightSchema },
  });

  const obj = result.object as z.infer<typeof RegionInsightSchema>;

  await db.upsertRegionInsight({
    region,
    description: obj.description,
    conventions: obj.conventions,
    dependencies: obj.dependencies,
  });
}
