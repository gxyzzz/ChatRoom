import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppDatabase } from "../../src/infrastructure/database/app-database.js";
import { CustomMcpRepository } from "../../src/infrastructure/database/custom-mcp-repository.js";
import { McpToolSettingsRepository } from "../../src/infrastructure/database/mcp-tool-settings-repository.js";
import { CustomMcpManager } from "../../src/mcp/custom/manager.js";
import { McpToolControl } from "../../src/mcp/server/tool-control.js";
import { RuntimeEventBus } from "../../src/app/event-bus.js";
import { OperationLog } from "../../src/operations/operation-log.js";
import { OperationRepository } from "../../src/infrastructure/database/operation-repository.js";

test("Custom MCP OAuth completes PKCE callback, persists private tokens, and blocks replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-mcp-oauth-"));
  const db = new AppDatabase(path.join(root, "db.sqlite"));
  const manager = new CustomMcpManager(
    new CustomMcpRepository(db),
    new McpToolControl(new McpToolSettingsRepository(db)),
    new OperationLog(new OperationRepository(db), new RuntimeEventBus(), 10240),
    root,
  );
  let base = "";
  let registeredRedirect = "";
  let requestedVerifier = "";
  let requiredToken = "test-token";
  let refreshCount = 0;
  const mcpHandler = toNodeHandler(
    createMcpHandler(
      () => {
        const server = new McpServer({
          name: "oauth-upstream",
          version: "1.0.0",
        });
        server.registerTool(
          "ping_tool",
          { inputSchema: z.object({}) },
          async () => ({ content: [{ type: "text", text: "pong" }] }),
        );
        return server;
      },
      { legacy: "stateless", responseMode: "auto" },
    ),
  );
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (
      value: unknown,
      status = 200,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({
        resource: base + "/mcp",
        authorization_servers: [base],
        scopes_supported: ["mcp"],
      });
    } else if (
      url.pathname.startsWith("/.well-known/oauth-authorization-server")
    ) {
      json({
        issuer: base,
        authorization_endpoint: base + "/authorize",
        token_endpoint: base + "/token",
        registration_endpoint: base + "/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    } else if (url.pathname === "/register") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const data = JSON.parse(Buffer.concat(chunks).toString()) as {
        redirect_uris: string[];
      };
      registeredRedirect = data.redirect_uris[0] ?? "";
      json(
        {
          client_id: "test-client",
          redirect_uris: [registeredRedirect],
          grant_types: ["authorization_code", "refresh_token"],
        },
        201,
      );
    } else if (url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const input = new URLSearchParams(Buffer.concat(chunks).toString());
      requestedVerifier = input.get("code_verifier") ?? requestedVerifier;
      const refresh = input.get("grant_type") === "refresh_token";
      if (refresh) refreshCount++;
      json({
        access_token: refresh ? "refreshed-token" : "test-token",
        refresh_token: "test-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    } else if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer " + requiredToken) {
        json({ error: "unauthorized" }, 401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return;
      }
      void mcpHandler(req as Parameters<typeof mcpHandler>[0], res);
    } else {
      json({ error: "not_found" }, 404);
    }
  });
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const addr = http.address();
    assert.ok(addr && typeof addr !== "string");
    base = `http://127.0.0.1:${addr.port}`;
    // Testing before saving must detect the authentication requirement without
    // trying to read credentials using an invalid placeholder server ID.
    const preview = await manager.test({
      name: "OAuth preview",
      type: "http",
      url: base + "/mcp",
      authMode: "auto",
      enabled: true,
    });
    assert.deepEqual(preview, { tools: 0, authRequired: true });
    assert.deepEqual(manager.list(), []);
    assert.deepEqual(await readdir(path.join(root, "custom-mcp-oauth")), []);
    await assert.rejects(
      () =>
        manager.test({
          name: "Invalid API key",
          type: "http",
          url: base + "/mcp",
          authMode: "headers",
          headers: { Authorization: "Bearer invalid" },
          enabled: true,
        }),
      /unauthorized/i,
    );
    const created = await manager.create({
      name: "OAuth test",
      type: "http",
      url: base + "/mcp",
      authMode: "auto",
      enabled: true,
    });
    assert.equal(created.status, "auth_required", created.error ?? "");
    const callback = "http://localhost:8765/api/mcp/oauth/callback";
    const { authorizationUrl } = await manager.authorize(created.id, callback);
    const auth = new URL(authorizationUrl);
    assert.equal(auth.pathname, "/authorize");
    assert.equal(auth.searchParams.get("redirect_uri"), callback);
    assert.equal(registeredRedirect, callback);
    const state = auth.searchParams.get("state");
    assert.ok(state);
    await assert.rejects(() =>
      manager.completeAuthorization(
        new URLSearchParams({ state: "invalid", code: "fake" }),
      ),
    );
    const params = new URLSearchParams({ state, code: "test-code" });
    await manager.completeAuthorization(params);
    assert.ok(requestedVerifier.length >= 43);
    const connected = manager.list()[0]!;
    assert.equal(connected.status, "connected", connected.error ?? "");
    assert.equal(connected.tools.length, 1);
    assert.equal(connected.tools[0]?.enabled, false);
    assert.equal((await manager.testStored(created.id)).tools, 1);
    requiredToken = "refreshed-token";
    const refreshed = await manager.refresh(created.id);
    assert.equal(refreshed.status, "connected", refreshed.error ?? "");
    assert.ok(
      refreshCount > 0,
      "expired access token should refresh automatically",
    );
    const credFile = path.join(root, "custom-mcp-oauth", created.id + ".json");
    assert.equal((await stat(credFile)).mode & 0o777, 0o600);
    assert.ok((await readFile(credFile, "utf8")).includes("test-refresh"));
    assert.ok(!JSON.stringify(connected).includes("test-token"));
    await assert.rejects(() => manager.completeAuthorization(params));
    await manager.revokeAuthorization(created.id);
    assert.equal(manager.list()[0]?.status, "disabled");
    await assert.rejects(() => readFile(credFile));
  } finally {
    await manager.close();
    await new Promise<void>((resolve, reject) =>
      http.close((err) => (err ? reject(err) : resolve())),
    );
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
