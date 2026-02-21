# Eisen Desktop App — Tauri Port Plan

Port the VS Code extension UI (chat + graph panels) into the Tauri desktop app,
reusing the existing compiled frontend assets (`chatWebview.js`, `graph.js`, CSS)
unchanged, with a Bun-compiled standalone host binary replacing the VS Code
extension host.

---

## Architecture

```
+-------------------------------------------------------+
|  Tauri App Window                                      |
|  +---------------------------------------------------+ |
|  | Frontend (Vite)                                    | |
|  | +------------+ +--------------------------------+ | |
|  | | Graph      | | Chat                           | | |
|  | | graph.js   | | chatWebview.js                 | | |
|  | | (unchanged)| | (unchanged IIFE)               | | |
|  | +------+-----+ +---------------+----------------+ | |
|  |        |  acquireVsCodeApi()   |                   | |
|  |        |  polyfill bridges     |                   | |
|  |        |  to sidecar stdin/out |                   | |
|  +--------+-----------------------+-------------------+ |
|           |   tauri-plugin-shell  |                     |
|           |   Command.sidecar()   |                     |
+-----------|----------- -----------|---------------------+
            |  JSON over stdin/stdout
   +--------v-----------------------v--------+
   |  eisen-host (Bun --compile binary)      |
   |  - ACPClient, Orchestrator, agents      |
   |  - vscode API shimmed to Node.js        |
   |  - Manages eisen-core proxy processes   |
   +---------------------+------------------+
                          |  spawns
             +-----------v-----------+
             | eisen-core observe    |
             | (existing Rust binary)|
             | wraps AI agents       |
             | streams TCP telemetry |
             +-----------------------+
```

### Why NOT a Rust-relay sidecar

The host binary is spawned by `tauri-plugin-shell`'s `Command.sidecar()` directly
from the frontend JS. This avoids:

- A useless relay layer in Rust (every message would pass through:
  frontend -> Rust invoke -> host stdin -> response -> Rust event -> frontend)
- Extra Rust IPC plumbing with zero logic added
- Complexity for no benefit

The Rust backend only provides: reading CLI args at launch, registering plugins,
and the Tauri window shell. Everything else runs in the frontend <-> host channel.

### Why Bun --compile for the host

- No Node.js or Bun runtime required on target machines
- Single self-contained binary per platform
- Cross-compilation: `bun build --compile --target bun-{platform}-{arch}`
- The extension host logic is pure TS/Node.js (no native modules)

---

## Phase 1 — Standalone Host Binary

**PHASE_SUMMARY**: Extract the extension's Node.js host logic (chat provider,
ACP client, orchestrator, agents, file search) into a standalone `app/host/`
project that communicates over stdin/stdout JSON instead of VS Code's webview
postMessage. Shim out the ~10 VS Code API calls used at runtime. Compile to a
self-contained binary with `bun build --compile`.

### Goal

Produce a binary `eisen-host` that:
- Accepts `--cwd <directory>` to set the workspace root
- Reads JSON commands from stdin (one per line)
- Writes JSON events to stdout (one per line)
- Manages agent processes, ACP sessions, the orchestrator, and TCP graph telemetry
- Requires no runtime dependencies on the host machine

### Files to create

```
app/host/
  package.json
  tsconfig.json
  src/
    index.ts           Entry point, stdin/stdout IPC loop
    vscode-shim.ts     Fake vscode module for runtime calls
    file-search.ts     fast-glob based file/directory search
```

### vscode-shim.ts — what it replaces

The extension source imports `vscode` everywhere, but at runtime only ~10 API
calls are actually invoked. The shim module exports a `vscode` object:

| VS Code API                          | Shim implementation                            |
| ------------------------------------ | ---------------------------------------------- |
| `workspace.workspaceFolders[0]`      | `{ uri: { fsPath: CWD } }` (from --cwd arg)   |
| `workspace.fs.readFile(uri)`         | `fs.readFile(uri.fsPath)`                      |
| `workspace.fs.writeFile(uri, data)`  | `fs.writeFile(uri.fsPath, data)`               |
| `workspace.textDocuments.find()`     | Returns `undefined`                            |
| `workspace.findFiles(glob, ex, max)` | Delegates to `file-search.ts`                  |
| `workspace.asRelativePath(uri)`      | `path.relative(cwd, uri.fsPath)`               |
| `workspace.onDidOpenTextDocument`    | Returns `{ dispose() {} }`                     |
| `workspace.openTextDocument(path)`   | No-op (no editor)                              |
| `env.clipboard.writeText(text)`      | No-op (copy forwarded to frontend as message)  |
| `window.showErrorMessage(msg)`       | `console.error(msg)`                           |
| `window.showTextDocument()`          | No-op (no editor)                              |
| `Uri.file(p)`                        | `{ fsPath: p, scheme: 'file' }`                |
| `Uri.joinPath(base, ...parts)`       | `{ fsPath: path.join(base.fsPath, ...parts) }` |
| `Range(line, col, line, col)`        | Plain object `{ start, end }`                  |
| `Memento` (globalState)              | JSON file in platform app data dir             |

