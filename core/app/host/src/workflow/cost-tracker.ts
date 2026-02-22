/**
 * CostTracker — port of Python cost.py.
 *
 * Accumulates token usage across orchestrator LLM calls and agent
 * executions. Provides breakdowns for logging and DB persistence.
 */

export interface CostEntry {
  source: string;
  tokensUsed: number;
  description: string;
  subtask?: string;
  region?: string;
}

export class CostTracker {
  private entries: CostEntry[] = [];

  /** Record a token usage event. */
  record(
    source: string,
    tokens: number,
    description: string,
    subtask?: string,
    region?: string,
  ): void {
    this.entries.push({ source, tokensUsed: tokens, description, subtask, region });
  }

  /** Total tokens across all entries. */
  get totalTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.tokensUsed, 0);
  }

  /** Tokens used by orchestrator LLM calls only (source === "orchestrator"). */
  get orchestratorTokens(): number {
    return this.entries
      .filter((e) => e.source === "orchestrator")
      .reduce((sum, e) => sum + e.tokensUsed, 0);
  }

  /** Breakdown by source. */
  breakdown(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const e of this.entries) {
      result[e.source] = (result[e.source] ?? 0) + e.tokensUsed;
    }
    return result;
  }

  /** Human-readable summary. */
  summary(): string {
    const bd = this.breakdown();
    const lines = Object.entries(bd)
      .sort(([, a], [, b]) => b - a)
      .map(([source, tokens]) => `  ${source}: ${tokens.toLocaleString()} tokens`);
    return [
      `Token usage: ${this.totalTokens.toLocaleString()} total`,
      ...lines,
    ].join("\n");
  }

  /** Reset all tracked entries. */
  reset(): void {
    this.entries = [];
  }

  /** Get all raw entries (for DB persistence). */
  getEntries(): readonly CostEntry[] {
    return this.entries;
  }
}
