import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { AppDatabase } from "../../src/infrastructure/database/app-database.js";
import { CustomMcpRepository } from "../../src/infrastructure/database/custom-mcp-repository.js";
import { McpToolSettingsRepository } from "../../src/infrastructure/database/mcp-tool-settings-repository.js";
import { RuntimeEventBus } from "../../src/app/event-bus.js";
import { OperationRepository } from "../../src/infrastructure/database/operation-repository.js";
import { OperationLog } from "../../src/operations/operation-log.js";
import { CustomMcpManager } from "../../src/mcp/custom/manager.js";
import { McpToolControl } from "../../src/mcp/server/tool-control.js";

test("Custom MCP stdio tools can be discovered, invoked, disabled and persisted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-custom-mcp-"));
  const db = new AppDatabase(path.join(root, "app.sqlite"));
  const control = new McpToolControl(new McpToolSettingsRepository(db));
  const manager = new CustomMcpManager(
    new CustomMcpRepository(db),
    control,
    new OperationLog(new OperationRepository(db), new RuntimeEventBus(), 10240),
  );
  const fixture = fileURLToPath(
    new URL("../fixtures/custom-mcp-echo.mjs", import.meta.url),
  );
  try {
    const created = await manager.create({
      name: "Local echo",
      type: "stdio",
      command: process.execPath,
      args: [fixture],
      enabled: true,
      env: { SECRET_FIXTURE: "never-show-this" },
    });
    assert.equal(created.status, "connected", created.error ?? "");
    assert.equal(created.tools.length, 1);
    assert.deepEqual(created.envKeys, ["SECRET_FIXTURE"]);
    assert.equal(JSON.stringify(created).includes("never-show-this"), false);
    const fullName = created.tools[0]!.name;
    assert.equal(created.tools[0]?.enabled, false);
    control.setEnabled(fullName, true);

    const upstream = new McpServer({ name: "test-proxy", version: "1.0.0" });
    manager.registerMcp(upstream);
    const [left, right] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await Promise.all([upstream.connect(left), client.connect(right)]);
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === fullName));
      const reply = await client.callTool({
        name: fullName,
        arguments: { value: "works" },
      });
      assert.equal(reply.content[0]?.type, "text");
      assert.equal(reply.content[0]?.text, "echo:works");
      control.setEnabled(fullName, false);
      assert.ok(
        !(await client.listTools()).tools.some(
          (tool) => tool.name === fullName,
        ),
      );
      await assert.rejects(() =>
        client.callTool({ name: fullName, arguments: { value: "blocked" } }),
      );
      assert.equal(manager.list()[0]?.tools[0]?.enabled, false);
    } finally {
      await client.close();
      await upstream.close();
    }
    await manager.close();
    const reopened = new CustomMcpManager(
      new CustomMcpRepository(db),
      new McpToolControl(new McpToolSettingsRepository(db)),
      new OperationLog(
        new OperationRepository(db),
        new RuntimeEventBus(),
        10240,
      ),
    );
    try {
      assert.equal(reopened.list()[0]?.name, "Local echo");
      assert.equal(reopened.list()[0]?.status, "connecting");
      await reopened.remove(created.id);
      assert.equal(reopened.list().length, 0);
      assert.equal(
        db.raw
          .prepare(
            "SELECT COUNT(*) AS total FROM mcp_tool_settings WHERE tool_name GLOB ?",
          )
          .get("custom_" + created.id + "__*")?.total,
        0,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await manager.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Custom MCP Streamable HTTP uses private headers and forwards tools", async () => {
  const { createServer } = await import("node:http");
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const { z } = await import("zod");
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-http-mcp-"));
  const db = new AppDatabase(path.join(root, "app.sqlite"));
  const control = new McpToolControl(new McpToolSettingsRepository(db));
  const manager = new CustomMcpManager(
    new CustomMcpRepository(db),
    control,
    new OperationLog(new OperationRepository(db), new RuntimeEventBus(), 10240),
  );
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "remote-echo", version: "1.0.0" });
      server.registerTool(
        "remote_echo",
        { inputSchema: z.object({ value: z.string() }) },
        async ({ value }) => ({ content: [{ type: "text", text: value }] }),
      );
      return server;
    },
    { legacy: "stateless", responseMode: "auto" },
  );
  const nodeHandler = toNodeHandler(handler);
  const http = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer private-token") {
      res.writeHead(401).end();
      return;
    }
    void nodeHandler(req as Parameters<typeof nodeHandler>[0], res);
  });
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const addr = http.address();
    assert.ok(addr && typeof addr !== "string");
    const config = {
      name: "Remote echo",
      type: "http" as const,
      url: "http://127.0.0.1:" + addr.port + "/mcp",
      headers: { Authorization: "Bearer private-token" },
      enabled: true,
    };
    assert.equal((await manager.test(config)).tools, 1);
    const created = await manager.create(config);
    assert.equal(created.status, "connected", created.error ?? "");
    assert.deepEqual(created.headerKeys, ["Authorization"]);
    assert.equal(JSON.stringify(created).includes("private-token"), false);
    assert.equal(created.tools[0]?.enabled, false);
    control.setEnabled(created.tools[0]!.name, true);
    const upstream = new McpServer({ name: "http-gateway", version: "1.0.0" });
    manager.registerMcp(upstream);
    const [left, right] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "http-consumer", version: "1.0.0" });
    try {
      await Promise.all([upstream.connect(left), client.connect(right)]);
      const result = await client.callTool({
        name: created.tools[0]!.name,
        arguments: { value: "network" },
      });
      assert.equal(result.content[0]?.type, "text");
      if (result.content[0]?.type === "text")
        assert.equal(result.content[0].text, "network");
    } finally {
      await client.close();
      await upstream.close();
    }
    await manager.remove(created.id);
    assert.equal(
      control.list().filter((tool) => tool.pluginId === "custom-mcp").length,
      0,
    );
  } finally {
    await manager.close();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