### index.ts — IPC protocol

The host uses the exact same message types that already exist between `chat.ts`
and `chatMain.ts`. No new protocol invented.

**Inbound** (stdin, one JSON per line) — existing `WebviewMessage` types:
```
{ "type": "spawnAgent", "agentType": "claude-code" }
{ "type": "sendMessage", "text": "fix the bug", "contextChips": [...] }
{ "type": "switchInstance", "instanceKey": "cl1" }
{ "type": "closeInstance", "instanceKey": "cl1" }
{ "type": "selectMode", "modeId": "architect" }
{ "type": "selectModel", "modelId": "claude-3.5-sonnet" }
{ "type": "cancel" }
{ "type": "clearChat" }
{ "type": "newChat" }
{ "type": "connect" }
{ "type": "fileSearch", "query": "main" }
{ "type": "ready" }
```

**Outbound** (stdout, one JSON per line) — existing `ExtensionMessage` types
plus three new graph event types:
```
{ "type": "connectionState", "state": "connected" }
{ "type": "instanceList", "instances": [...], "currentInstanceKey": "cl1" }
{ "type": "streamChunk", "text": "Here is the fix..." }
{ "type": "streamStart" }
{ "type": "streamEnd", "stopReason": "end_turn", "html": "<p>...</p>" }
{ "type": "toolCallStart", "name": "Read", "toolCallId": "tc1", "kind": "read" }
{ "type": "toolCallComplete", "toolCallId": "tc1", ... }
{ "type": "agents", "agents": [...], "selected": "claude-code" }
{ "type": "sessionMetadata", "modes": {...}, "models": {...} }
{ "type": "fileSearchResults", "searchResults": [...] }
{ "type": "error", "text": "..." }
{ "type": "mergedSnapshot", ... }    // NEW: graph data from orchestrator
{ "type": "mergedDelta", ... }       // NEW: graph data from orchestrator
{ "type": "agentUpdate", ... }       // NEW: agent info for graph
{ "type": "openFile", "path": "...", "line": 42 }  // forwarded from graph clicks
```

`mergedSnapshot`, `mergedDelta`, and `agentUpdate` replace what
`GraphViewProvider.postToWebview()` would send. The frontend dispatches them
to the graph panel container.

### Structural changes to extension logic

The host does NOT import from `extension/src/` directly — it contains its own
copies of the relevant modules with these targeted changes:

1. Replace `this.view?.webview.postMessage(msg)` with
   `process.stdout.write(JSON.stringify(msg) + '\n')`

2. Replace `import * as vscode from 'vscode'` with
   `import * as vscode from './vscode-shim'` via esbuild alias

3. Wire orchestrator events (onMergedSnapshot, onMergedDelta, onAgentUpdate)
   to stdout instead of to a GraphViewProvider instance

4. Remove `resolveWebviewView()` — no webview to resolve; the stdin reader
   drives message dispatch directly

The ACP client, orchestrator, merge logic, processor, agents, bridge — all
copied verbatim. They have zero VS Code imports.

### Dependencies

```json
{
  "dependencies": {
    "@agentclientprotocol/sdk": "^0.14.1",
    "marked": "^17.0.1",
    "fast-glob": "^3.3.0"
  }
}
```

### Build targets

```sh
# Linux x64
bun build src/index.ts --compile --target bun-linux-x64 \
  --outfile ../src-tauri/bin/eisen-host-x86_64-unknown-linux-gnu

# macOS x64
bun build src/index.ts --compile --target bun-darwin-x64 \
  --outfile ../src-tauri/bin/eisen-host-x86_64-apple-darwin

# macOS ARM
bun build src/index.ts --compile --target bun-darwin-arm64 \
  --outfile ../src-tauri/bin/eisen-host-aarch64-apple-darwin

# Windows x64
bun build src/index.ts --compile --target bun-windows-x64 \
  --outfile ../src-tauri/bin/eisen-host-x86_64-pc-windows-msvc.exe
```

