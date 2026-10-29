import { randomBytes, randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type OAuthClientProvider,
  UnauthorizedError,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { ChatRoomError } from "#core/errors/chatroom-error";
import type { OperationLog } from "#operations/operation-log";
import type { McpToolControl } from "#mcp/server/tool-control";
import { CustomMcpOAuthProvider, CustomMcpOAuthStore } from "./oauth.js";
import type {
  CustomMcpConfig,
  CustomMcpServerSummary,
  DiscoveredMcpTool,
  CustomMcpStore,
} from "./types.js";

interface Entry {
  config: CustomMcpConfig;
  tools: DiscoveredMcpTool[];
  client: Client | null;
  status: CustomMcpServerSummary["status"];
  error: string | null;
  pending: Promise<void> | null;
  retry: ReturnType<typeof setTimeout> | null;
}
const CONNECT_TIMEOUT = 10000;
const TOOL_TIMEOUT = 60000;
async function withConnectTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MCP connection timed out")),
          CONNECT_TIMEOUT,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof SdkHttpError && error.status === 401)
  );
}

const toolId = (id: string, name: string) => "custom_" + id + "__" + name;

function validate(config: CustomMcpConfig): void {
  if (!config.name?.trim() || config.name.length > 100)
    throw new ChatRoomError("INVALID_INPUT", "Invalid MCP server name");
  if (config.type === "stdio") {
    if (!config.command?.trim())
      throw new ChatRoomError("INVALID_INPUT", "Missing executable");
    if (
      config.args &&
      (!Array.isArray(config.args) ||
        config.args.some((value) => typeof value !== "string"))
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "args must be an array of strings",
      );
  } else if (config.type === "http") {
    let url: URL;
    try {
      url = new URL(config.url ?? "");
    } catch {
      throw new ChatRoomError("INVALID_INPUT", "Invalid MCP URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new ChatRoomError("INVALID_INPUT", "Unsupported MCP URL");
  } else throw new ChatRoomError("INVALID_INPUT", "Unsupported MCP transport");
  for (const values of [config.env, config.headers]) {
    if (
      values &&
      (typeof values !== "object" ||
        Array.isArray(values) ||
        Object.entries(values).some(
          ([key, value]) => !key.trim() || typeof value !== "string",
        ))
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Environment variables and headers must be string maps",
      );
  }
}
function newEntry(config: CustomMcpConfig): Entry {
  return {
    config,
    tools: [],
    client: null,
    status: config.enabled ? "connecting" : "disabled",
    error: null,
    pending: null,
    retry: null,
  };
}
export class CustomMcpManager {
  private readonly oauth: CustomMcpOAuthStore | null;
  private readonly authorizationFlows = new Map<
    string,
    { id: string; expiresAt: number }
  >();
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(
    private readonly repository: CustomMcpStore,
    private readonly control: McpToolControl,
    private readonly operations: OperationLog,
    dataDir?: string,
    private readonly operationSource: "mcp" | "agent_mcp" = "mcp",
  ) {
    this.oauth = dataDir ? new CustomMcpOAuthStore(dataDir) : null;
    for (const config of repository.list())
      this.entries.set(config.id, newEntry(config));
  }
  start(): void {
    for (const entry of this.entries.values())
      if (entry.config.enabled) void this.connect(entry);
  }
  list(): CustomMcpServerSummary[] {
    this.syncRepository();
    return [...this.entries.values()].map((entry) => ({
      id: entry.config.id,
      name: entry.config.name,
      type: entry.config.type,
      ...(entry.config.command ? { command: entry.config.command } : {}),
      ...(entry.config.args ? { args: entry.config.args } : {}),
      ...(entry.config.cwd ? { cwd: entry.config.cwd } : {}),
      ...(entry.config.url ? { url: entry.config.url } : {}),
      envKeys: Object.keys(entry.config.env ?? {}),
      headerKeys: Object.keys(entry.config.headers ?? {}),
      enabled: entry.config.enabled,
      authMode: this.authMode(entry.config),
      authorized: Boolean(
        this.oauth &&
        entry.config.type === "http" &&
        this.oauth.load(entry.config.id).tokens,
      ),
      status: entry.status,
      error: entry.error,
      tools: entry.tools.map((tool) => ({
        name: toolId(entry.config.id, tool.name),
        title: tool.title ?? tool.name,
        description: tool.description ?? "",
        enabled: this.control.isEnabled(toolId(entry.config.id, tool.name)),
      })),
    }));
  }
  async create(
    input: Omit<CustomMcpConfig, "id">,
  ): Promise<CustomMcpServerSummary> {
    const config = { ...input, id: randomUUID().replaceAll("-", "") };
    validate(config);
    const entry = newEntry(config);
    this.repository.save(config);
    this.entries.set(config.id, entry);
    if (config.enabled) await this.connect(entry);
    return this.summary(config.id);
  }
  async update(
    id: string,
    input: Partial<Omit<CustomMcpConfig, "id">>,
  ): Promise<CustomMcpServerSummary> {
    const previous = this.require(id);
    const config = { ...previous.config, ...input, id };
    validate(config);
    const entry = newEntry(config);
    if (
      previous.config.url !== config.url ||
      previous.config.type !== config.type ||
      this.authMode(previous.config) !== this.authMode(config)
    ) {
      this.dropPendingAuthorization(id);
      this.oauth?.clear(id);
    }
    this.repository.save(config);
    this.entries.set(id, entry);
    await this.dispose(previous);
    if (config.enabled) await this.connect(entry);
    return this.summary(id);
  }
  async remove(id: string): Promise<void> {
    const entry = this.require(id);
    this.entries.delete(id);
    this.repository.delete(id);
    this.dropPendingAuthorization(id);
    this.oauth?.clear(id);
    await this.dispose(entry);
  }
  async refresh(id: string): Promise<CustomMcpServerSummary> {
    const entry = this.require(id);
    if (!entry.config.enabled)
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Enable the MCP server before refreshing",
      );
    return this.update(id, {});
  }
  async test(
    input: Omit<CustomMcpConfig, "id">,
  ): Promise<{ tools: number; authRequired?: boolean }> {
    // Test connections are ephemeral, but OAuthStore requires a valid server ID.
    // Never persist a temporary test entry or its credentials.
    const config = { ...input, id: randomUUID().replaceAll("-", "") };
    validate(config);
    return this.probe(config);
  }

  async testStored(
    id: string,
  ): Promise<{ tools: number; authRequired?: boolean }> {
    const entry = this.require(id);
    if (entry.status === "connected") return { tools: entry.tools.length };
    return this.probe(entry.config);
  }

  private async probe(
    config: CustomMcpConfig,
  ): Promise<{ tools: number; authRequired?: boolean }> {
    const client = new Client({ name: "chatroom-test", version: "1.0.0" });
    try {
      await withConnectTimeout(client.connect(this.transport(config)));
      const { tools } = await client.listTools(undefined, {
        timeout: CONNECT_TIMEOUT,
      });
      return { tools: tools.length };
    } catch (error) {
      if (
        config.type === "http" &&
        this.authMode(config) === "auto" &&
        isAuthenticationError(error)
      )
        return { tools: 0, authRequired: true };
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Start an interactive OAuth flow for an existing HTTP MCP server.
   * The callback state is single-use and never exposed to the browser.
   */
  async authorize(
    id: string,
    redirectUrl: string,
  ): Promise<{ authorizationUrl: string }> {
    const entry = this.require(id);
    if (
      entry.config.type !== "http" ||
      this.authMode(entry.config) !== "auto" ||
      !this.oauth
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "OAuth is only available for automatic HTTP MCP",
      );
    const redirect = new URL(redirectUrl);
    if (
      redirect.pathname !== "/api/mcp/oauth/callback" ||
      (redirect.protocol !== "https:" &&
        !(
          redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1", "::1"].includes(redirect.hostname)
        ))
    )
      throw new ChatRoomError("INVALID_INPUT", "Invalid OAuth callback URL");
    // A newer login invalidates earlier pending callbacks for the same server.
    this.dropPendingAuthorization(id);
    // Changing the callback URI requires fresh client registration.
    if (this.oauth.load(id).redirectUrl !== redirectUrl) this.oauth.clear(id);
    this.oauth.patch(id, { redirectUrl, tokens: undefined });
    const state = randomBytes(32).toString("base64url");
    const provider = new CustomMcpOAuthProvider(id, this.oauth, state);
    const client = new Client({ name: "chatroom-oauth", version: "1.0.0" });
    const transport = this.transport(entry.config, provider);
    try {
      await withConnectTimeout(client.connect(transport));
    } catch (error) {
      if (!provider.authorizationUrl) throw error;
      this.authorizationFlows.set(state, {
        id,
        expiresAt: Date.now() + 10 * 60_000,
      });
      entry.status = "auth_required";
      return { authorizationUrl: provider.authorizationUrl };
    } finally {
      await client.close().catch(() => undefined);
    }
    throw new ChatRoomError(
      "INVALID_INPUT",
      "This MCP server does not require OAuth",
    );
  }

  async completeAuthorization(query: URLSearchParams): Promise<void> {
    const state = query.get("state") ?? "";
    const pending = this.authorizationFlows.get(state);
    if (!pending || pending.expiresAt < Date.now())
      throw new ChatRoomError(
        "FORBIDDEN",
        "Invalid or expired MCP OAuth state",
      );
    this.authorizationFlows.delete(state);
    if (query.has("error"))
      throw new ChatRoomError("FORBIDDEN", "MCP authorization denied");
    const entry = this.require(pending.id);
    if (
      !this.oauth ||
      !query.get("code") ||
      this.authMode(entry.config) !== "auto"
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Invalid MCP authorization response",
      );
    const provider = new CustomMcpOAuthProvider(pending.id, this.oauth);
    const transport = this.transport(
      entry.config,
      provider,
    ) as StreamableHTTPClientTransport;
    try {
      await withConnectTimeout(transport.finishAuth(query));
      await this.update(pending.id, { enabled: true });
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async revokeAuthorization(id: string): Promise<void> {
    this.require(id);
    this.dropPendingAuthorization(id);
    this.oauth?.clear(id);
    await this.update(id, { enabled: false });
  }

  private dropPendingAuthorization(id: string): void {
    for (const [state, flow] of this.authorizationFlows)
      if (flow.id === id) this.authorizationFlows.delete(state);
  }

  private authMode(config: CustomMcpConfig): "auto" | "none" | "headers" {
    return (
      config.authMode ??
      (Object.keys(config.headers ?? {}).length ? "headers" : "auto")
    );
  }

  registerMcp(server: McpServer): void {
    this.syncRepository();
    for (const entry of this.entries.values()) {
      if (!entry.config.enabled || entry.status !== "connected") continue;
      for (const tool of entry.tools) {
        const name = toolId(entry.config.id, tool.name);
        const registered = server.registerTool(
          name,
          {
            title: tool.title ?? tool.name,
            description: tool.description ?? "",
            inputSchema: fromJsonSchema<Record<string, unknown>>(
              tool.inputSchema as Parameters<typeof fromJsonSchema>[0],
            ),
            ...(tool.outputSchema
              ? {
                  outputSchema: fromJsonSchema(
                    tool.outputSchema as Parameters<typeof fromJsonSchema>[0],
                  ),
                }
              : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          },
          async (args) => this.call(entry.config.id, tool.name, args),
        );
        this.control.attach(name, registered);
      }
    }
  }

  private async call(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const entry = this.entries.get(id);
    if (
      !entry?.config.enabled ||
      !entry.client ||
      entry.status !== "connected" ||
      !entry.tools.some((tool) => tool.name === name) ||
      !this.control.isEnabled(toolId(id, name))
    )
      throw new ChatRoomError("NOT_FOUND", "Custom MCP tool is unavailable");
    const client = entry.client;
    const operation = this.operations.start({
      pluginId: "custom-mcp",
      source: this.operationSource,
      action: entry.config.name + "/" + name,
      input: { serverId: id, toolName: name },
    });
    try {
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: TOOL_TIMEOUT },
      );
      this.operations.finish(
        operation.operationId,
        result.isError ? "error" : "success",
        {
          isError: Boolean(result.isError),
          contentItems: result.content?.length ?? 0,
        },
      );
      return result;
    } catch (error) {
      this.operations.finish(operation.operationId, "error", null, {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async connect(entry: Entry): Promise<void> {
    if (entry.pending) return entry.pending;
    if (!entry.config.enabled || this.closed) return;
    entry.status = "connecting";
    entry.error = null;
    const task = this.open(entry);
    entry.pending = task;
    try {
      await task;
    } finally {
      if (entry.pending === task) entry.pending = null;
    }
  }

  private async open(entry: Entry): Promise<void> {
    const client = new Client({ name: "chatroom-gateway", version: "1.0.0" });
    client.onclose = () => {
      if (
        this.entries.get(entry.config.id) !== entry ||
        entry.client !== client
      )
        return;
      entry.client = null;
      entry.status = "error";
      entry.error = "MCP connection closed";
      this.forgetTools(entry);
      this.scheduleRetry(entry);
    };
    try {
      const transport = this.transport(entry.config);
      await withConnectTimeout(client.connect(transport));
      const { tools } = await client.listTools(undefined, {
        timeout: CONNECT_TIMEOUT,
      });
      if (
        this.closed ||
        this.entries.get(entry.config.id) !== entry ||
        !entry.config.enabled
      )
        return;
      if (tools.length > 200)
        throw new Error("MCP server exposes too many tools (max 200)");
      entry.client = client;
      entry.tools = tools;
      entry.status = "connected";
      entry.error = null;
      for (const tool of tools) this.define(entry, tool);
      client.setNotificationHandler("notifications/tools/list_changed", () => {
        if (this.entries.get(entry.config.id) === entry)
          void this.refreshTools(entry).catch(() => undefined);
      });
    } catch (error) {
      if (this.entries.get(entry.config.id) === entry && !this.closed) {
        const needsAuth =
          this.authMode(entry.config) === "auto" &&
          entry.config.type === "http" &&
          isAuthenticationError(error);
        entry.status = needsAuth ? "auth_required" : "error";
        entry.error = needsAuth
          ? null
          : error instanceof Error
            ? error.message
            : String(error);
        if (!needsAuth) this.scheduleRetry(entry);
      }
    } finally {
      if (entry.client !== client) await client.close().catch(() => undefined);
    }
  }
  private define(entry: Entry, tool: DiscoveredMcpTool): void {
    this.control.define({
      name: toolId(entry.config.id, tool.name),
      pluginId: "custom-mcp",
      title: tool.title ?? tool.name,
      description: tool.description ?? "",
      defaultEnabled: false,
    });
  }

  private async refreshTools(entry: Entry): Promise<void> {
    if (!entry.client) return;
    const { tools } = await entry.client.listTools(undefined, {
      timeout: CONNECT_TIMEOUT,
    });
    if (
      this.entries.get(entry.config.id) !== entry ||
      !entry.client ||
      tools.length > 200
    )
      return;
    this.forgetTools(entry);
    entry.tools = tools;
    for (const tool of tools) this.define(entry, tool);
  }

  private transport(config: CustomMcpConfig, provider?: OAuthClientProvider) {
    if (config.type === "stdio")
      return new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        ...(config.cwd ? { cwd: config.cwd } : {}),
        env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
        stderr: "ignore",
      });
    const oauth =
      provider ??
      (this.oauth &&
      this.authMode(config) === "auto" &&
      this.oauth.load(config.id).tokens
        ? new CustomMcpOAuthProvider(config.id, this.oauth)
        : undefined);
    return new StreamableHTTPClientTransport(new URL(config.url!), {
      ...(oauth ? { authProvider: oauth } : {}),
      requestInit: {
        headers:
          this.authMode(config) === "headers" ? (config.headers ?? {}) : {},
        redirect: "error",
      },
    });
  }

  private scheduleRetry(entry: Entry): void {
    if (entry.retry || !entry.config.enabled || this.closed) return;
    entry.retry = setTimeout(() => {
      entry.retry = null;
      if (this.entries.get(entry.config.id) === entry) void this.connect(entry);
    }, 15000);
    entry.retry.unref();
  }

  private forgetTools(entry: Entry): void {
    for (const tool of entry.tools)
      this.control.undefine(toolId(entry.config.id, tool.name));
    entry.tools = [];
  }

  private async disconnect(entry: Entry): Promise<void> {
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = null;
    this.forgetTools(entry);
    const client = entry.client;
    entry.client = null;
    if (client) await client.close().catch(() => undefined);
  }

  private async dispose(entry: Entry): Promise<void> {
    entry.config.enabled = false;
    await this.disconnect(entry);
  }

  private syncRepository(): void {
    if (this.closed) return;
    const configs = this.repository.list();
    const ids = new Set(configs.map((config) => config.id));
    for (const [id, previous] of this.entries) {
      if (ids.has(id)) continue;
      this.entries.delete(id);
      this.repository.delete(id);
      void this.dispose(previous);
    }
    for (const config of configs) {
      const existing = this.entries.get(config.id);
      if (!existing) {
        const entry = newEntry(config);
        this.entries.set(config.id, entry);
        if (config.enabled) void this.connect(entry);
        continue;
      }
      if (JSON.stringify(existing.config) === JSON.stringify(config)) continue;
      const replacement = newEntry(config);
      this.entries.set(config.id, replacement);
      void this.dispose(existing).then(() => {
        if (config.enabled && this.entries.get(config.id) === replacement)
          return this.connect(replacement);
      });
    }
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry)
      throw new ChatRoomError("NOT_FOUND", "Custom MCP server not found");
    return entry;
  }

  private summary(id: string): CustomMcpServerSummary {
    const value = this.list().find((item) => item.id === id);
    if (!value)
      throw new ChatRoomError("NOT_FOUND", "Custom MCP server not found");
    return value;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.entries.values()].map((entry) => this.dispose(entry)),
    );
  }
}
