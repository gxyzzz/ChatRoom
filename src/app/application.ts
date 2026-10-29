import type { ChatRoomConfig } from "#config/types";
import { AppDatabase } from "#infrastructure/database/app-database";
import { OperationRepository } from "#infrastructure/database/operation-repository";
import { McpToolSettingsRepository } from "#infrastructure/database/mcp-tool-settings-repository";
import { AgentMcpSettingsRepository } from "#infrastructure/database/agent-mcp-settings-repository";
import { OAuthRepository } from "#infrastructure/database/oauth-repository";
import { PasskeyRepository } from "#infrastructure/database/passkey-repository";
import { WebSessionRepository } from "#infrastructure/database/web-session-repository";
import { RuntimeEventBus } from "./event-bus.js";
import { OperationLog } from "#operations/operation-log";
import { AuthService } from "#auth/auth-service";
import { PasskeyService } from "#auth/passkey-service";
import { ExternalAccessRegistry } from "./external-access-registry.js";
import { ServiceRegistry } from "#app/service-registry";
import { PluginManager } from "#plugins/plugin-manager";
import { createWorkspacePlugin } from "#plugins/workspace/plugin";
import { createGitPlugin } from "#plugins/git/plugin";
import {
  createProcessPlugin,
  ProcessServiceToken,
} from "#plugins/process/plugin";
import { createCloudPlugin, CloudServiceToken } from "#plugins/cloud/plugin";
import {
  createComputerPlugin,
  ComputerServiceToken,
} from "#plugins/computer/plugin";
import { createAgentPlugin } from "#plugins/agent/plugin";
import { createWebPlugin, WebServiceToken } from "#plugins/web/plugin";
import { createChatRoomMcpHandler } from "#mcp/server/create-mcp-server";
import { McpToolControl } from "#mcp/server/tool-control";
import { CustomMcpRepository } from "#infrastructure/database/custom-mcp-repository";
import { CustomMcpManager } from "#mcp/custom/manager";
import { AgentCustomMcpStore } from "#plugins/agent/custom-mcp-store";
import {
  AgentMcpGateway,
  createAgentMcpServer,
} from "#plugins/agent/mcp-gateway";
import { HttpServer } from "#infrastructure/http/http-server";
import type { LogService } from "#core/logging/types";

export interface ApplicationComponents {
  database: AppDatabase;
  eventBus: RuntimeEventBus;
  operations: OperationLog;
  plugins: PluginManager;
  customMcp: CustomMcpManager;
  agentCustomMcp: CustomMcpManager;
  agentMcpGateway: AgentMcpGateway;
  agentMcpTools: McpToolControl;
  processes: import("#plugins/process/process-supervisor").ProcessSupervisor;
  cloud: import("#plugins/cloud/controller").CloudController;
  computer: import("#plugins/computer/computer-service").ComputerService;
  http: HttpServer;
  logs: LogService;
}

export async function createApplication(
  config: ChatRoomConfig,
  logs: LogService,
): Promise<ApplicationComponents> {
  const database = new AppDatabase(config.databasePath);
  let gatewayForCleanup: AgentMcpGateway | null = null;
  let agentCustomMcpForCleanup: CustomMcpManager | null = null;
  let customMcpForCleanup: CustomMcpManager | null = null;
  let pluginsForCleanup: PluginManager | null = null;
  try {
    const eventBus = new RuntimeEventBus();
    const operations = new OperationLog(
      new OperationRepository(database),
      eventBus,
      config.operations.maxPayloadBytes,
    );
    operations.reconcileInterrupted();
    const mcpTools = new McpToolControl(
      new McpToolSettingsRepository(database),
    );
    const customMcp = new CustomMcpManager(
      new CustomMcpRepository(database),
      mcpTools,
      operations,
      config.dataDir,
    );
    customMcpForCleanup = customMcp;
    const agentMcpSettings = new AgentMcpSettingsRepository(database);
    const agentMcpTools = new McpToolControl(agentMcpSettings, false);
    const agentCustomMcp = new CustomMcpManager(
      new AgentCustomMcpStore(
        new CustomMcpRepository(database),
        agentMcpSettings,
      ),
      agentMcpTools,
      operations,
      config.dataDir,
      "agent_mcp",
    );
    agentCustomMcpForCleanup = agentCustomMcp;
    let plugins: PluginManager | null = null;
    const agentMcpGateway = new AgentMcpGateway(() =>
      createAgentMcpServer((server) => {
        if (!plugins) throw new Error("Agent MCP gateway is not initialized");
        plugins.registerMcp(server, agentMcpTools, { agentMode: true });
        agentCustomMcp.registerMcp(server);
      }),
    );
    await agentMcpGateway.start();
    gatewayForCleanup = agentMcpGateway;
    const externalAccess = new ExternalAccessRegistry(config.auth);
    const auth = new AuthService(
      new OAuthRepository(database),
      new WebSessionRepository(database),
      config.auth,
    );
    const passkeys = new PasskeyService(new PasskeyRepository(database));
    const services = new ServiceRegistry();
    plugins = new PluginManager(
      {
        config,
        database,
        operations,
        mcpTools,
        customMcp,
        agentMcp: agentMcpGateway.connection(),
        agentMcpTools,
        agentCustomMcp,
        events: eventBus,
        externalAccess,
        services,
        logs,
      },
      [
        createGitPlugin(),
        createWorkspacePlugin(),
        createProcessPlugin(),
        createComputerPlugin(),
        createCloudPlugin(),
        createAgentPlugin(),
        createWebPlugin(),
      ],
    );
    pluginsForCleanup = plugins;
    await plugins.start();
    plugins.defineMcp(agentMcpTools, { agentMode: true });
    customMcp.start();
    agentCustomMcp.start();
    const activePlugins = plugins;
    const web = services.require(WebServiceToken);
    const processes = services.require(ProcessServiceToken);
    const cloud = services.require(CloudServiceToken);
    const computer = services.require(ComputerServiceToken);
    const mcp = createChatRoomMcpHandler(activePlugins, customMcp);
    const http = new HttpServer(
      config,
      web.application,
      eventBus,
      auth,
      passkeys,
      mcp,
      externalAccess,
      cloud,
      logs,
    );
    return {
      database,
      eventBus,
      operations,
      plugins: activePlugins,
      customMcp,
      agentCustomMcp,
      agentMcpGateway,
      agentMcpTools,
      processes,
      cloud,
      computer,
      http,
      logs,
    };
  } catch (error) {
    // Startup can fail after the loopback gateway has bound its ephemeral port.
    // Tear down resources in reverse construction order before closing the DB.
    for (const cleanup of [
      () => pluginsForCleanup?.stop(),
      () => gatewayForCleanup?.close(),
      () => agentCustomMcpForCleanup?.close(),
      () => customMcpForCleanup?.close(),
    ]) {
      try {
        await cleanup();
      } catch {
        /* preserve the startup error */
      }
    }
    try {
      database.close();
    } catch {
      /* preserve the startup error */
    }
    throw error;
  }
}
