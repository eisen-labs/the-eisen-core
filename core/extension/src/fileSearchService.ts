import * as path from "node:path";
import * as vscode from "vscode";

export interface FileSearchResult {
  readonly path: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly languageId: string;
  readonly isDirectory: boolean;
}

const EXCLUDE_PATTERN =
  "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/target/**,**/.venv/**,**/__pycache__/**}";

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
  private recentFiles: Map<string, number> = new Map();

  constructor() {
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === "file") {
        this.recentFiles.set(doc.uri.fsPath, Date.now());
      }
    });
  }

  async search(query: string, maxResults = 20): Promise<FileSearchResult[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const glob = query.trim() === "" ? "**/*" : `**/*${query}*`;
    const uris = await vscode.workspace.findFiles(glob, EXCLUDE_PATTERN, 200);

    const queryLower = query.toLowerCase();

    // Collect file results
    const results: FileSearchResult[] = uris
      .filter((uri) => {
        if (query.trim() === "") return true;
        const fileName = path.basename(uri.fsPath).toLowerCase();
        return fileName.includes(queryLower);
      })
      .map((uri) => ({
        path: uri.fsPath,
        fileName: path.basename(uri.fsPath),
        relativePath: vscode.workspace.asRelativePath(uri, false),
        languageId: getLanguageId(uri.fsPath),
        isDirectory: false,
      }));

    // Extract unique directories from file results and add matching ones
    const dirSet = new Set<string>();
    for (const uri of uris) {
      let dir = path.dirname(uri.fsPath);
      // Walk up to workspace root, collecting intermediate dirs
      const rootPath = workspaceFolder.uri.fsPath;
      while (dir.length > rootPath.length) {
        if (dirSet.has(dir)) break;
        dirSet.add(dir);
        dir = path.dirname(dir);
      }
    }

    const dirResults: FileSearchResult[] = [];
    for (const dirPath of dirSet) {
      const dirName = path.basename(dirPath);
      const relPath = vscode.workspace.asRelativePath(vscode.Uri.file(dirPath), false);
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

    // Sort files: recently opened first, then alphabetically
    results.sort((a, b) => {
      const aRecent = this.recentFiles.get(a.path) ?? 0;
      const bRecent = this.recentFiles.get(b.path) ?? 0;
      if (aRecent !== bRecent) return bRecent - aRecent;
      return a.relativePath.localeCompare(b.relativePath);
    });

    // Interleave: put matching directories at the top, then files
    const combined = [...dirResults, ...results];
    return combined.slice(0, maxResults);
  }
}