Binary names follow Tauri's `{name}-{target-triple}` convention required for
sidecar resolution.

---

## Phase 2 — Tauri Configuration

**PHASE_SUMMARY**: Configure the Tauri app to bundle the host binary as a
sidecar via `externalBin`, add the shell/dialog/store plugins (Rust crate +
JS package + capability permissions), and add a single Rust command to read
the --cwd CLI argument at launch so the frontend knows whether to show the
workspace selector.

### Goal

The Tauri app can spawn the host binary, communicate with it over stdin/stdout,
open directory picker dialogs, and persist recent workspaces to the platform
app data store.

### tauri.conf.json additions

```jsonc
{
  "bundle": {
    "externalBin": ["bin/eisen-host"]
    // Tauri appends target triple automatically when resolving the binary
  },
  "app": {
    "windows": [{
      "title": "Eisen",
      "width": 1200,
      "height": 800,
      "resizable": true,
      "fullscreen": false
    }]
  }
}
```

### Cargo.toml additions

```toml
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-store = "2"
```

### capabilities/default.json additions

```json
{
  "permissions": [
    "core:default",
    "shell:allow-execute",
    "shell:allow-stdin-write",
    "shell:default",
    "dialog:allow-open",
    "store:default"
  ]
}
```

### lib.rs changes

Register plugins and add one command to read the --cwd launch argument:

```rust
#[tauri::command]
fn get_launch_cwd() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == "--cwd")
        .map(|pair| pair[1].clone())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build())
        .invoke_handler(tauri::generate_handler![get_launch_cwd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### app/package.json additions

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2.10.1",
    "@tauri-apps/plugin-shell": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-store": "^2"
  }
}
```

---

## Phase 3 — Frontend

**PHASE_SUMMARY**: Rewrite the Vite scaffold (`index.html` + `src/main.ts`) to
host both the chat and graph panels side by side. The chat loads the existing
compiled `chatWebview.js` IIFE unchanged via an `acquireVsCodeApi()` polyfill
that bridges to the host sidecar stdin/stdout. The graph loads `graph.js`
unchanged via the same polyfill pattern. A workspace selector overlay handles
the no-cwd launch case. Recent workspaces are persisted via `tauri-plugin-store`.

### Goal

The app window shows a two-panel layout (graph left, chat right) and
communicates bidirectionally with the host binary. On launch without `--cwd`,
a workspace selector is shown with recent workspaces and a folder picker.

### Layout

```
+---------------------------------------------------+
|  Title bar / drag region                          |
+------------+--------------------------------------+
|            |                                      |
|  Graph     |  Chat                                |
|  panel     |  panel                               |
|  (~30%)    |  (chatWebview.js runs here)          |
|            |                                      |
+------------+--------------------------------------+
```

### acquireVsCodeApi polyfill

Defined in an inline `<script>` BEFORE `chatWebview.js` and `graph.js` load:

```js
window.acquireVsCodeApi = () => {
  let _state = JSON.parse(localStorage.getItem('eisen-webview-state') || 'null');
  return {
    postMessage(msg) {
      // main.ts listens for this and writes to host stdin
      window.dispatchEvent(new CustomEvent('eisen-to-host', { detail: msg }));
    },
    getState() { return _state; },
    setState(s) {
      _state = s;
      localStorage.setItem('eisen-webview-state', JSON.stringify(s));
      return s;
    }
  };
};
```

Both `chatWebview.js` and `graph.js` call `acquireVsCodeApi()` on load.
They receive host responses via `window.addEventListener('message', ...)` —
main.ts dispatches host stdout events as `window.postMessage(parsed, '*')`.

### src/main.ts responsibilities

1. **Read launch CWD**: `invoke('get_launch_cwd')` — if present, skip workspace
   selector and immediately spawn host.

2. **Workspace selector**: if no CWD, show overlay.
   - "Open Folder" button: `open({ directory: true })` from plugin-dialog
   - Recent workspaces: loaded from `Store.load('settings.json')` then
     `store.get('recentWorkspaces')` — persisted at platform app data dir:
     - Linux:   `~/.local/share/app.labs.eisen/settings.json`
     - macOS:   `~/Library/Application Support/app.labs.eisen/settings.json`
     - Windows: `%APPDATA%/app.labs.eisen/settings.json`
   - On selection: save to store (keep last 10), hide overlay, spawn host.

3. **Spawn host**: `Command.sidecar('bin/eisen-host', ['--cwd', cwd])`
   - stdout listener: parse each line as JSON, dispatch as
     `window.postMessage(parsed, '*')` so chatWebview.js and graph.js receive it
   - stderr listener: `console.error` for debugging

