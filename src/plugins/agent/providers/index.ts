import type { LogWriter } from "#core/logging/types";
import type { AgentProvider } from "../provider.js";
import { CodexProvider } from "./codex/provider.js";
import type { AgentMcpConnection } from "../mcp-gateway.js";

export function createAgentProviders(
  logs: LogWriter,
  mcpConnection: AgentMcpConnection = {
    url: "http://127.0.0.1:1/mcp",
    token: "test-only-token",
  },
): AgentProvider[] {
  return [new CodexProvider(logs, mcpConnection)];
}
