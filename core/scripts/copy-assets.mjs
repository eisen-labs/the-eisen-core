/**
 * Copy compiled frontend assets from extension/ and ui/ into app/public/
 * so the Tauri Vite frontend can serve them.
 */

import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("app/public", { recursive: true });

// Chat webview bundle
copyFileSync("extension/dist/chatWebview.js", "app/public/chatWebview.js");

// CSS from extension styles
copyFileSync("extension/src/styles/reset.css", "app/public/reset.css");
copyFileSync("extension/src/styles/vscode.css", "app/public/vscode.css");
copyFileSync("extension/src/styles/main.css", "app/public/main.css");

// Graph UI bundle
copyFileSync("ui/dist/main.js", "app/public/graph.js");
copyFileSync("ui/dist/style.css", "app/public/graph.css");

console.log("[copy-assets] Done — 6 files copied to app/public/");
