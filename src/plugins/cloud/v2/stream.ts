/** Tunnel V2 framing, independent of Node.js, WebSocket and WebRTC. */
export const V2_PROTOCOL = "chatroom-tunnel-v2";
export const DATA_SIZE = 16 * 1024;
export const INITIAL_CREDIT = 256 * 1024;
export const MAX_META = 64 * 1024;
export const MAX_QUEUED = 512 * 1024;

export const enum Op {
  OPEN = 1,
  META = 2,
  DATA = 3,
  FIN = 4,
  RESET = 5,
  CREDIT = 6,
}

export interface Frame {
  op: Op;
  id: number;
  payload: Uint8Array;
}

export function encodeFrame(
  op: Op,
  id: number,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  if (!Number.isSafeInteger(id) || id < 0 || id > 0xffff_ffff)
    throw new Error("Invalid stream ID");
  const frame = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, op);
  view.setUint32(1, id);
  frame.set(payload, 5);
  return frame;
}

export function decodeFrame(raw: Uint8Array): Frame {
  if (raw.byteLength < 5) throw new Error("Truncated V2 frame");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const op = view.getUint8(0) as Op;
  if (op < Op.OPEN || op > Op.CREDIT) throw new Error("Unknown V2 operation");
  const id = view.getUint32(1);
  const payload = raw.subarray(5);
  if (
    op === Op.DATA &&
    (payload.byteLength === 0 || payload.byteLength > DATA_SIZE)
  )
    throw new Error("Invalid DATA frame size");
  if (
    [Op.OPEN, Op.META, Op.RESET].includes(op) &&
    payload.byteLength > MAX_META
  )
    throw new Error("Metadata too large");
  if (
    op === Op.CREDIT &&
    (payload.byteLength !== 4 || readCredit(payload) === 0)
  )
    throw new Error("Invalid credit");
  if (op === Op.FIN && payload.byteLength !== 0)
    throw new Error("FIN must be empty");
  if (id === 0 && op !== Op.META) throw new Error("Reserved control stream");
  return { op, id, payload };
}

export function readCredit(payload: Uint8Array): number {
  return new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(0);
}

export function creditFrame(id: number, amount: number): Uint8Array {
  if (!Number.isInteger(amount) || amount < 1 || amount > 0xffff_ffff)
    throw new Error("Invalid credit amount");
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, amount);
  return encodeFrame(Op.CREDIT, id, payload);
}

export class CreditSender {
  private credit = INITIAL_CREDIT;
  private readonly chunks: Uint8Array[] = [];
  private queued = 0;
  private ending = false;
  private finished = false;
  private cancelled = false;
  private wakeup: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly id: number,
    private readonly send: (frame: Uint8Array) => void,
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly onFinished: () => void = () => {},
    private readonly canSend: () => boolean = () => true,
  ) {}

  enqueue(chunk: Uint8Array): void {
    if (
      this.cancelled ||
      this.finished ||
      this.ending ||
      this.queued + chunk.byteLength > MAX_QUEUED
    )
      throw new Error("V2 stream write overflow");
    this.chunks.push(chunk);
    this.queued += chunk.byteLength;
    this.flush();
  }

  addCredit(amount: number): void {
    if (this.finished || this.cancelled) return;
    if (this.credit + amount > INITIAL_CREDIT)
      throw new Error("Invalid V2 flow credit");
    this.credit += amount;
    this.flush();
  }

  end(): void {
    if (this.cancelled) return;
    this.ending = true;
    this.flush();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakeup = null;
    this.chunks.length = 0;
    this.queued = 0;
  }

  /** Called when the physical transport signals that its send buffer drained. */
  writable(): void {
    if (this.wakeup) {
      clearTimeout(this.wakeup);
      this.wakeup = null;
    }
    this.flush();
  }

  private flush(): void {
    if (this.cancelled) return;
    while (this.credit > 0 && this.chunks.length && this.canSend()) {
      const current = this.chunks[0]!;
      const length = Math.min(DATA_SIZE, this.credit, current.byteLength);
      this.send(encodeFrame(Op.DATA, this.id, current.subarray(0, length)));
      this.credit -= length;
      this.queued -= length;
      if (length === current.byteLength) this.chunks.shift();
      else this.chunks[0] = current.subarray(length);
    }
    if (this.chunks.length) {
      this.pause();
      if (this.credit && !this.canSend() && !this.wakeup) {
        this.wakeup = setTimeout(() => {
          this.wakeup = null;
          this.flush();
        }, 10);
      }
    } else {
      this.resume();
      if (this.ending && !this.finished) {
        this.finished = true;
        this.send(encodeFrame(Op.FIN, this.id));
        this.onFinished();
      }
    }
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function parseMeta<T>(payload: Uint8Array): T {
  return JSON.parse(decoder.decode(payload)) as T;
}

export function metaFrame(
  op: Op.OPEN | Op.META | Op.RESET,
  id: number,
  value: unknown,
): Uint8Array {
  const encoded = encoder.encode(JSON.stringify(value));
  if (encoded.byteLength > MAX_META) throw new Error("V2 metadata too large");
  return encodeFrame(op, id, encoded);
}
