import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { CustomMcpManager } from "#mcp/custom/manager";
import type { PluginManager } from "#plugins/plugin-manager";
import { CHATROOM_NAME, CHATROOM_VERSION } from "#core/runtime/identity";

export function createChatRoomMcpHandler(
  plugins: PluginManager,
  custom: CustomMcpManager,
): McpHttpHandler {
  return createMcpHandler(() => createServer(plugins, custom), {
    legacy: "stateless",
    responseMode: "auto",
  });
}

function createServer(
  plugins: PluginManager,
  custom: CustomMcpManager,
): McpServer {
  const server = new McpServer({
    name: CHATROOM_NAME,
    version: CHATROOM_VERSION,
  });
  plugins.registerMcp(server);
  custom.registerMcp(server);
  return server;
}
