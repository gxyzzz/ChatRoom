import type { AppDatabase } from "./app-database.js";
import type { McpToolSettingStore } from "#mcp/server/tool-control";

interface ToolSettingRow {
  tool_name: string;
}

interface ServerSettingRow {
  enabled: number;
}

export class AgentMcpSettingsRepository implements McpToolSettingStore {
  constructor(private readonly database: AppDatabase) {}

  disabledTools(): string[] {
    return (
      this.database.raw
        .prepare(
          "SELECT tool_name FROM agent_mcp_tool_settings WHERE enabled=0",
        )
        .all() as unknown as ToolSettingRow[]
    ).map((row) => row.tool_name);
  }

  configuredTools(): string[] {
    return (
      this.database.raw
        .prepare("SELECT tool_name FROM agent_mcp_tool_settings")
        .all() as unknown as ToolSettingRow[]
    ).map((row) => row.tool_name);
  }

  setEnabled(name: string, enabled: boolean): void {
    this.database.raw
      .prepare(
        `
        INSERT INTO agent_mcp_tool_settings(tool_name, enabled, updated_at)
        VALUES(?,?,?)
        ON CONFLICT(tool_name) DO UPDATE SET
          enabled=excluded.enabled,
          updated_at=excluded.updated_at
        `,
      )
      .run(name, enabled ? 1 : 0, new Date().toISOString());
  }

  serverEnabled(serverId: string): boolean {
    const row = this.database.raw
      .prepare(
        "SELECT enabled FROM agent_mcp_server_settings WHERE server_id=?",
      )
      .get(serverId) as ServerSettingRow | undefined;
    return row ? Boolean(row.enabled) : false;
  }

  setServerEnabled(serverId: string, enabled: boolean): void {
    this.database.raw
      .prepare(
        `
        INSERT INTO agent_mcp_server_settings(server_id, enabled, updated_at)
        VALUES(?,?,?)
        ON CONFLICT(server_id) DO UPDATE SET
          enabled=excluded.enabled,
          updated_at=excluded.updated_at
        `,
      )
      .run(serverId, enabled ? 1 : 0, new Date().toISOString());
  }

  deleteServerSetting(serverId: string): void {
    this.database.raw
      .prepare("DELETE FROM agent_mcp_server_settings WHERE server_id=?")
      .run(serverId);
    if (serverId.startsWith("custom:")) {
      const id = serverId.slice("custom:".length);
      this.database.raw
        .prepare("DELETE FROM agent_mcp_tool_settings WHERE tool_name GLOB ?")
        .run("custom_" + id + "__*");
    }
  }
}
