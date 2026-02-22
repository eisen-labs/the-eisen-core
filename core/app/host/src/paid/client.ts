import { PaidClient } from "@paid-ai/paid-node";
import { initializeTracing } from "@paid-ai/paid-node";

let paidClient: PaidClient | null = null;
let tracingInitialized = false;

/**
 * Initialize Paid tracing. Should be called once at application startup.
 * @returns true if tracing was initialized, false if PAID_API_KEY is not set
 */
export function initializePaidTracing(): boolean {
  if (tracingInitialized) {
    return true;
  }
  
  const token = process.env.PAID_API_KEY;
  if (!token) {
    console.warn("[Paid] PAID_API_KEY not set. Paid monitoring is disabled.");
    return false;
  }
  
  try {
    initializeTracing(token);
    tracingInitialized = true;
    console.log("[Paid] Tracing initialized successfully");
    return true;
  } catch (error) {
    console.warn("[Paid] Failed to initialize tracing:", error);
    return false;
  }
}

export function getPaidClient(): PaidClient | null {
  if (!paidClient) {
    const token = process.env.PAID_API_KEY;
    if (!token) {
      console.warn("[Paid] PAID_API_KEY not set. Paid monitoring is disabled.");
      return null;
    }
    
    // Initialize tracing before creating the client
    initializePaidTracing();
    
    paidClient = new PaidClient({ token });
  }
  return paidClient;
}

export function resetPaidClient(): void {
  paidClient = null;
  tracingInitialized = false;
}
