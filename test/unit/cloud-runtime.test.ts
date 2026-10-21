import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CLOUD_LEASE_SCHEMA } from "../../src/plugins/cloud/types.js";
import { CloudTunnelClient } from "../../src/plugins/cloud/tunnel-client.js";
import {
  decodeFrame,
  encodeFrame,
  metaFrame,
  Op,
  creditFrame,
  CreditSender,
  DATA_SIZE,
} from "../../src/plugins/cloud/v2/stream.js";

test("V2 device tunnel pins HTTP Host to its leased public origin", async () => {
  let resolveHost!: (host: string | undefined) => void;
  const receivedHost = new Promise<string | undefined>((resolve) => {
    resolveHost = resolve;
  });
  const server = createServer((request, response) => {
    resolveHost(request.headers.host);
    response.statusCode = 204;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const lease = CLOUD_LEASE_SCHEMA.parse({
    token: "lease-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tunnelUrl: "wss://tunnel.example.com",
    mcpBaseUrl: null,
    webBaseUrl: "https://web.example.com",
    services: ["remote_web"],
  });
  const client = new CloudTunnelClient(
    lease,
    { devicePrivateKey: "unused" },
    { host: "127.0.0.1", port: address.port },
    {
      onConnected() {},
      onDisconnected() {},
      onLeaseRejected() {},
      onError() {},
    },
  );
  try {
    const internal = client as unknown as {
      handleFrame(raw: Uint8Array): void;
    };
    internal.handleFrame(
      metaFrame(Op.OPEN, 1, {
        service: "web",
        method: "GET",
        path: "/api/runtime",
        headers: { host: "localhost" },
      }),
    );
    internal.handleFrame(encodeFrame(Op.FIN, 1));
    assert.equal(await receivedHost, "web.example.com");
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("V2 tunnel reconnects after HTTP handshake failures when Cloud recovers", async () => {
  const failures = [521, 503];
  const errors: string[] = [];
  let attempts = 0;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const status = failures[attempts++];
    if (status) {
      socket.end(
        "HTTP/1.1 " +
          status +
          " Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (peer) => {
      peer.send(JSON.stringify({ type: "ready" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const lease = CLOUD_LEASE_SCHEMA.parse({
    token: "lease-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tunnelUrl: "ws://127.0.0.1:" + port,
    mcpBaseUrl: null,
    webBaseUrl: "https://web.example.com",
    services: ["remote_web"],
  });
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const client = new CloudTunnelClient(
    lease,
    { devicePrivateKey: "unused" },
    { host: "127.0.0.1", port },
    {
      onConnected: connected,
      onDisconnected() {},
      onLeaseRejected() {},
      onError: (error) => errors.push(error.message),
    },
  );
  try {
    client.start();
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Cloud did not reconnect")),
          5000,
        ).unref();
      }),
    ]);
    assert.equal(attempts, 3);
    assert.deepEqual(errors, [
      "Tunnel V2 handshake rejected: 521",
      "Tunnel V2 handshake rejected: 503",
    ]);
  } finally {
    client.stop();
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("V2 rejects invalid frames instead of accepting malformed control messages", () => {
  assert.deepEqual(
    decodeFrame(metaFrame(Op.OPEN, 3, { service: "web" })).op,
    Op.OPEN,
  );
  assert.throws(() => decodeFrame(new Uint8Array([1, 2])));
  assert.throws(() =>
    decodeFrame(encodeFrame(Op.DATA, 1, new Uint8Array(DATA_SIZE + 1))),
  );
  assert.throws(() =>
    decodeFrame(encodeFrame(Op.FIN, 1, new Uint8Array([42]))),
  );
  assert.throws(() => decodeFrame(encodeFrame(Op.OPEN, 0)));
  assert.equal(decodeFrame(creditFrame(7, 1024)).id, 7);
  assert.throws(() => creditFrame(7, 0));
});

test("V2 sender chunks data, respects flow credit and half-closes only after drain", () => {
  const frames: Uint8Array[] = [];
  const sender = new CreditSender(
    1,
    (frame) => frames.push(frame),
    () => {},
    () => {},
  );
  sender.enqueue(new Uint8Array(320_000));
  sender.end();
  assert.equal(
    frames
      .filter((frame) => decodeFrame(frame).op === Op.DATA)
      .reduce((sum, frame) => sum + decodeFrame(frame).payload.byteLength, 0),
    256 * 1024,
  );
  assert.equal(
    frames.some((frame) => decodeFrame(frame).op === Op.FIN),
    false,
  );
  sender.addCredit(64 * 1024);
  assert.equal(
    frames.some((frame) => decodeFrame(frame).op === Op.FIN),
    true,
  );
});