4. **Bridge outbound**: listen for `eisen-to-host` CustomEvent (from polyfill),
   write JSON line to sidecar stdin.

5. **Graph message routing**: messages typed `mergedSnapshot`, `mergedDelta`,
   `agentUpdate` from host stdout are forwarded to the graph panel.

6. **openFile**: when graph sends `{ type: "openFile", path, line }`, open
   the file with `@tauri-apps/plugin-opener` (or no-op for v1).

7. **copyToClipboard**: when host sends `{ type: "copyToClipboard", text }`,
   use `navigator.clipboard.writeText(text)` — restores the copy-message feature.

### Static assets

Copied into `app/public/` by the build script (not committed to git):

| Source                           | Destination             |
| -------------------------------- | ----------------------- |
| `extension/dist/chatWebview.js`  | `public/chatWebview.js` |
| `extension/src/styles/reset.css` | `public/reset.css`      |
| `extension/src/styles/vscode.css`| `public/vscode.css`     |
| `extension/src/styles/main.css`  | `public/main.css`       |
| `ui/dist/main.js`                | `public/graph.js`       |
| `ui/dist/style.css`              | `public/graph.css`      |

### CSS variable compatibility

`vscode.css` defines properties like `--vscode-editor-background` that only
exist inside VS Code. A `src/theme-defaults.css` file defines sensible dark
theme defaults for all referenced VS Code CSS variables. This is loaded before
`vscode.css` so the extension's overrides still apply inside VS Code, while the
app gets the defaults.

---

## Phase 4 — Build Integration

**PHASE_SUMMARY**: Wire up the monorepo build scripts so that a single command
builds everything in order: ui -> extension webview -> host binary -> copy assets
-> tauri build. Dev workflow builds the same way then runs `tauri dev` with Vite
hot reload for the main.ts frontend code.

### Goal

`pnpm app:build` produces a distributable Tauri app bundle for all platforms.
`pnpm app:dev` starts a dev workflow.

### Build order

```
1. pnpm -C ui build              → ui/dist/main.js, ui/dist/style.css
2. pnpm -C extension build       → extension/dist/chatWebview.js, media/*.css
3. node scripts/copy-assets.mjs  → copies assets into app/public/
4. bun build host binary         → app/src-tauri/bin/eisen-host-{triple}
5. cd app && bun run tauri build → compiles Rust + bundles everything
```

### scripts/copy-assets.mjs

New file at repo root:

```js
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('app/public', { recursive: true });
copyFileSync('extension/dist/chatWebview.js',   'app/public/chatWebview.js');
copyFileSync('extension/src/styles/reset.css',  'app/public/reset.css');
copyFileSync('extension/src/styles/vscode.css', 'app/public/vscode.css');
copyFileSync('extension/src/styles/main.css',   'app/public/main.css');
copyFileSync('ui/dist/main.js',                 'app/public/graph.js');
copyFileSync('ui/dist/style.css',               'app/public/graph.css');
```

### Root package.json script updates

```json
{
  "scripts": {
    "build:assets": "pnpm -C ui build && pnpm -C extension build && node scripts/copy-assets.mjs",
    "build:host": "cd app/host && bun build src/index.ts --compile --target bun-linux-x64 --outfile ../src-tauri/bin/eisen-host-x86_64-unknown-linux-gnu",
    "build:host:all": "cd app/host && bun build src/index.ts --compile --target bun-linux-x64 --outfile ../src-tauri/bin/eisen-host-x86_64-unknown-linux-gnu && bun build src/index.ts --compile --target bun-darwin-x64 --outfile ../src-tauri/bin/eisen-host-x86_64-apple-darwin && bun build src/index.ts --compile --target bun-darwin-arm64 --outfile ../src-tauri/bin/eisen-host-aarch64-apple-darwin && bun build src/index.ts --compile --target bun-windows-x64 --outfile ../src-tauri/bin/eisen-host-x86_64-pc-windows-msvc.exe",
    "app:dev": "pnpm run build:assets && pnpm run build:host && cd app && bun run tauri dev",
    "app:build": "pnpm run build:assets && pnpm run build:host:all && cd app && bun run tauri build"
  }
}
```

### .gitignore additions (app/)

```
public/chatWebview.js
public/graph.js
public/graph.css
public/reset.css
public/vscode.css
public/main.css
src-tauri/bin/
```

---

## Phase 5 — CLI Launch (`eisen .`)

