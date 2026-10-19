import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo the supplied value", inputSchema: z.object({ value: z.string() }) },
  async ({ value }) => ({
    content: [{ type: "text", text: "echo:" + value }],
    structuredContent: { value },
  }),
);
await server.connect(new StdioServerTransport());
