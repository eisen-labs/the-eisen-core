/**
 * Integration tests for the eisen-napi NAPI-RS bridge.
 *
 * Verifies that all four exported functions produce valid JSON with the
 * expected shapes. Uses the actual eisen-core parser against `core/src/`.
 *
 * Run with: bun test crates/eisen-napi/__tests__/napi.test.ts
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const napi = require("../index.js") as {
  parseWorkspace(path: string): string;
  parseFile(path: string): string;
  snapshot(path: string): string;
  lookupSymbol(workspacePath: string, symbolName: string): string;
};

// Use the core/src directory as a stable test fixture
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CORE_SRC = path.join(REPO_ROOT, "core", "src");
const LIB_RS = path.join(CORE_SRC, "lib.rs");

// ---------------------------------------------------------------------------
// parseWorkspace
// ---------------------------------------------------------------------------

describe("parseWorkspace", () => {
  test("returns valid JSON with nested SerializableNode", () => {
    const raw = napi.parseWorkspace(CORE_SRC);
    const tree = JSON.parse(raw);

    expect(tree).toBeDefined();
    expect(tree.name).toBe("src");
    expect(tree.kind).toBe("folder");
    expect(Array.isArray(tree.children)).toBe(true);
    expect(tree.children.length).toBeGreaterThan(0);
  });

  test("child nodes have required fields", () => {
    const tree = JSON.parse(napi.parseWorkspace(CORE_SRC));
    const child = tree.children[0];

    expect(typeof child.id).toBe("number");
    expect(typeof child.name).toBe("string");
    expect(typeof child.kind).toBe("string");
    expect(typeof child.startLine).toBe("number");
    expect(typeof child.endLine).toBe("number");
    expect(typeof child.path).toBe("string");
  });

  test("contains known files from core/src", () => {
    const tree = JSON.parse(napi.parseWorkspace(CORE_SRC));
    const names = tree.children.map((c: { name: string }) => c.name);
    expect(names).toContain("lib.rs");
  });

  test("returns empty folder for nonexistent path", () => {
    // eisen-core does not error on missing dirs — it returns an empty folder node
    const tree = JSON.parse(napi.parseWorkspace("/nonexistent/path/abc123"));
    expect(tree.kind).toBe("folder");
    expect(tree.children).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseFile
// ---------------------------------------------------------------------------

describe("parseFile", () => {
  test("returns valid JSON array of NodeData", () => {
    const raw = napi.parseFile(LIB_RS);
    const nodes = JSON.parse(raw);

    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
  });

  test("NodeData entries have required fields", () => {
    const nodes = JSON.parse(napi.parseFile(LIB_RS));
    const node = nodes[0];

    expect(typeof node.id).toBe("number");
    expect(typeof node.name).toBe("string");
    expect(typeof node.kind).toBe("string");
    expect(typeof node.startLine).toBe("number");
    expect(typeof node.endLine).toBe("number");
    expect(typeof node.path).toBe("string");
  });

  test("all nodes reference the requested file path", () => {
    const nodes = JSON.parse(napi.parseFile(LIB_RS));
    for (const node of nodes) {
      expect(node.path).toBe(LIB_RS);
    }
  });

  test("returns empty array for nonexistent file", () => {
    // eisen-core returns empty results rather than erroring
    const nodes = JSON.parse(napi.parseFile("/nonexistent/file.rs"));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

describe("snapshot", () => {
  test("returns valid JSON UiSnapshot", () => {
    const raw = napi.snapshot(CORE_SRC);
    const snap = JSON.parse(raw);

    expect(typeof snap.seq).toBe("number");
    expect(snap.seq).toBe(0);
    expect(typeof snap.nodes).toBe("object");
    expect(Object.keys(snap.nodes).length).toBeGreaterThan(0);
  });

  test("UiNode entries have expected shape", () => {
    const snap = JSON.parse(napi.snapshot(CORE_SRC));
    const firstKey = Object.keys(snap.nodes)[0];
    const node = snap.nodes[firstKey];

    // kind is optional but should be present for most nodes
    if (node.kind !== undefined) {
      expect(typeof node.kind).toBe("string");
    }
  });

  test("calls array contains UiCallEdge entries", () => {
    const snap = JSON.parse(napi.snapshot(CORE_SRC));

    if (snap.calls && snap.calls.length > 0) {
      const edge = snap.calls[0];
      expect(typeof edge.from).toBe("string");
      expect(typeof edge.to).toBe("string");
    }
  });

  test("returns empty snapshot for nonexistent path", () => {
    const snap = JSON.parse(napi.snapshot("/nonexistent/path/abc123"));
    expect(snap.seq).toBe(0);
    expect(Object.keys(snap.nodes).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lookupSymbol
// ---------------------------------------------------------------------------

describe("lookupSymbol", () => {
  test("finds known symbol SymbolTree", () => {
    const raw = napi.lookupSymbol(CORE_SRC, "SymbolTree");
    const results = JSON.parse(raw);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("SymbolTree");
  });

  test("returns empty array for unknown symbol", () => {
    const raw = napi.lookupSymbol(CORE_SRC, "NonExistentSymbol_XYZ_12345");
    const results = JSON.parse(raw);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  test("result NodeData has required fields", () => {
    const results = JSON.parse(napi.lookupSymbol(CORE_SRC, "SymbolTree"));
    const node = results[0];

    expect(typeof node.id).toBe("number");
    expect(typeof node.name).toBe("string");
    expect(typeof node.kind).toBe("string");
    expect(typeof node.path).toBe("string");
  });

  test("returns empty array for nonexistent workspace", () => {
    const results = JSON.parse(
      napi.lookupSymbol("/nonexistent/path/abc123", "anything"),
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-function consistency
// ---------------------------------------------------------------------------

describe("cross-function consistency", () => {
  test("parseWorkspace and snapshot agree on file count", () => {
    const tree = JSON.parse(napi.parseWorkspace(CORE_SRC));
    const snap = JSON.parse(napi.snapshot(CORE_SRC));

    // Count file nodes in the tree (kind === "file")
    function countFiles(node: { kind: string; children?: unknown[] }): number {
      let count = node.kind === "file" ? 1 : 0;
      if (node.children) {
        for (const child of node.children as { kind: string; children?: unknown[] }[]) {
          count += countFiles(child);
        }
      }
      return count;
    }

    const treeFiles = countFiles(tree);
    // snapshot nodes include files and their symbols
    const snapFiles = Object.values(snap.nodes).filter(
      (n: unknown) => (n as { kind?: string }).kind === "file",
    ).length;

    // They should be equal — both come from the same SymbolTree
    expect(treeFiles).toBe(snapFiles);
  });

  test("lookupSymbol results appear in parseWorkspace tree", () => {
    const results = JSON.parse(napi.lookupSymbol(CORE_SRC, "SymbolTree"));
    expect(results.length).toBeGreaterThan(0);

    const tree = JSON.parse(napi.parseWorkspace(CORE_SRC));

    // Search the tree for the symbol name
    function findInTree(node: { name: string; children?: unknown[] }, name: string): boolean {
      if (node.name === name) return true;
      if (node.children) {
        for (const child of node.children as { name: string; children?: unknown[] }[]) {
          if (findInTree(child, name)) return true;
        }
      }
      return false;
    }

    expect(findInTree(tree, "SymbolTree")).toBe(true);
  });
});
