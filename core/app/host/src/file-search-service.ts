/**
 * File search service for the standalone host.
 *
 * Adapted from extension/src/fileSearchService.ts — uses fast-glob instead
 * of vscode.workspace.findFiles, and removes the onDidOpenTextDocument
 * tracking (no editor in standalone host).
 */

import * as path from "node:path";
import fg from "fast-glob";

export interface FileSearchResult {
  readonly path: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly languageId: string;
  readonly isDirectory: boolean;
}

const EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.venv/**",
  "**/__pycache__/**",
];

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".r": "r",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".fish": "shellscript",
  ".ps1": "powershell",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".json": "json",
  ".jsonc": "jsonc",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdx": "mdx",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".dockerfile": "dockerfile",
  ".proto": "proto3",
  ".vue": "vue",
  ".svelte": "svelte",
};

function getLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (LANGUAGE_MAP[ext]) return LANGUAGE_MAP[ext];
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  if (basename === "rakefile") return "ruby";
  return "plaintext";
}

export class FileSearchService {
  constructor(private readonly workspaceRoot: string) {}

  async search(query: string, maxResults = 20): Promise<FileSearchResult[]> {
    const glob = query.trim() === "" ? "**/*" : `**/*${query}*`;

    const entries = await fg(glob, {
      cwd: this.workspaceRoot,
      ignore: EXCLUDE_PATTERNS,
      dot: false,
      onlyFiles: true,
      absolute: true,
      suppressErrors: true,
    });

    const queryLower = query.toLowerCase();

    // Collect file results
    const results: FileSearchResult[] = entries
      .filter((filePath) => {
        if (query.trim() === "") return true;
        const fileName = path.basename(filePath).toLowerCase();
        return fileName.includes(queryLower);
      })
      .slice(0, 200) // Limit before expensive operations
      .map((filePath) => ({
        path: filePath,
        fileName: path.basename(filePath),
        relativePath: path.relative(this.workspaceRoot, filePath),
        languageId: getLanguageId(filePath),
        isDirectory: false,
      }));

    // Extract unique directories from file results and add matching ones
    const dirSet = new Set<string>();
    for (const filePath of entries.slice(0, 200)) {
      let dir = path.dirname(filePath);
      while (dir.length > this.workspaceRoot.length) {
        if (dirSet.has(dir)) break;
        dirSet.add(dir);
        dir = path.dirname(dir);
      }
    }

    const dirResults: FileSearchResult[] = [];
    for (const dirPath of dirSet) {
      const dirName = path.basename(dirPath);
      const relPath = path.relative(this.workspaceRoot, dirPath);
      if (
        query.trim() === "" ||
        dirName.toLowerCase().includes(queryLower) ||
        relPath.toLowerCase().includes(queryLower)
      ) {
        dirResults.push({
          path: dirPath,
          fileName: dirName,
          relativePath: relPath,
          languageId: "directory",
          isDirectory: true,
        });
      }
    }

    // Merge: directories first (sorted by depth ascending), then files
    dirResults.sort((a, b) => {
      const aDepth = a.relativePath.split(path.sep).length;
      const bDepth = b.relativePath.split(path.sep).length;
      if (aDepth !== bDepth) return aDepth - bDepth;
      return a.relativePath.localeCompare(b.relativePath);
    });

    // Sort files alphabetically (no recent files tracking in standalone host)
    results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const combined = [...dirResults, ...results];
    return combined.slice(0, maxResults);
  }
}
