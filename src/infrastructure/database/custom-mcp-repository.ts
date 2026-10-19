import type { AppDatabase } from "./app-database.js";
import type { CustomMcpConfig } from "#mcp/custom/types";

interface ServerRow {
  id: string;
  name: string;
  config_json: string;
  enabled: number;
}

export class CustomMcpRepository {
  constructor(private readonly database: AppDatabase) {}

  list(): CustomMcpConfig[] {
    const rows = this.database.raw
      .prepare(
        "SELECT id, name, config_json, enabled FROM custom_mcp_servers ORDER BY created_at",
      )
      .all() as unknown as ServerRow[];
    return rows.map((row) => ({
      ...(JSON.parse(row.config_json) as CustomMcpConfig),
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
    }));
  }

  save(config: CustomMcpConfig): void {
    const now = new Date().toISOString();
    this.database.raw
      .prepare(
        `
      INSERT INTO custom_mcp_servers(id, name, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, config_json=excluded.config_json,
        enabled=excluded.enabled, updated_at=excluded.updated_at
    `,
      )
      .run(
        config.id,
        config.name,
        JSON.stringify(config),
        config.enabled ? 1 : 0,
        now,
        now,
      );
  }

  delete(id: string): void {
    this.database.raw
      .prepare("DELETE FROM mcp_tool_settings WHERE tool_name GLOB ?")
      .run("custom_" + id + "__*");
    this.database.raw
      .prepare("DELETE FROM custom_mcp_servers WHERE id=?")
      .run(id);
  }
}
