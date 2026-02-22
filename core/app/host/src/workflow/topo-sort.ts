/**
 * Topological batch sort — port of Python _build_execution_batches.
 *
 * Groups subtasks into execution batches by dependency order.
 * Subtasks within a batch can run in parallel.
 * Batch N contains subtasks whose dependencies are all in batches 0..N-1.
 */

import type { Subtask } from "./schemas";

export interface BatchItem<T = unknown> {
  index: number;
  subtask: Subtask;
  /** Arbitrary payload attached per item (e.g. agent assignment info). */
  data: T;
}

/**
 * Sort items into execution batches respecting `dependsOn` constraints.
 *
 * @returns Array of batches. Each batch is an array of items that can
 *          execute concurrently. Batches must execute sequentially.
 */
export function buildExecutionBatches<T>(items: BatchItem<T>[]): BatchItem<T>[][] {
  if (items.length === 0) return [];

  const byIndex = new Map<number, BatchItem<T>>();
  for (const item of items) {
    byIndex.set(item.index, item);
  }

  const assignedBatch = new Map<number, number>();

  function getBatchLevel(idx: number, visited: Set<number>): number {
    const cached = assignedBatch.get(idx);
    if (cached !== undefined) return cached;

    if (visited.has(idx)) {
      // Circular dependency — break the cycle
      console.warn(`[topo-sort] Circular dependency detected at subtask ${idx}`);
      return 0;
    }
    visited.add(idx);

    const item = byIndex.get(idx);
    if (!item) return 0;

    const deps = item.subtask.dependsOn;
    if (!deps || deps.length === 0) {
      assignedBatch.set(idx, 0);
      return 0;
    }

    let maxDepLevel = 0;
    for (const depIdx of deps) {
      if (byIndex.has(depIdx)) {
        const depLevel = getBatchLevel(depIdx, visited);
        maxDepLevel = Math.max(maxDepLevel, depLevel + 1);
      }
    }

    assignedBatch.set(idx, maxDepLevel);
    return maxDepLevel;
  }

  for (const idx of byIndex.keys()) {
    getBatchLevel(idx, new Set());
  }

  // Group into batches
  const maxLevel = Math.max(...assignedBatch.values());
  const batches: BatchItem<T>[][] = [];

  for (let level = 0; level <= maxLevel; level++) {
    const batch: BatchItem<T>[] = [];
    for (const [idx, batchLevel] of [...assignedBatch.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (batchLevel === level) {
        const item = byIndex.get(idx);
        if (item) batch.push(item);
      }
    }
    if (batch.length > 0) {
      batches.push(batch);
    }
  }

  return batches;
}
