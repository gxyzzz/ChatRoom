import { randomUUID } from "node:crypto";
import http, { type ClientRequest } from "node:http";
import { Router } from "express";
import { z } from "zod";
import type { ChatRoomConfig } from "#config/types";
import {
  CreditSender,
  INITIAL_CREDIT,
  Op,
  creditFrame,
  decodeFrame,
  metaFrame,
  parseMeta,
  readCredit,
} from "#plugins/cloud/v2/stream";

const offerSchema = z
  .object({
    type: z.literal("offer"),
    sdp: z.string().min(1).max(64_000),
  })
  .strict();
const openSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().max(8192),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();
const STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const MAX_PEERS = 8;
const MAX_STREAMS = 32;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_IDLE_MS = 30 * 60 * 1000;
const HEADER_NAMES = new Set([
  "accept",
  "content-type",
  "range",
  "if-none-match",
  "if-modified-since",
  "x-chatroom-mime-type",
]);
const RESPONSE_HEADERS = new Set([
  "content-type",
  "content-disposition",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
]);

type Library = typeof import("node-datachannel");
type Peer = InstanceType<Library["PeerConnection"]>;
type Channel = ReturnType<Peer["createDataChannel"]>;

interface Stream {
  request: ClientRequest;
  sender: CreditSender | null;
  requestBytes: number;
  receiveCredit: number;
  consumed: number;
  drainArmed: boolean;
  ended: boolean;
}

