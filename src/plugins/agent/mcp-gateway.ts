import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { CHATROOM_VERSION } from "#core/runtime/identity";

export interface AgentMcpConnection {
  url: string;
  token: string;
}

export class AgentMcpGateway {
  private server: Server | null = null;
  private readonly token = randomBytes(32).toString("base64url");
  private connectionValue: AgentMcpConnection | null = null;

  constructor(private readonly createServerForRequest: () => McpServer) {}

  connection(): AgentMcpConnection {
    if (!this.connectionValue)
      throw new Error("Agent MCP gateway has not started");
    return { ...this.connectionValue };
  }

  async start(): Promise<void> {
    if (this.server) return;
    const handler = createMcpHandler(() => this.createServerForRequest(), {
      legacy: "stateless",
      responseMode: "auto",
    });
    const nodeHandler = toNodeHandler(handler);
    const server = createServer((req, res) => {
      const host = req.headers.host;
      let hostName = "";
      try {
        hostName = new URL("http://" + (host ?? "")).hostname;
      } catch {
        /* reject below */
      }
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostName)) {
        res.writeHead(403).end();
        return;
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost = "";
        try {
          originHost = new URL(origin).hostname;
        } catch {
          /* reject below */
        }
        if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(originHost)) {
          res.writeHead(403).end();
          return;
        }
      }
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      const authorization = req.headers.authorization ?? "";
      if (authorization !== "Bearer " + this.token) {
        res
          .writeHead(401, {
            "WWW-Authenticate": "Bearer",
            "Cache-Control": "no-store",
          })
          .end();
        return;
      }
      void nodeHandler(
        req as unknown as Parameters<typeof nodeHandler>[0],
        res as Parameters<typeof nodeHandler>[1],
      );
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Agent MCP gateway did not bind a TCP port");
      this.connectionValue = {
        url: `http://127.0.0.1:${address.port}/mcp`,
        token: this.token,
      };
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.connectionValue = null;
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export function createAgentMcpServer(
  register: (server: McpServer) => void,
): McpServer {
  const server = new McpServer({
    name: "chatroom-agent-mcp",
    version: CHATROOM_VERSION,
  });
  register(server);
  return server;
}
