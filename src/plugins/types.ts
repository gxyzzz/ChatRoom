import type { ChatRoomConfig } from "#config/types";
import type { AppDatabase } from "#infrastructure/database/app-database";
import type { PluginMcpRegistrar } from "#mcp/server/plugin-mcp-registrar";
import type { OperationLog } from "#operations/operation-log";
import type { McpToolControl } from "#mcp/server/tool-control";
import type { CustomMcpManager } from "#mcp/custom/manager";
import type { RuntimeEventBus } from "#app/event-bus";
import type { ExternalAccessRegistry } from "#app/external-access-registry";
import type { LogWriter } from "#core/logging/types";

import type { ServiceRegistry } from "#app/service-registry";

export interface PluginContext {
  config: ChatRoomConfig;
  database: AppDatabase;
  operations: OperationLog;
  mcpTools: McpToolControl;
  customMcp: CustomMcpManager;
  events: RuntimeEventBus;
  externalAccess: ExternalAccessRegistry;
  services: ServiceRegistry;
  logs: LogWriter;
}

export interface InternalPlugin {
  id: string;
  activate(context: PluginContext): Promise<void> | void;
  registerMcp?(mcp: PluginMcpRegistrar): void;
  deactivate?(): Promise<void> | void;
}
