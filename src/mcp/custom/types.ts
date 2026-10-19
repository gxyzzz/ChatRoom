import type { Tool } from "@modelcontextprotocol/client";

export interface CustomMcpConfig {
  id: string;
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  authMode?: "auto" | "none" | "headers";
}

export interface CustomMcpServerSummary {
  id: string;
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  authMode?: "auto" | "none" | "headers";
  authorized?: boolean;
  status: "disabled" | "connecting" | "connected" | "auth_required" | "error";
  error: string | null;
  tools: Array<{
    name: string;
    title: string;
    description: string;
    enabled: boolean;
  }>;
}

export type DiscoveredMcpTool = Tool;

export interface CustomMcpStore {
  list(): CustomMcpConfig[];
  save(config: CustomMcpConfig): void;
  delete(id: string): void;
}
