import type { CustomMcpRepository } from "#infrastructure/database/custom-mcp-repository";
import type { AgentMcpSettingsRepository } from "#infrastructure/database/agent-mcp-settings-repository";
import type { CustomMcpConfig, CustomMcpStore } from "#mcp/custom/types";

/**
 * Shares server definitions and credentials with ChatRoom MCP, but owns the
 * Agent-specific enabled state. Updating an Agent toggle never changes the
 * enabled column in custom_mcp_servers.
 */
export class AgentCustomMcpStore implements CustomMcpStore {
  constructor(
    private readonly servers: CustomMcpRepository,
    private readonly settings: AgentMcpSettingsRepository,
  ) {}

  list(): CustomMcpConfig[] {
    return this.servers.list().map((server) => ({
      ...server,
      enabled: this.settings.serverEnabled(this.serverSettingId(server.id)),
    }));
  }

  save(config: CustomMcpConfig): void {
    const existing = this.servers
      .list()
      .find((server) => server.id === config.id);
    this.servers.save({
      ...config,
      // Keep the ChatRoom MCP preference independent from the Agent preference.
      enabled: existing?.enabled ?? false,
    });
    this.settings.setServerEnabled(
      this.serverSettingId(config.id),
      config.enabled,
    );
  }

  delete(id: string): void {
    // Agent settings may be cleared independently; the shared server definition
    // belongs to the ChatRoom MCP configuration and is never deleted here.
    this.settings.deleteServerSetting(this.serverSettingId(id));
  }

  private serverSettingId(id: string): string {
    return "custom:" + id;
  }
}