**PHASE_SUMMARY**: Enable launching the app from the terminal with
`eisen <directory>` to open the app with a pre-set workspace. The Tauri Rust
backend reads `--cwd` from args (implemented in Phase 2), the frontend reads it
via `invoke('get_launch_cwd')` and skips the workspace selector. A wrapper shell
script is shipped alongside the bundle for PATH registration.

### Goal

`eisen .` or `eisen /path/to/project` opens the Tauri app with that directory
as the workspace, bypassing the workspace selector.

### Wrapper script (bin/eisen)

```sh
#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CWD="${1:-.}"
CWD="$(cd "$CWD" && pwd)"
exec "$SCRIPT_DIR/eisen-app" --cwd "$CWD"
```

Platform packaging:
- **Linux**: installed to `/usr/local/bin/eisen` via deb/rpm bundle config
- **macOS**: placed in `.app/Contents/MacOS/`, user adds parent dir to PATH
- **Windows**: `eisen.cmd` wrapper script

The Tauri `get_launch_cwd` command (Phase 2) is the only Rust change needed.
The CLI script is a packaging detail that can be refined post-MVP.

---

## File Change Summary

| File                                      | Action      | Notes                                     |
| ----------------------------------------- | ----------- | ----------------------------------------- |
| `app/host/package.json`                   | **Create**  | Bun project for the host bundle           |
| `app/host/tsconfig.json`                  | **Create**  | TS config for the host                    |
| `app/host/src/index.ts`                   | **Create**  | Entry point; stdin/stdout IPC loop        |
| `app/host/src/vscode-shim.ts`             | **Create**  | Shims for ~10 VS Code APIs                |
| `app/host/src/file-search.ts`             | **Create**  | fast-glob based file search               |
| `app/host/src/acp/` (copied)              | **Create**  | client.ts, agents.ts verbatim copies      |
| `app/host/src/orchestrator/` (copied)     | **Create**  | orchestrator.ts etc. verbatim copies      |
| `app/host/src/bridge.ts` (adapted)        | **Create**  | getCorePath without vscode.Uri            |
| `app/index.html`                          | **Rewrite** | Two-panel layout + workspace selector     |
| `app/src/main.ts`                         | **Rewrite** | Tauri event wiring + sidecar management   |
| `app/src/style.css`                       | **Rewrite** | App chrome styles (panels, selector)      |
| `app/src/theme-defaults.css`              | **Create**  | Dark theme defaults for vscode CSS vars   |
| `app/package.json`                        | **Edit**    | Add plugin JS dependencies                |
| `app/src-tauri/src/lib.rs`                | **Edit**    | ~20 lines: plugins + get_launch_cwd       |
| `app/src-tauri/Cargo.toml`                | **Edit**    | 3 plugin crate deps added                 |
| `app/src-tauri/tauri.conf.json`           | **Edit**    | externalBin, window size                  |
| `app/src-tauri/capabilities/default.json` | **Edit**    | Shell, dialog, store permissions          |
| `app/.gitignore`                          | **Edit**    | Exclude copied assets + bin/              |
| `scripts/copy-assets.mjs`                 | **Create**  | Copies extension/ui build output to app   |
| Root `package.json`                       | **Edit**    | Build scripts for app:dev, app:build      |
| `extension/` (all files)                  | **None**    | VS Code extension completely unmodified   |
| `ui/` (all files)                         | **None**    | Graph renderer completely unmodified      |
| `core/` (Rust crate)                      | **None**    | eisen-core binary completely unmodified   |

---

## Risks and Notes

1. **Bun --compile binary size**: Bun-compiled binaries include the Bun runtime
   (~50–90MB per binary). Acceptable for a desktop app.

2. **Graph message routing**: The graph UI (`graph.js`) uses `{ method, params }`
   shaped messages internally. The frontend `main.ts` translates the host's flat
   JSON (`mergedSnapshot`, `mergedDelta`, `agentUpdate`) into the format
   `GraphViewProvider.postToWebview` would have used.

3. **CSS variable compatibility**: `vscode.css` references VS Code theme
   variables that don't exist in the Tauri webview. `theme-defaults.css` sets
   sensible dark-theme defaults for all referenced variables.

4. **Clipboard**: The extension's copy-message feature calls
   `vscode.env.clipboard.writeText`. The host shim emits a `copyToClipboard`
   stdout message; the frontend handles it with `navigator.clipboard.writeText`.

5. **File search**: `fast-glob` replaces VS Code's file watcher-backed
   `findFiles`. First-search latency may be higher on very large repos.
   A `chokidar` watcher can be added later if needed.