/** V2 DataChannel HTTP transport. Cloud and self-hosting use the same HTTPS signaling API. */
export function createRtcApiRouter(config: ChatRoomConfig): Router {
  const router = Router();
  const peers = new Map<string, Peer>();

  router.post("/rtc/offer", async (req, res) => {
    const parsed = offerSchema.safeParse(req.body);
    if (
      !parsed.success ||
      !parsed.data.sdp.includes("m=application ") ||
      !parsed.data.sdp.includes("a=fingerprint:") ||
      !parsed.data.sdp.includes("a=ice-ufrag:")
    ) {
      res.status(400).json({ error: "invalid_offer" });
      return;
    }
    if (peers.size >= MAX_PEERS) {
      res.status(429).json({ error: "rtc_capacity" });
      return;
    }
    let library: Library;
    try {
      library = await import("node-datachannel");
    } catch {
      res.status(503).json({ error: "rtc_unavailable" });
      return;
    }

    const id = randomUUID();
    const pc = new library.PeerConnection(id, { iceServers: STUN });
    peers.set(id, pc);
    const streams = new Map<number, Stream>();
    let dc: Channel | null = null;
    let closed = false;
    const cookie = req.headers.cookie ?? "";
    const host = req.headers.host ?? "localhost";
    const origin = req.headers.origin ?? "";

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(expiry);
      for (const stream of streams.values()) {
        stream.sender?.cancel();
        stream.request.destroy();
      }
      streams.clear();
      peers.delete(id);
      try {
        dc?.close();
      } catch {
        /* connection already closed */
      }
      pc.close();
    };
    let expiry: NodeJS.Timeout;
    const activity = () => {
      clearTimeout(expiry);
      expiry = setTimeout(cleanup, MAX_IDLE_MS);
      expiry.unref();
    };
    activity();

    pc.onStateChange((state) => {
      if (state === "closed" || state === "failed") cleanup();
    });
    pc.onDataChannel((channel) => {
      if (closed || dc || channel.getLabel() !== "chatroom-v2") {
        channel.close();
        return;
      }
      dc = channel;
      channel.setBufferedAmountLowThreshold(512 * 1024);
      channel.onBufferedAmountLow(() => {
        for (const stream of streams.values()) stream.sender?.writable();
      });
      const send = (frame: Uint8Array) => {
        try {
          if (
            !channel.isOpen() ||
            channel.bufferedAmount() > 4 * 1024 * 1024 ||
            !channel.sendMessageBinary(Buffer.from(frame))
          ) {
            cleanup();
            return;
          }
          activity();
        } catch {
          cleanup();
        }
      };
      const abort = (streamId: number) => {
        const stream = streams.get(streamId);
        if (!stream) return;
        streams.delete(streamId);
        stream.sender?.cancel();
        stream.request.destroy();
      };
      const reset = (streamId: number, reason: string) => {
        if (!streams.has(streamId)) return;
        abort(streamId);
        send(metaFrame(Op.RESET, streamId, { reason }));
      };
      channel.onMessage((raw) => {
        if (closed || typeof raw === "string") {
          cleanup();
          return;
        }
        try {
          activity();
          const frame = decodeFrame(new Uint8Array(raw));
          if (!frame.id) throw Error("Reserved RTC control stream");
          if (frame.op === Op.OPEN) {
            if (streams.has(frame.id) || streams.size >= MAX_STREAMS) {
              reset(frame.id, "capacity");
              return;
            }
            const open = openSchema.parse(parseMeta<unknown>(frame.payload));
            if (
              !(
                open.path.startsWith("/api/") ||
                open.path.startsWith("/assets/")
              ) ||
              open.path.startsWith("/api/rtc/") ||
              (open.path.startsWith("/assets/") && open.method !== "GET") ||
              open.path.includes("#")
            ) {
              reset(frame.id, "invalid_path");
              return;
            }
            const headers: Record<string, string> = { host, cookie };
            if (origin) headers.origin = origin;
            for (const [name, value] of Object.entries(open.headers))
              if (HEADER_NAMES.has(name.toLowerCase()))
                headers[name.toLowerCase()] = value;

            const request = http.request(
              {
                host: ["0.0.0.0", "::"].includes(config.server.host)
                  ? "127.0.0.1"
                  : config.server.host,
                port: config.server.port,
                method: open.method,
                path: open.path,
                headers,
              },
              (response) => {
                const stream = streams.get(frame.id);
                if (!stream) {
                  response.destroy();
                  return;
                }
                const responseHeaders = Object.fromEntries(
                  Object.entries(response.headers).filter(
                    ([name, value]) =>
                      RESPONSE_HEADERS.has(name) && typeof value === "string",
                  ),
                );
                send(
                  metaFrame(Op.META, frame.id, {
                    status: response.statusCode ?? 502,
                    headers: responseHeaders,
                  }),
                );
                const writer = new CreditSender(
                  frame.id,
                  send,
                  () => response.pause(),
                  () => response.resume(),
                  () => {
                    streams.delete(frame.id);
                  },
                  () => channel.bufferedAmount() < 1024 * 1024,
                );
                stream.sender = writer;
                response.on("data", (chunk: Buffer) => {
                  if (!streams.has(frame.id)) return;
                  try {
                    writer.enqueue(chunk);
                  } catch {
                    reset(frame.id, "send_overflow");
                    response.destroy();
                  }
                });
                response.on("end", () => writer.end());
                response.on("error", () => reset(frame.id, "response_error"));
                response.on("close", () => {
                  if (!response.complete && streams.has(frame.id))
                    reset(frame.id, "response_disconnected");
                });
              },
            );
            const stream: Stream = {
              request,
              sender: null,
              requestBytes: 0,
              receiveCredit: INITIAL_CREDIT,
              consumed: 0,
              drainArmed: false,
              ended: false,
            };
            streams.set(frame.id, stream);
            request.on("error", () => {
              if (streams.has(frame.id)) reset(frame.id, "request_failed");
            });
          } else if (frame.op === Op.DATA) {
            const stream = streams.get(frame.id);
            if (!stream) return;
            stream.requestBytes += frame.payload.byteLength;
            stream.receiveCredit -= frame.payload.byteLength;
            if (
              stream.ended ||
              stream.requestBytes > MAX_UPLOAD ||
              stream.receiveCredit < 0
            ) {
              reset(frame.id, "request_limit");
              return;
            }
            if (stream.request.write(frame.payload)) {
              stream.receiveCredit += frame.payload.byteLength;
              send(creditFrame(frame.id, frame.payload.byteLength));
            } else {
              stream.consumed += frame.payload.byteLength;
              if (!stream.drainArmed) {
                stream.drainArmed = true;
                stream.request.once("drain", () => {
                  stream.drainArmed = false;
                  if (!streams.has(frame.id)) return;
                  stream.receiveCredit += stream.consumed;
                  send(creditFrame(frame.id, stream.consumed));
                  stream.consumed = 0;
                });
              }
            }
          } else if (frame.op === Op.FIN) {
            const stream = streams.get(frame.id);
            if (!stream || stream.ended) return;
            stream.ended = true;
            stream.request.end();
          } else if (frame.op === Op.CREDIT) {
            streams.get(frame.id)?.sender?.addCredit(readCredit(frame.payload));
          } else if (frame.op === Op.RESET) {
            abort(frame.id);
          } else throw Error("Unexpected RTC frame");
        } catch {
          cleanup();
        }
      });
      channel.onClosed(cleanup);
      channel.onError(cleanup);
    });
    try {
      const answer = await new Promise<{ type: "answer"; sdp: string }>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(Error("RTC answer timeout")),
            12_000,
          );
          const finish = () => {
            const description = pc.localDescription();
            if (!description || description.type !== "answer") return;
            clearTimeout(timeout);
            resolve({ type: "answer", sdp: description.sdp });
          };
          pc.onGatheringStateChange((state) => {
            if (state === "complete") finish();
          });
          pc.onLocalDescription(() => {
            if (pc.gatheringState() === "complete") finish();
          });
          pc.setRemoteDescription(parsed.data.sdp, "offer");
        },
      );
      if (closed) throw Error("RTC negotiation ended");
      res.json(answer);
    } catch {
      cleanup();
      if (!res.headersSent)
        res.status(503).json({ error: "rtc_negotiation_failed" });
    }
  });
  return router;
}
