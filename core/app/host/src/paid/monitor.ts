import { Agent } from "@mastra/core/agent";
import { trace, signal } from "@paid-ai/paid-node";
import { getPaidClient } from "./client";

export interface PaidSignalData {
  eventName: string;
  customerId: string;
  productId: string;
  data?: Record<string, any>;
  idempotencyKey?: string;
}

export interface MonitoredAgentConfig {
  agent: Agent<any>;
  signalData: PaidSignalData;
}

export function createMonitoredAgent<T extends string>(
  agent: Agent<T>,
  signalData: PaidSignalData
): Agent<T> {
  const paidClient = getPaidClient();
  
  // If Paid is not configured, return the original agent
  if (!paidClient) {
    return agent;
  }

  // Create a wrapper that monitors the agent's generate calls
  const originalGenerate = agent.generate.bind(agent);
  
  const monitoredGenerate = async (...args: Parameters<typeof originalGenerate>) => {
    const startTime = Date.now();
    
    // Use Paid's trace function to wrap the agent execution
    return trace(
      {
        externalCustomerId: signalData.customerId,
        externalProductId: signalData.productId,
        storePrompt: false,
        metadata: {
          agentId: agent.id,
          agentName: agent.name,
          eventName: signalData.eventName,
        },
      },
      async () => {
        try {
          // Execute the original agent call
          const result = await originalGenerate(...args);
          
          const duration = Date.now() - startTime;
          
          // Send signal to Paid with cost tracing enabled
          signal(
            signalData.eventName,
            true, // enableCostTracing
            {
              ...signalData.data,
              agentId: agent.id,
              agentName: agent.name,
              duration,
              success: true,
            }
          );
          
          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          
          // Send failure signal to Paid
          signal(
            `${signalData.eventName}_error`,
            false, // don't track costs for errors
            {
              ...signalData.data,
              agentId: agent.id,
              agentName: agent.name,
              duration,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }
          );
          
          throw error;
        }
      }
    );
  };

  // Override the generate method
  (agent as any).generate = monitoredGenerate;
  
  return agent;
}
