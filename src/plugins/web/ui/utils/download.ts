import { shallowRef } from "vue";
import { rtcConnected, waitForRtcReady } from "../transport/rtc.js";

const CLOSE_DELAY = 4000;

type DownloadPhase = "transferring" | "finished" | "started" | "failed";
type DownloadMode = "p2p" | "http";

export interface DownloadProgress {
  name: string;
  received: number;
  total: number | null;
  speed: number;
  mode: DownloadMode;
  phase: DownloadPhase;
  error: string | null;
}

export const downloadProgress = shallowRef<DownloadProgress | null>(null);

let active: AbortController | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function dismissDownload(): void {
  if (active) return;
  downloadProgress.value = null;
  if (dismissTimer) clearTimeout(dismissTimer);
}

export function cancelDownload(): void {
  active?.abort();
}

function showProgress(value: DownloadProgress): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  downloadProgress.value = value;
  if (value.phase !== "transferring") {
    dismissTimer = setTimeout(() => {
      if (!active) downloadProgress.value = null;
    }, CLOSE_DELAY);
  }
}

function nativeDownload(url: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  nativeDownload(url, name);
  // Keep the Blob alive long enough for the browser's download manager to start.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Marker understood only by the Service Worker; no server behavior changes. */
function httpDownloadUrl(url: string): string {
  const target = new URL(url, window.location.origin);
  if (target.pathname.startsWith("/api/workspace/file/"))
    target.searchParams.set("__chatroom_http", "1");
  return target.pathname + target.search + target.hash;
}

/** Save already-resident content without involving a transport. */
export function downloadContent(blob: Blob, name: string): void {
  saveBlob(blob, name);
}

type SavePicker = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<FileSystemFileHandle>;
};

