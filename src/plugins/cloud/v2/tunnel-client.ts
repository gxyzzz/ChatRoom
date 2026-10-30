import { createPrivateKey, sign } from "node:crypto";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import WebSocket from "ws";
import { z } from "zod";
import {
  CreditSender,
  INITIAL_CREDIT,
  Op,
  creditFrame,
  decodeFrame,
  metaFrame,
  parseMeta,
  readCredit,
  V2_PROTOCOL,
} from "./stream.js";
import {
  cloudServiceForPublicService,
  type CloudLeaseState,
  type PublicService,
} from "../types.js";

const openSchema = z
  .object({
    service: z.enum(["mcp", "web"]),
    method: z.string().min(1),
    path: z.string().startsWith("/"),
    headers: z.record(z.string(), z.string()),
  })
  .strict();
const controlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: z.string().min(1) }).strict(),
  z.object({ type: z.literal("ready") }).strict(),
]);
interface HttpStream {
  request: ClientRequest;
  response: IncomingMessage | null;
  sender: CreditSender | null;
  receiveCredit: number;
  pendingCredit: number;
  drainArmed: boolean;
  requestBytes: number;
  requestEnded: boolean;
  responseEnded: boolean;
}
export class V2TunnelClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private failureReported = false;
  private stopped = true;
  private attempts = 0;
  private closeWhenIdle: "stop" | "reconnect" | null = null;
  private acceptingServices: Set<CloudLeaseState["services"][number]>;
  private readonly streams = new Map<number, HttpStream>();

  constructor(
    private lease: CloudLeaseState,
    private readonly identity: { devicePrivateKey: string },
    private readonly local: { host: string; port: number },
    private readonly callbacks: {
      onConnected(): void;
      onDisconnected(): void;
      onLeaseRejected(): void;
      onError(error: Error): void;
    },
  ) {
    this.acceptingServices = new Set(lease.services);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.closeWhenIdle = null;
    this.acceptingServices = new Set(this.lease.services);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.closeWhenIdle = null;
    this.acceptingServices.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.destroyStreams();
  }

  drainAndStop(): void {
    this.stopped = true;
    this.acceptingServices.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearTimers();
    if (!this.streams.size) this.socket?.close();
    else this.closeWhenIdle = "stop";
  }

  updateLease(lease: CloudLeaseState): void {
    const changed = lease.tunnelUrl !== this.lease.tunnelUrl;
    const removes = this.lease.services.some(
      (service) => !lease.services.includes(service),
    );
    this.lease = lease;
    this.acceptingServices = new Set(lease.services);
    if (this.stopped) return;
    if (!changed) {
      this.send(
        metaFrame(Op.META, 0, { type: "update-lease", lease: lease.token }),
      );
      return;
    }
    if (!removes || !this.streams.size) this.socket?.close();
    else this.closeWhenIdle = "reconnect";
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.failureReported = false;
    const socket = new WebSocket(this.lease.tunnelUrl, V2_PROTOCOL);
    this.socket = socket;
    let ready = false;
    this.readyTimer = setTimeout(
      () => this.fail(socket, new Error("V2 handshake timed out")),
      10000,
    );
    this.readyTimer.unref();
    socket.on("unexpected-response", (_request, response) => {
      const error =
        response.statusCode === 426
          ? new Error(
              "Cloud Server does not support Tunnel V2; upgrade the server",
            )
          : new Error("Tunnel V2 handshake rejected: " + response.statusCode);
      response.resume();
      this.fail(socket, error);
    });
    socket.on("open", () => {
      if (socket.protocol !== V2_PROTOCOL)
        this.fail(socket, new Error("Unexpected V2 subprotocol"));
    });
    socket.on("message", (raw, binary) => {
      try {
        if (socket !== this.socket) return;
        if (ready) {
          if (!binary) throw new Error("V2 requires binary frames");
          this.handleFrame(toBuffer(raw));
          return;
        }
        if (binary) throw new Error("Unexpected binary handshake");
        const message = controlSchema.parse(
          JSON.parse(raw.toString()) as unknown,
        );
        if (message.type === "challenge") {
          socket.send(
            JSON.stringify({
              type: "authenticate",
              lease: this.lease.token,
              signature: signChallenge(
                message.nonce,
                this.lease.token,
                this.identity.devicePrivateKey,
              ),
            }),
          );
        } else {
          ready = true;
          this.attempts = 0;
          this.clearReadyTimer();
          this.startHeartbeat(socket);
          this.callbacks.onConnected();
        }
      } catch (error) {
        this.callbacks.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
        socket.close(4002, "Invalid V2 message");
      }
    });
    socket.on("pong", () => {
      if (this.socket === socket) this.awaitingPong = false;
    });
    socket.on("close", (code) => {
      if (this.socket !== socket) return;
      this.clearTimers();
      this.socket = null;
      this.closeWhenIdle = null;
      this.destroyStreams();
      this.callbacks.onDisconnected();
      if (this.stopped) return;
      if (code === 4003) {
        this.stopped = true;
        this.callbacks.onLeaseRejected();
        return;
      }
      this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      this.fail(socket, error);
    });
  }

  private handleFrame(raw: Buffer): void {
    const frame = decodeFrame(raw);
    if (!frame.id) throw new Error("Invalid server control frame");
    if (frame.op === Op.OPEN) {
      const meta = openSchema.parse(parseMeta<unknown>(frame.payload));
      if (this.streams.has(frame.id)) throw new Error("Duplicate stream");
      if (
        this.streams.size >= 256 ||
        !this.acceptingServices.has(
          cloudServiceForPublicService(meta.service),
        ) ||
        !allowedPath(meta.service, meta.path)
      ) {
        this.send(metaFrame(Op.RESET, frame.id, { reason: "not_allowed" }));
        return;
      }
      const headers = {
        ...meta.headers,
        host: publicHost(this.lease, meta.service),
      };
      const request = http.request(
        {
          host: this.local.host,
          port: this.local.port,
          method: meta.method,
          path: meta.path,
          headers,
        },
        (response) => {
          const state = this.streams.get(frame.id);
          if (!state) {
            response.destroy();
            return;
          }
          state.response = response;
          const sender = new CreditSender(
            frame.id,
            (buffer) => this.send(buffer),
            () => response.pause(),
            () => response.resume(),
            () => {
              state.responseEnded = true;
              this.finishIfIdle(frame.id);
            },
            () => (this.socket?.bufferedAmount ?? 0) < 1024 * 1024,
          );
          state.sender = sender;
          this.send(
            metaFrame(Op.META, frame.id, {
              status: response.statusCode ?? 502,
              headers: responseHeaders(response.headers),
            }),
          );
          response.on("data", (chunk: Buffer) => {
            try {
              sender.enqueue(chunk);
            } catch {
              this.abort(frame.id);
            }
          });
          response.on("end", () => {
            sender.end();
            this.finishIfIdle(frame.id);
          });
          response.on("error", () => this.abort(frame.id));
        },
      );
      const state: HttpStream = {
        request,
        response: null,
        sender: null,
        receiveCredit: INITIAL_CREDIT,
        pendingCredit: 0,
        drainArmed: false,
        requestBytes: 0,
        requestEnded: false,
        responseEnded: false,
      };
      this.streams.set(frame.id, state);
      request.on("error", () => {
        if (this.streams.has(frame.id)) this.abort(frame.id);
      });
      return;
    }
    const state = this.streams.get(frame.id);
    if (!state) return;
    switch (frame.op) {
      case Op.DATA: {
        state.receiveCredit -= frame.payload.length;
        state.requestBytes += frame.payload.length;
        if (state.receiveCredit < 0 || state.requestBytes > 32 * 1024 * 1024) {
          this.abort(frame.id);
          return;
        }
        if (state.request.write(frame.payload))
          this.refund(frame.id, state, frame.payload.length);
        else {
          state.pendingCredit += frame.payload.length;
          if (!state.drainArmed) {
            state.drainArmed = true;
            state.request.once("drain", () => {
              state.drainArmed = false;
              if (!this.streams.has(frame.id)) return;
              this.refund(frame.id, state, state.pendingCredit);
              state.pendingCredit = 0;
            });
          }
        }
        break;
      }
      case Op.FIN:
        state.request.end();
        state.requestEnded = true;
        this.finishIfIdle(frame.id);
        break;
      case Op.RESET:
        state.sender?.cancel();
        state.request.destroy();
        state.response?.destroy();
        this.streams.delete(frame.id);
        this.checkDrain();
        break;
      case Op.CREDIT:
        state.sender?.addCredit(readCredit(frame.payload));
        break;
      default:
        throw new Error("Unexpected V2 operation");
    }
  }

  private refund(id: number, state: HttpStream, amount: number): void {
    if (!amount) return;
    state.receiveCredit += amount;
    this.send(creditFrame(id, amount));
  }

  private finishIfIdle(id: number): void {
    const state = this.streams.get(id);
    if (!state || !state.requestEnded || !state.responseEnded) return;
    this.streams.delete(id);
    this.checkDrain();
  }

  private abort(id: number): void {
    const state = this.streams.get(id);
    if (!state) return;
    this.streams.delete(id);
    state.sender?.cancel();
    state.request.destroy();
    state.response?.destroy();
    this.send(metaFrame(Op.RESET, id, { reason: "local_failure" }));
    this.checkDrain();
  }

  private send(buffer: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 8 * 1024 * 1024) {
      this.socket.terminate();
      return;
    }
    this.socket.send(buffer, { binary: true });
  }

  private checkDrain(): void {
    if (this.streams.size || !this.closeWhenIdle) return;
    this.socket?.close();
  }

  private destroyStreams(): void {
    for (const state of this.streams.values()) {
      state.sender?.cancel();
      state.request.destroy();
      state.response?.destroy();
    }
    this.streams.clear();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
  private clearTimers(): void {
    this.clearReadyTimer();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.awaitingPong = false;
  }
  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN)
        return;
      if (this.awaitingPong) {
        this.fail(socket, new Error("V2 heartbeat timed out"));
        return;
      }
      this.awaitingPong = true;
      socket.ping();
    }, 20000);
    this.heartbeatTimer.unref();
  }
  private fail(socket: WebSocket, error: Error): void {
    if (this.socket !== socket || this.failureReported) return;
    this.failureReported = true;
    this.callbacks.onError(error);
    this.clearTimers();
    socket.terminate();
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay =
      Math.min(30000, 500 * 2 ** Math.min(this.attempts++, 6)) *
      (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
}

function toBuffer(raw: WebSocket.RawData): Buffer {
  return Buffer.isBuffer(raw)
    ? raw
    : Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.from(raw);
}
function signChallenge(
  nonce: string,
  lease: string,
  privateKey: string,
): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return sign(
    null,
    Buffer.from(`${V2_PROTOCOL}\n${nonce}\n${lease}`),
    key,
  ).toString("base64url");
}
function publicHost(lease: CloudLeaseState, service: PublicService): string {
  const base = service === "mcp" ? lease.mcpBaseUrl : lease.webBaseUrl;
  if (!base) throw new Error("Missing public URL");
  return new URL(base).host;
}
function allowedPath(service: PublicService, path: string): boolean {
  const p = new URL(path, "http://localhost").pathname.toLowerCase();
  const mcp = p === "/mcp" || p.startsWith("/mcp/");
  const oauth = p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-");
  return service === "mcp" ? mcp || oauth : !mcp && !oauth;
}
function responseHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
  ]);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(
        ([key, value]) =>
          value !== undefined && !blocked.has(key.toLowerCase()),
      )
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(", ") : String(value),
      ]),
  );
}
