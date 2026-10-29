/**
 * One origin-wide request path. The controlling page owns the authenticated
 * WebRTC transport; this service worker only bridges native browser fetches.
 * No data is cached, persisted, or sent to any third-party origin.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

const MAX_INLINE_UPLOAD = 8 * 1024 * 1024;
const ACCEPT_TIMEOUT = 1200;
const activeClients = new Set();
const downloads = new Map();
const DOWNLOAD_ROUTE = "/__chatroom_download/";
const DOWNLOAD_TIMEOUT = 15000;

function downloadHeader(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function registerDownload(event) {
  const port = event.ports[0];
  const source = event.source;
  const data = event.data;
  if (!port || !source?.id) return;
  const url =
    typeof data.url === "string"
      ? new URL(data.url, self.location.origin)
      : null;
  const name = data.name;
  if (
    !activeClients.has(source.id) ||
    typeof data.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(data.id) ||
    !url ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/api/auth/") ||
    url.pathname.startsWith("/api/rtc/") ||
    typeof name !== "string" ||
    !name ||
    name.length > 255 ||
    downloads.size >= 8
  ) {
    port.postMessage({ type: "unavailable" });
    port.close();
    return;
  }
  const timer = setTimeout(() => {
    downloads.delete(data.id);
    port.postMessage({ type: "unavailable" });
    port.close();
  }, DOWNLOAD_TIMEOUT);
  downloads.set(data.id, {
    url: url.href,
    name,
    clientId: source.id,
    port,
    timer,
  });
  port.postMessage({ type: "ready" });
}

async function streamDownload(id) {
  const entry = downloads.get(id);
  if (!entry) return new Response("Download session expired", { status: 410 });
  downloads.delete(id);
  clearTimeout(entry.timer);
  const { port } = entry;
  const client = await self.clients.get(entry.clientId);
  if (!client) {
    port.postMessage({ type: "unavailable" });
    port.close();
    return new Response(null, { status: 204 });
  }

  const request = new Request(entry.url, {
    credentials: "same-origin",
    cache: "no-store",
  });
  let response;
  try {
    response = await route({ request, clientId: client.id });
  } catch {
    port.postMessage({ type: "unavailable" });
    port.close();
    return new Response(null, { status: 204 });
  }
  if (!response.ok || !response.body) {
    port.postMessage({ type: "failed", status: response.status });
    port.close();
    return new Response(null, { status: 204 });
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Disposition", downloadHeader(entry.name));
  headers.set(
    "Content-Type",
    headers.get("content-type") || "application/octet-stream",
  );
  headers.set("Cache-Control", "private, no-store, no-transform");
  // Let the browser's native download manager consume each chunk. No whole-file Blob.
  const reader = response.body.getReader();
  let received = 0;
  let downstream = null;
  let complete = false;
  let stopped = false;
  let lastReport = 0;
  port.onmessage = (event) => {
    if (event.data?.type === "cancel" && !stopped) {
      stopped = true;
      try {
        downstream?.error(new Error("Download canceled"));
      } catch {
        // The browser may already have stopped reading the stream.
      }
      void reader.cancel("Download canceled");
      port.postMessage({ type: "canceled" });
      port.close();
    }
  };
  port.start();
  const stream = new ReadableStream(
    {
      start(controller) {
        downstream = controller;
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            complete = true;
            const declared = headers.get("content-length");
            if (
              declared !== null &&
              /^\d+$/.test(declared) &&
              Number(declared) !== received
            )
              throw Error("Incomplete download");
            controller.close();
            if (!stopped) {
              port.postMessage({ type: "finished", bytes: received });
              port.close();
            }
            return;
          }
          if (stopped) throw Error("Download canceled");
          received += value.byteLength;
          controller.enqueue(value);
          const now = Date.now();
          if (now - lastReport >= 150) {
            lastReport = now;
            port.postMessage({ type: "progress", bytes: received });
          }
        } catch {
          if (!stopped) controller.error(new Error("Download interrupted"));
          if (!stopped) {
            port.postMessage({ type: "failed" });
            port.close();
          }
          stopped = true;
        }
      },
      cancel() {
        if (!complete && !stopped) {
          stopped = true;
          void reader.cancel();
          port.postMessage({ type: "canceled" });
          port.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  port.postMessage({
    type: "started",
    mode: headers.get("x-chatroom-transport") === "p2p" ? "p2p" : "http",
    total: headers.get("content-length"),
  });
  headers.delete("x-chatroom-transport");
  return new Response(stream, { status: 200, headers });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "chatroom-download-register") {
    registerDownload(event);
    return;
  }
  if (event.data?.type !== "chatroom-v2-state" || !event.source?.id) return;
  if (event.data.active) activeClients.add(event.source.id);
  else activeClients.delete(event.source.id);
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    url.origin === self.location.origin &&
    request.method === "GET" &&
    url.pathname.startsWith(DOWNLOAD_ROUTE)
  ) {
    const id = url.pathname.slice(DOWNLOAD_ROUTE.length);
    event.respondWith(streamDownload(id));
    return;
  }
  if (request.mode === "navigate" && !url.pathname.startsWith("/api/")) {
    // A page navigation must not inherit the previous document's P2P session.
    if (event.clientId) activeClients.delete(event.clientId);
    if (event.resultingClientId) activeClients.delete(event.resultingClientId);
    return;
  }
  if (
    url.origin !== self.location.origin ||
    !(
      url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")
    ) ||
    url.pathname.startsWith("/api/auth/") ||
    url.pathname === "/api/rtc/offer" ||
    request.method === "HEAD" ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)
  )
    return;

  event.respondWith(route(event));
});

async function route(event) {
  const request = event.request;
  const url = new URL(request.url);
  // Explicit HTTP selection and timed-out P2P downloads must stay on HTTP.
  if (
    url.pathname.startsWith("/api/workspace/file/") &&
    url.searchParams.get("__chatroom_http") === "1"
  )
    return fetch(request);
  // Keep conditional cache validation on the native HTTP path. Browsers handle
  // HTTP 304 cache merging, while a synthetic Service Worker 304 is unreliable.
  if (
    request.method === "GET" &&
    (request.headers.has("if-none-match") ||
      request.headers.has("if-modified-since"))
  )
    return fetch(request);
  if (!activeClients.has(event.clientId)) return fetch(request);
  const client = event.clientId && (await self.clients.get(event.clientId));
  if (!client) {
    activeClients.delete(event.clientId);
    return fetch(request);
  }

  const expectedSize = request.headers.get("x-chatroom-upload-size");
  const declaredSize = expectedSize === null ? null : Number(expectedSize);
  if (
    declaredSize !== null &&
    (!Number.isSafeInteger(declaredSize) || declaredSize <= 0)
  )
    return new Response("Invalid upload size", { status: 400 });
  if (declaredSize !== null && declaredSize > MAX_INLINE_UPLOAD)
    return fetch(request);
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_INLINE_UPLOAD)
    return fetch(request);
  let body = new ArrayBuffer(0);
  if (request.method !== "GET") {
    try {
      const clone = request.clone();
      if (url.pathname === "/api/workspace/attachment" || !clone.body) {
        // Binary uploads must use the Request payload, not a browser-specific
        // File stream. Firefox can also expose null FetchEvent.request.body.
        body = await clone.arrayBuffer();
        if (body.byteLength > MAX_INLINE_UPLOAD) return fetch(request);
      } else {
        // Keep all other requests bounded when Content-Length is unavailable.
        const reader = clone.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_INLINE_UPLOAD) {
            await reader.cancel();
            return fetch(request);
          }
          chunks.push(value);
        }
        const buffer = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.byteLength;
        }
        body = buffer.buffer;
      }
      if (declaredSize !== null && body.byteLength !== declaredSize)
        return fetch(request);
    } catch {
      return fetch(request);
    }
  }

  const bridge = new MessageChannel();
  const reply = bridge.port1;
  const init = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timed-out"), ACCEPT_TIMEOUT);
    reply.onmessage = (event) => {
      if (event.data?.type === "accepted") {
        clearTimeout(timer);
        resolve("accepted");
      }
      if (event.data?.type === "declined") {
        clearTimeout(timer);
        resolve("declined");
      }
    };
    reply.start();
  });

  const headers = {};
  for (const name of [
    "accept",
    "content-type",
    "range",
    "if-none-match",
    "if-modified-since",
    "x-chatroom-mime-type",
    "x-chatroom-upload-size",
  ]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    client.postMessage(
      {
        type: "chatroom-v2-request",
        url: url.pathname + url.search,
        method: request.method,
        headers,
        body,
      },
      [bridge.port2, body],
    );
  } catch {
    reply.close();
    return fetch(request);
  }

  const decision = await init;
  if (decision !== "accepted") {
    reply.close();
    // An unacknowledged write might already have executed. Never replay it.
    if (decision === "declined" || request.method === "GET")
      return fetch(request);
    return new Response("P2P request status unknown", { status: 504 });
  }

  // Once accepted, a mutation may already have executed. Only retry GETs
  // when the P2P response has not started, because GET is safe to repeat.
  let retryHttp = false;
  const response = await new Promise((resolve) => {
    let controller;
    let finished = false;
    let opened = false;
    let lastChunkCredit = 0;
    const timer = setTimeout(() => {
      if (!opened) {
        retryHttp = request.method === "GET";
        resolve(new Response("P2P response timed out", { status: 504 }));
        reply.postMessage({ type: "cancel" });
        close();
      }
    }, 120_000);
    const close = () => {
      finished = true;
      clearTimeout(timer);
      reply.close();
    };
    const stream = new ReadableStream(
      {
        start(value) {
          controller = value;
        },
        pull() {
          if (lastChunkCredit) {
            reply.postMessage({ type: "credit", bytes: lastChunkCredit });
            lastChunkCredit = 0;
          }
        },
        cancel() {
          if (!finished) reply.postMessage({ type: "cancel" });
          close();
        },
      },
      { highWaterMark: 0 },
    );
    reply.onmessage = (message) => {
      const data = message.data;
      if (finished) return;
      if (data?.type === "meta") {
        opened = true;
        const status = data.status;
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          retryHttp = request.method === "GET";
          close();
          resolve(Response.error());
          return;
        }
        const headers = new Headers(data.headers);
        headers.set("X-ChatRoom-Transport", "p2p");
        resolve(
          new Response([204, 205, 304].includes(status) ? null : stream, {
            status,
            headers,
          }),
        );
      } else if (data?.type === "chunk") {
        if (!opened) return;
        const chunk = new Uint8Array(data.bytes);
        try {
          controller.enqueue(chunk);
          lastChunkCredit += chunk.byteLength;
        } catch {
          reply.postMessage({ type: "cancel" });
          close();
        }
      } else if (data?.type === "end") {
        if (!opened) {
          retryHttp = request.method === "GET";
          resolve(Response.error());
        } else controller.close();
        close();
      } else if (data?.type === "error") {
        if (!opened) {
          retryHttp = request.method === "GET";
          resolve(new Response("P2P transport interrupted", { status: 502 }));
        } else controller.error(new Error("P2P transport interrupted"));
        close();
      }
    };
  });
  if (retryHttp) return fetch(request);
  return response;
}
