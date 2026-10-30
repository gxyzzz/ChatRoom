import type { LogWriter } from "#core/logging/types";
import { LineProcess } from "#core/runtime/line-process";
import { CHATROOM_VERSION } from "#core/runtime/identity";

export type CodexRequestId = string | number;

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export interface CodexServerRequest extends CodexNotification {
  id: CodexRequestId;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface InitializeResult {
  userAgent: string;
}

export interface CodexMcpConnection {
  url: string;
  token: string;
}

export class CodexRpcClient {
  private process: LineProcess | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<
    (notification: CodexNotification) => void
  >();
  private readonly requestListeners = new Set<
    (request: CodexServerRequest) => void
  >();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private nextId = 1;
  private starting: Promise<InitializeResult> | null = null;
  private initialized: InitializeResult | null = null;

  constructor(
    private readonly logs: LogWriter,
    private readonly mcpConnection: CodexMcpConnection = {
      url: "http://127.0.0.1:1/mcp",
      token: "test-only-token",
    },
  ) {}

  async ensureStarted(): Promise<InitializeResult> {
    if (this.initialized) return this.initialized;
    if (!this.starting) this.starting = this.start();
    try {
      this.initialized = await this.starting;
      return this.initialized;
    } finally {
      this.starting = null;
    }
  }

  async request<T>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureStarted();
    return this.requestReady<T>(method, params, timeoutMs);
  }

  async reloadMcpConfiguration(): Promise<void> {
    // Before Codex starts, the MCP config passed on its command line will be
    // picked up by the initial connection; avoid spawning Codex just for UI toggles.
    if (!this.initialized) return;
    await this.requestReady("config/mcpServer/reload", {});
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: CodexRequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: CodexRequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onTransportClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    const process = this.process;
    if (!process) return;
    this.failTransport(process, new Error("Codex app-server closed"));
    process.terminate();
    await process.waitForExit(1500);
    process.forceKill();
  }

  private async start(): Promise<InitializeResult> {
    let process: LineProcess;
    process = new LineProcess({
      command: "codex",
      args: [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "mcp_servers.chatroom_agent.url=" +
          JSON.stringify(this.mcpConnection.url),
        "-c",
        'mcp_servers.chatroom_agent.bearer_token_env_var="CHATROOM_AGENT_MCP_TOKEN"',
      ],
      env: { CHATROOM_AGENT_MCP_TOKEN: this.mcpConnection.token },
      onStdout: (line) => this.handleLine(line),
      onStderr: (line) => {
        const message = line.trim();
        if (message)
          this.logs.debug(
            "agent.codex",
            "codex.stderr",
            message.slice(0, 4000),
          );
      },
      onExit: (code, signal) => {
        if (this.process !== process) return;
        this.failTransport(
          process,
          new Error(
            "Codex app-server exited" +
              (code === null ? "" : " with code " + code) +
              (signal ? " (" + signal + ")" : ""),
          ),
        );
      },
      onError: (error) => {
        if (this.process === process) this.failTransport(process, error);
      },
    });
    await process.spawned();
    this.process = process;

    try {
      const initialized = await this.requestReady<InitializeResult>(
        "initialize",
        {
          clientInfo: {
            name: "chatroom",
            title: "ChatRoom",
            version: CHATROOM_VERSION,
          },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      );
      this.notify("initialized");
      return initialized;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failTransport(process, failure);
      process.terminate();
      await process.waitForExit(500);
      process.forceKill();
      throw failure;
    }
  }

  private requestReady<T>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    this.requireProcess();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write(
          params === undefined ? { id, method } : { id, method, params },
        );
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private failTransport(process: LineProcess, error: Error): void {
    if (this.process !== process) return;
    this.process = null;
    this.initialized = null;
    this.starting = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.logs.warn(
        "agent.codex",
        "codex.invalid_json",
        "Codex app-server emitted invalid JSON",
        { line: line.slice(0, 1000) },
      );
      return;
    }
    if (!isRecord(message)) return;
    if ("method" in message && typeof message.method === "string") {
      const notification: CodexNotification = {
        method: message.method,
        ...("params" in message ? { params: message.params } : {}),
      };
      const params = isRecord(notification.params) ? notification.params : null;
      if (
        params &&
        (notification.method === "configWarning" ||
          notification.method === "deprecationNotice" ||
          (notification.method === "warning" && params.threadId === null))
      ) {
        const summary =
          notification.method === "warning" ? params.message : params.summary;
        if (typeof summary === "string")
          this.logs.warn(
            "agent.codex",
            "codex." + notification.method,
            [
              summary,
              typeof params.details === "string" ? params.details : null,
            ]
              .filter(Boolean)
              .join("\n"),
          );
      }
      if ("id" in message && isRequestId(message.id)) {
        const request: CodexServerRequest = {
          ...notification,
          id: message.id,
        };
        for (const listener of this.requestListeners) listener(request);
      } else {
        for (const listener of this.notificationListeners)
          listener(notification);
      }
      return;
    }
    if (!("id" in message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if ("error" in message && message.error) {
      pending.reject(new Error(rpcErrorMessage(message.error)));
      return;
    }
    pending.resolve("result" in message ? message.result : null);
  }

  private write(message: Record<string, unknown>): void {
    this.requireProcess().writeLine(JSON.stringify(message));
  }

  private requireProcess(): LineProcess {
    if (!this.process) throw new Error("Codex app-server is not running");
    return this.process;
  }
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === "string" || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rpcErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string")
    return value.message;
  return "Codex app-server request failed";
}
