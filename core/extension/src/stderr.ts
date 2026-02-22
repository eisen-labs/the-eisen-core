export interface StderrEvent {
  type: "rateLimit" | "agentError";
  message: string;
}

export function parseStderrPatterns(stderrBuffer: string): {
  event: StderrEvent | null;
  clearBuffer: boolean;
  truncateBuffer: boolean;
} {
  const rateLimitMatch = stderrBuffer.match(/rate_limit_exceeded|Rate limit reached/i);
  if (rateLimitMatch) {
    const retryMatch = stderrBuffer.match(/try again in (\d+)s/i);
    const retryTime = retryMatch ? retryMatch[1] : "a few";
    return {
      event: {
        type: "rateLimit",
        message: `Rate limit exceeded. Please wait ${retryTime} seconds before sending another message.`,
      },
      clearBuffer: true,
      truncateBuffer: false,
    };
  }

  const errorMatch = stderrBuffer.match(/(\w+Error):\s*(\w+)?\s*\n?\s*data:\s*\{([^}]+)\}/);
  if (errorMatch) {
    const errorType = errorMatch[1];
    const errorData = errorMatch[3];
    const providerMatch = errorData.match(/providerID:\s*"([^"]+)"/);
    const modelMatch = errorData.match(/modelID:\s*"([^"]+)"/);
    let message = `Agent error: ${errorType}`;
    if (providerMatch && modelMatch) {
      message = `Model not found: ${providerMatch[1]}/${modelMatch[1]}`;
    }
    return {
      event: { type: "agentError", message },
      clearBuffer: true,
      truncateBuffer: false,
    };
  }

  return {
    event: null,
    clearBuffer: false,
    truncateBuffer: stderrBuffer.length > 10000,
  };
}
