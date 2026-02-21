import * as vscode from "vscode";
import { ensureAgentStatusLoaded } from "./acp/agents";
import { EisenOrchestrator } from "./orchestrator";
import { ChatViewProvider } from "./views/chat";
import { GraphViewProvider } from "./views/graph";

let chatProvider: ChatViewProvider | undefined;
let graphProvider: GraphViewProvider | undefined;
let orchestrator: EisenOrchestrator | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("Eisen extension is now active");

  // Kick off async agent availability detection early (non-blocking).
  // This replaces the previous execSync-based blocking probe.
  ensureAgentStatusLoaded().catch((e) => console.warn("[Eisen] Failed to probe agent availability:", e));

  // Create the orchestrator — aggregates N eisen-core TCP streams
  orchestrator = new EisenOrchestrator();

  // Create view providers
  graphProvider = new GraphViewProvider(context.extensionUri);
  chatProvider = new ChatViewProvider(context.extensionUri, context.globalState);

  // Wire: orchestrator -> graph
  orchestrator.onMergedSnapshot = (snapshot) => {
    graphProvider?.setSnapshot(snapshot);
  };
  orchestrator.onMergedDelta = (delta) => {
    graphProvider?.applyDelta(delta);
  };
  orchestrator.onAgentUpdate = (agents) => {
    graphProvider?.updateAgents(agents);
  };

  // Wire: chat agent lifecycle -> orchestrator
  // When any agent connects, register it with the orchestrator
  chatProvider.onDidConnect = async (client) => {
    const agentType = client.getAgentId();
    console.log(
      `[Eisen] onDidConnect fired for agent type="${agentType}", instanceId=${client.instanceId}, waiting for TCP port...`,
    );
    try {
      const port = await client.waitForTcpPort();
      const instanceId = client.instanceId;

      console.log(`[Eisen] TCP port resolved: port=${port}, instanceId=${instanceId}, agentType=${agentType}`);
      if (instanceId && agentType) {
        orchestrator?.addAgent(instanceId, port, agentType);
        console.log(
          `[Eisen] Registered agent with orchestrator: ${instanceId} on port ${port} (total agents: ${orchestrator?.agentCount})`,
        );
      } else {
        console.warn(`[Eisen] Cannot register agent — missing instanceId=${instanceId} or agentType=${agentType}`);
      }
    } catch (e) {
      console.error(`[Eisen] Failed to register agent "${agentType}" with orchestrator:`, e);
    }
  };

  // When any agent disconnects, remove it from the orchestrator
  chatProvider.onDidDisconnect = (instanceId) => {
    console.log(`[Eisen] onDidDisconnect fired for instanceId=${instanceId}, removing from orchestrator`);
    orchestrator?.removeAgent(instanceId);
    console.log(`[Eisen] Agent removed, remaining agents: ${orchestrator?.agentCount}`);
  };

  // When the active agent changes, register the new one if not already known
  chatProvider.onActiveClientChanged = async (client) => {
    if (!client) return;
    const agentType = client.getAgentId();
    console.log(
      `[Extension] Active agent changed to type="${agentType}", instanceId=${client.instanceId}, connected=${client.isConnected()}, tcpPort=${client.tcpPort}`,
    );

    // If this client is already connected and has a TCP port, register it
    if (client.isConnected() && client.tcpPort !== null) {
      const instanceId = client.instanceId;
      if (instanceId && agentType) {
        console.log(`[Extension] Re-registering already-connected agent: ${instanceId} on port ${client.tcpPort}`);
        orchestrator?.addAgent(instanceId, client.tcpPort, agentType);
      }
    }
  };

  const ensureConnected = async (): Promise<void> => {
    const client = chatProvider?.getActiveClient();
    if (!client) return;
    if (!client.isConnected()) {
      await client.connect();
    }
    // The onDidConnect callback will register with orchestrator
  };

  // Register both webview views in the eisen container
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphViewProvider.viewType, graphProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("eisen.startChat", async () => {
      try {
        await ensureConnected();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to connect: ${error}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("eisen.newChat", async () => {
      await chatProvider?.newChat();
      try {
        await ensureConnected();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to connect: ${error}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("eisen.openGraph", async () => {
      graphProvider?.openGraphPanel();
      try {
        await ensureConnected();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to connect: ${error}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("eisen.clearChat", () => {
      chatProvider?.clearChat();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("eisen.sendSelectionToChat", (editor: vscode.TextEditor) => {
      const selection = editor.selection;
      const document = editor.document;
      const chip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        filePath: document.uri.fsPath,
        fileName: require("node:path").basename(document.uri.fsPath),
        languageId: document.languageId,
        range: selection.isEmpty
          ? undefined
          : {
              startLine: selection.start.line + 1,
              endLine: selection.end.line + 1,
            },
      };
      chatProvider?.postChipToWebview(chip);
    }),
  );

  // Cleanup on deactivate
  context.subscriptions.push({
    dispose: () => {
      chatProvider?.dispose();
      graphProvider?.dispose();
      orchestrator?.dispose();
    },
  });
}

export function deactivate() {
  console.log("Eisen extension deactivating");
  chatProvider?.dispose();
  graphProvider?.dispose();
  orchestrator?.dispose();
}
