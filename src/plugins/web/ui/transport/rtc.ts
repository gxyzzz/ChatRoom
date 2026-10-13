import { shallowRef } from "vue";
import {
  INITIAL_CREDIT,
  Op,
  creditFrame,
  decodeFrame,
  encodeFrame,
  metaFrame,
  parseMeta,
  readCredit,
} from "../../../cloud/v2/stream.js";

const STUN = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_ACTIVE = 32;
const SEND_BUFFER = 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;

interface Stream {
  port: MessagePort;
  body: Uint8Array;
  offset: number;
  credit: number;
  responseStarted: boolean;
  sentFin: boolean;
}

let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let trying: Promise<void> | null = null;
let enabled = false;
let suspended = false;
let nextId = 1;
let retryTimer: number | null = null;
let statsTimer: number | null = null;
const streams = new Map<number, Stream>();

function notifyTransportState(): void {
  navigator.serviceWorker.controller?.postMessage({
    type: "chatroom-v2-state",
    active: enabled && channel?.readyState === "open",
  });
}
export const rtcConnected = shallowRef(false);
export const rtcIceRoute = shallowRef<string | null>(null);

export function startRtc(): void {
  if (
    !("RTCPeerConnection" in window) ||
    !("serviceWorker" in navigator) ||
    (!window.isSecureContext && location.hostname !== "localhost")
  )
    return;
  if (enabled) return;
  enabled = true;
  suspended = false;
  navigator.serviceWorker.addEventListener("message", onRequest);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    notifyTransportState,
  );
  void navigator.serviceWorker
    .register("/transport-sw.js", {
      scope: "/",
      updateViaCache: "none",
    })
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      if (enabled) void connect();
    })
    .catch(() => {
      /* Browser may forbid service workers; regular HTTP remains available. */
    });
}

export function stopRtc(): void {
  enabled = false;
  suspended = true;
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("pageshow", onPageShow);
  notifyTransportState();
  navigator.serviceWorker.removeEventListener("message", onRequest);
  navigator.serviceWorker.removeEventListener(
    "controllerchange",
    notifyTransportState,
  );
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  close();
}

function onPageHide(): void {
  suspended = true;
  close();
}

function onPageShow(): void {
  suspended = false;
  if (enabled) void connect();
}

function close(): void {
  rtcConnected.value = false;
  notifyTransportState();
  rtcIceRoute.value = null;
  if (statsTimer !== null) clearInterval(statsTimer);
  statsTimer = null;
  for (const stream of streams.values()) {
    stream.port.postMessage({ type: "error" });
    stream.port.close();
  }
  streams.clear();
  channel?.close();
  peer?.close();
  channel = null;
  peer = null;
}

function retry(ms: number): void {
  if (!enabled || suspended) return;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void connect();
  }, ms);
}

async function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      done();
      reject(Error("ICE gathering timeout"));
    }, 8_000);
    const change = () => {
      if (pc.iceGatheringState === "complete") {
        done();
        resolve();
      }
    };
    const done = () => {
      clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", change);
    };
    pc.addEventListener("icegatheringstatechange", change);
  });
}