export class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Download failed (HTTP ${status})`);
    this.name = "DownloadHttpError";
  }
}

interface FileTransferResult {
  mode: DownloadMode;
  total: number | null;
  received: number;
}

async function writeResponseToFile(
  response: Response,
  file: FileSystemFileHandle,
  signal: AbortSignal,
  onStart: (mode: DownloadMode, total: number | null) => void,
  onProgress: (received: number) => void,
): Promise<FileTransferResult> {
  if (!response.ok) throw new DownloadHttpError(response.status);

  const mode: DownloadMode =
    response.headers.get("x-chatroom-transport") === "p2p" ? "p2p" : "http";
  const sizeHeader = response.headers.get("content-length");
  const total =
    sizeHeader !== null && /^\d+$/.test(sizeHeader) ? Number(sizeHeader) : null;
  onStart(mode, total);
  if (!response.body)
    throw new Error("The browser does not support streaming responses");

  const reader = response.body.getReader();
  let writable: FileSystemWritableFileStream | null = null;
  let received = 0;
  let committed = false;
  try {
    writable = await file.createWritable();
    while (true) {
      if (signal.aborted)
        throw new DOMException("Download canceled", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (total !== null && received > total)
        throw new Error("Downloaded file exceeds the declared length");
      await writable.write(value);
      onProgress(received);
    }
    if (total !== null && received !== total)
      throw new Error("Downloaded file length does not match the response");
    await writable.close();
    committed = true;
  } finally {
    if (!committed) {
      await reader.cancel().catch(() => {});
      await writable?.abort().catch(() => {});
    }
    reader.releaseLock();
  }
  return { mode, total, received };
}

/**
 * One download entry point for Workspace, Agent and shared links.
 * The Service Worker decides P2P vs HTTP; this module only chooses the
 * browser's supported save mechanism; no whole-file buffering is necessary.
 */
export async function downloadFile(
  url: string,
  name: string,
  options: { waitForP2pMs?: number } = {},
): Promise<void> {
  if (active) return;
  const controller = new AbortController();
  active = controller;
  const startedAt = performance.now();
  let received = 0;
  let lastUpdate = 0;
  let mode: DownloadMode = "http";
  let total: number | null = null;
  let attemptedP2p = false;
  let file: FileSystemFileHandle | null = null;

  function progress(phase: DownloadPhase, error: string | null = null): void {
    const now = performance.now();
    if (phase === "transferring" && now - lastUpdate < 150 && lastUpdate)
      return;
    lastUpdate = now;
    showProgress({
      name,
      received,
      total,
      mode,
      phase,
      error,
      speed: received / Math.max((now - startedAt) / 1000, 0.001),
    });
  }

  progress("transferring");
  try {
    // Must be invoked synchronously from the user gesture, before fetch().
    const picker = (window as SavePicker).showSaveFilePicker;
    if (picker) {
      try {
        file = await picker.call(window, { suggestedName: name });
      } catch (cause) {
        if ((cause as Error)?.name === "AbortError") return;
        // Browsers may expose an API that isn't usable in the current context.
        if (
          (cause as Error)?.name !== "SecurityError" &&
          (cause as Error)?.name !== "NotAllowedError" &&
          (cause as Error)?.name !== "TypeError"
        )
          throw cause;
      }
    }

    // Allow an in-progress handshake to finish, after the file picker has
    // received the original user gesture. Never postpone downloads indefinitely.
    if (options.waitForP2pMs) {
      await waitForRtcReady(options.waitForP2pMs, controller.signal);
      if (controller.signal.aborted) return;
    }
    // Freeze the decision for this download. A connection established moments
    // later should not silently reroute an HTTP fallback to P2P.
    const readyForP2p =
      rtcConnected.value && Boolean(navigator.serviceWorker?.controller);
    attemptedP2p = readyForP2p;
    const requestUrl = readyForP2p ? url : httpDownloadUrl(url);

    if (!file) {
      // A same-origin Service Worker supplies the browser's native download
      // manager with a streaming P2P response, without buffering in the page.
      if (readyForP2p) {
        try {
          const saved = await browserStreamDownload(
            requestUrl,
            name,
            controller.signal,
            (event) => {
              if (event.mode) mode = event.mode;
              if (event.total !== undefined) total = event.total;
              if (event.received !== undefined) received = event.received;
              progress(event.phase);
            },
          );
          if (saved) return;
        } catch (cause) {
          if (
            controller.signal.aborted ||
            (cause as Error)?.name === "AbortError" ||
            cause instanceof DownloadHttpError
          )
            throw cause;
          // A native download cannot resume a broken P2P stream. Start a new
          // HTTP download from byte zero instead of leaving a partial file.
        }
      }
      mode = "http";
      received = 0;
      total = null;
      lastUpdate = 0;
      nativeDownload(httpDownloadUrl(url), name);
      progress("started");
      return;
    }

    const response = await fetch(requestUrl, {
      signal: controller.signal,
      cache: "no-store",
    });
    const result = await writeResponseToFile(
      response,
      file,
      controller.signal,
      (nextMode, nextTotal) => {
        mode = nextMode;
        total = nextTotal;
        received = 0;
      },
      (nextReceived) => {
        received = nextReceived;
        progress("transferring");
      },
    );
    mode = result.mode;
    total = result.total;
    received = result.received;
    progress("finished");
  } catch (cause) {
    if (controller.signal.aborted || (cause as Error)?.name === "AbortError")
      return;
    if (file && attemptedP2p && !(cause instanceof DownloadHttpError)) {
      try {
        mode = "http";
        received = 0;
        total = null;
        lastUpdate = 0;
        progress("transferring");
        const response = await fetch(httpDownloadUrl(url), {
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await writeResponseToFile(
          response,
          file,
          controller.signal,
          (nextMode, nextTotal) => {
            mode = nextMode;
            total = nextTotal;
            received = 0;
          },
          (nextReceived) => {
            received = nextReceived;
            progress("transferring");
          },
        );
        mode = result.mode;
        total = result.total;
        received = result.received;
        progress("finished");
        return;
      } catch (fallbackCause) {
        if (
          controller.signal.aborted ||
          (fallbackCause as Error)?.name === "AbortError"
        )
          return;
        progress(
          "failed",
          fallbackCause instanceof Error
            ? fallbackCause.message
            : String(fallbackCause),
        );
        throw fallbackCause;
      }
    }
    progress("failed", cause instanceof Error ? cause.message : String(cause));
    throw cause;
  } finally {
    active = null;
    if (downloadProgress.value?.phase === "transferring")
      downloadProgress.value = null;
  }
}

interface StreamEvent {
  phase: DownloadPhase;
  mode?: DownloadMode;
  total?: number | null;
  received?: number;
}

/**
 * A browser-native download is a navigation, not a normal fetch(). Register
 * a one-time URL in the controlling Service Worker and stream the V2 response
 * straight into the browser's own download manager.
 */
async function browserStreamDownload(
  url: string,
  name: string,
  signal: AbortSignal,
  report: (event: StreamEvent) => void,
): Promise<boolean> {
  const worker = navigator.serviceWorker.controller;
  if (!worker) return false;
  const id = crypto.randomUUID();
  const bridge = new MessageChannel();
  const port = bridge.port1;
  let accepted = false;
  let finished = false;
  let ready: (value: boolean) => void = () => {};
  let complete: () => void = () => {};
  let fail: (reason: Error) => void = () => {};
  const registration = new Promise<boolean>((resolve) => {
    ready = resolve;
  });
  const transfer = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  // This promise can reject before navigation starts, so attach a handler now.
  void transfer.catch(() => {});
  const stop = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    port.close();
  };
  const timeout = () => {
    if (!accepted) ready(false);
    else fail(new Error("The download stopped responding"));
    stop();
  };
  let timer = setTimeout(timeout, 15000);
  const keepAlive = () => {
    clearTimeout(timer);
    timer = setTimeout(timeout, 60000);
  };
  const abort = () => {
    if (accepted) port.postMessage({ type: "cancel" });
    fail(new DOMException("Download canceled", "AbortError"));
    stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  port.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (finished) return;
    if (data?.type === "ready") {
      accepted = true;
      ready(true);
    } else if (data?.type === "unavailable") {
      ready(false);
      if (accepted) fail(new Error("Native download unavailable"));
      stop();
    } else if (data?.type === "started") {
      keepAlive();
      const length = data.total;
      report({
        phase: "transferring",
        mode: data.mode === "p2p" ? "p2p" : "http",
        total:
          typeof length === "string" && /^\d+$/.test(length)
            ? Number(length)
            : null,
      });
    } else if (data?.type === "progress") {
      keepAlive();
      report({ phase: "transferring", received: data.bytes });
    } else if (data?.type === "finished") {
      report({ phase: "finished", received: data.bytes });
      complete();
      stop();
    } else if (data?.type === "failed" || data?.type === "canceled") {
      fail(
        data.status
          ? new DownloadHttpError(data.status)
          : new Error(
              data.type === "canceled"
                ? "Download canceled"
                : "P2P download interrupted",
            ),
      );
      stop();
    }
  };
  port.start();
  try {
    worker.postMessage({ type: "chatroom-download-register", id, url, name }, [
      bridge.port2,
    ]);
    if (!(await registration)) return false;
    if (signal.aborted)
      throw new DOMException("Download canceled", "AbortError");
    const anchor = document.createElement("a");
    // Do not set 'download': it bypasses the Service Worker's stream in Chrome.
    anchor.href = "/__chatroom_download/" + id;
    anchor.click();
    await transfer;
    return true;
  } finally {
    stop();
  }
}
