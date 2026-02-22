import type { SessionNotification } from "@agentclientprotocol/sdk";

export interface OutboundMessage {
  type: string;
  [key: string]: unknown;
}

export function processSessionUpdate(
  notification: SessionNotification,
  opts: { streamingText: string; isActive: boolean; instanceId: string },
): { messages: OutboundMessage[]; streamingTextDelta: string } {
  const update = notification.update;
  const messages: OutboundMessage[] = [];
  let streamingTextDelta = "";

  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type === "text") {
      streamingTextDelta = update.content.text;
      messages.push({ type: "streamChunk", text: update.content.text, instanceId: opts.instanceId });
    }
  } else if (update.sessionUpdate === "tool_call") {
    messages.push({
      type: "toolCallStart",
      name: update.title,
      toolCallId: update.toolCallId,
      kind: update.kind,
      instanceId: opts.instanceId,
    });
  } else if (update.sessionUpdate === "tool_call_update") {
    if (update.status === "completed" || update.status === "failed") {
      let terminalOutput: string | undefined;
      if (update.content && update.content.length > 0) {
        const terminalContent = update.content.find((c: { type: string }) => c.type === "terminal");
        if (terminalContent && "terminalId" in terminalContent) {
          terminalOutput = `[Terminal: ${String(terminalContent.terminalId)}]`;
        }
      }
      messages.push({
        type: "toolCallComplete",
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        content: update.content,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        status: update.status,
        terminalOutput,
        instanceId: opts.instanceId,
      });
    }
  } else if (update.sessionUpdate === "current_mode_update") {
    if (opts.isActive) {
      messages.push({ type: "modeUpdate", modeId: update.currentModeId });
    }
  } else if (update.sessionUpdate === "available_commands_update") {
    if (opts.isActive) {
      messages.push({
        type: "availableCommands",
        commands: update.availableCommands,
      });
    }
  } else if (update.sessionUpdate === "plan") {
    if (opts.isActive) {
      messages.push({ type: "plan", plan: { entries: update.entries } });
    }
  } else if (update.sessionUpdate === "agent_thought_chunk") {
    if (update.content?.type === "text") {
      messages.push({ type: "thoughtChunk", text: update.content.text, instanceId: opts.instanceId });
    }
  } else if (update.sessionUpdate === "usage_update") {
    messages.push({
      type: "usageUpdate",
      used: update.used,
      size: update.size,
      cost: update.cost,
      instanceId: opts.instanceId,
    });
  }

  return { messages, streamingTextDelta };
}
