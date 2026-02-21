import * as path from "path";
import * as fs from "fs";

/**
 * Resolve the path to the eisen-core binary.
 *
 * Resolution order:
 *  1. Bundled binary inside the extension at <extensionDir>/bin/eisen-core(.exe)
 *     — used when installed from a .vsix package.
 *  2. Dev fallback at <extensionDir>/../core/target/release/eisen-core(.exe)
 *     — used during local development with a cargo build.
 */
export function getCorePath(extensionUri: { fsPath: string }): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const binaryName = `eisen-core${ext}`;

  // 1. Bundled binary (production / .vsix install)
  const bundledPath = path.join(extensionUri.fsPath, "bin", binaryName);
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  // 2. Dev fallback: local cargo release build
  return path.join(
    extensionUri.fsPath,
    "..",
    "core",
    "target",
    "release",
    binaryName,
  );
}