async function connect(): Promise<void> {
  if (!enabled || suspended || trying || channel?.readyState === "open") return;
  trying = (async () => {
    close();
    const pc = new RTCPeerConnection({ iceServers: STUN });
    peer = pc;
    const dc = pc.createDataChannel("chatroom-v2", { ordered: true });
    channel = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = 512 * 1024;
    dc.addEventListener("bufferedamountlow", () => pumpAll());
    dc.addEventListener("message", (event: MessageEvent<ArrayBuffer>) =>
      handleFrame(event.data),
    );
    dc.addEventListener("close", () => {
      if (channel === dc) {
        close();
        retry(20_000);
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (
        peer === pc &&
        ["closed", "failed", "disconnected"].includes(pc.connectionState)
      ) {
        close();
        retry(20_000);
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gathered(pc);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch("/api/rtc/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "offer", sdp: pc.localDescription?.sdp }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw Error("RTC signaling HTTP " + response.status);
    const answer = (await response.json()) as RTCSessionDescriptionInit;
    if (answer.type !== "answer" || typeof answer.sdp !== "string")
      throw Error("Invalid RTC answer");
    await pc.setRemoteDescription(answer);
    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === "open") {
        resolve();
        return;
      }
      const timeout = window.setTimeout(() => {
        done();
        reject(Error("DataChannel timeout"));
      }, 10_000);
      const onOpen = () => {
        done();
        resolve();
      };
      const onClose = () => {
        done();
        reject(Error("DataChannel closed"));
      };
      const done = () => {
        clearTimeout(timeout);
        dc.removeEventListener("open", onOpen);
        dc.removeEventListener("close", onClose);
      };
      dc.addEventListener("open", onOpen);
      dc.addEventListener("close", onClose);
    });
    if (!enabled || peer !== pc) throw Error("RTC stopped");
    rtcConnected.value = true;
    notifyTransportState();
    void inspectIceRoute(pc);
    statsTimer = window.setInterval(() => {
      notifyTransportState();
      void inspectIceRoute(pc);
    }, 5000);
  })()
    .catch(() => {
      close();
      retry(30_000);
    })
    .finally(() => {
      trying = null;
    });
  await trying;
}

function wireSend(frame: Uint8Array): void {
  if (channel?.readyState !== "open") throw Error("RTC disconnected");
  const buffer = new ArrayBuffer(frame.byteLength);
  new Uint8Array(buffer).set(frame);
  channel.send(buffer);
}

function onRequest(event: MessageEvent): void {
  if (event.data?.type !== "chatroom-v2-request" || !event.ports.length) return;
  const port = event.ports[0]!;
  const info = event.data as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: ArrayBuffer;
  };
  if (
    !enabled ||
    channel?.readyState !== "open" ||
    streams.size >= MAX_ACTIVE ||
    info.body.byteLength > MAX_UPLOAD
  ) {
    port.postMessage({ type: "declined" });
    port.close();
    return;
  }
  const id = nextId;
  nextId = nextId >= 0xffff_fffd ? 1 : nextId + 2;
  const stream: Stream = {
    port,
    body: new Uint8Array(info.body),
    offset: 0,
    credit: INITIAL_CREDIT,
    responseStarted: false,
    sentFin: false,
  };
  streams.set(id, stream);
  port.onmessage = (message: MessageEvent) => {
    if (!streams.has(id)) return;
    if (message.data?.type === "credit") {
      const size = message.data.bytes;
      if (Number.isInteger(size) && size > 0)
        try {
          wireSend(creditFrame(id, size));
        } catch {
          close();
        }
    } else if (message.data?.type === "cancel") {
      clearStream(id);
      try {
        wireSend(metaFrame(Op.RESET, id, { reason: "client_cancelled" }));
      } catch {
        close();
      }
    }
  };
  port.start();
  try {
    wireSend(
      metaFrame(Op.OPEN, id, {
        method: info.method,
        path: info.url,
        headers: info.headers,
      }),
    );
    port.postMessage({ type: "accepted" });
    pump(id);
  } catch {
    clearStream(id);
    close();
  }
}

function pumpAll(): void {
  for (const id of streams.keys()) pump(id);
}

function pump(id: number): void {
  const stream = streams.get(id);
  if (!stream || channel?.readyState !== "open") return;
  try {
    while (
      stream.credit > 0 &&
      stream.offset < stream.body.byteLength &&
      channel.bufferedAmount < SEND_BUFFER
    ) {
      const size = Math.min(
        CHUNK_SIZE,
        stream.credit,
        stream.body.length - stream.offset,
      );
      wireSend(
        encodeFrame(
          Op.DATA,
          id,
          stream.body.subarray(stream.offset, stream.offset + size),
        ),
      );
      stream.offset += size;
      stream.credit -= size;
    }
    if (stream.offset === stream.body.byteLength && !stream.sentFin) {
      stream.sentFin = true;
      wireSend(encodeFrame(Op.FIN, id));
    }
  } catch {
    close();
  }
}

function clearStream(id: number): void {
  const stream = streams.get(id);
  if (!stream) return;
  streams.delete(id);
  stream.port.close();
}

function handleFrame(raw: ArrayBuffer): void {
  try {
    const frame = decodeFrame(new Uint8Array(raw));
    const stream = streams.get(frame.id);
    if (!stream) return;
    switch (frame.op) {
      case Op.META: {
        if (stream.responseStarted) throw Error("Duplicate response metadata");
        const data = parseMeta<{
          status: number;
          headers: Record<string, string>;
        }>(frame.payload);
        stream.responseStarted = true;
        stream.port.postMessage({
          type: "meta",
          status: data.status,
          headers: data.headers,
        });
        break;
      }
      case Op.DATA: {
        if (!stream.responseStarted)
          throw Error("Response data before metadata");
        const bytes = frame.payload.slice().buffer;
        stream.port.postMessage({ type: "chunk", bytes }, [bytes]);
        break;
      }
      case Op.FIN:
        stream.port.postMessage({ type: "end" });
        clearStream(frame.id);
        break;
      case Op.RESET:
        stream.port.postMessage({ type: "error" });
        clearStream(frame.id);
        break;
      case Op.CREDIT:
        stream.credit += readCredit(frame.payload);
        if (stream.credit > INITIAL_CREDIT) throw Error("Invalid flow credit");
        pump(frame.id);
        break;
      default:
        throw Error("Unexpected RTC frame");
    }
  } catch {
    close();
  }
}

async function inspectIceRoute(pc: RTCPeerConnection): Promise<void> {
  if (pc !== peer || !rtcConnected.value) return;
  try {
    const stats = await pc.getStats();
    const pair = [...stats.values()].find(
      (item) =>
        item.type === "candidate-pair" &&
        item.state === "succeeded" &&
        item.nominated,
    );
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (local?.candidateType && remote?.candidateType)
      rtcIceRoute.value = `${local.candidateType} → ${remote.candidateType}`;
  } catch {
    /* Stats access can be restricted by the browser. */
  }
}
