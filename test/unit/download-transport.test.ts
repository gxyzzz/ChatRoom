import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import {
  rtcConnected,
  rtcStatus,
  waitForRtcReady,
} from "../../src/plugins/web/ui/transport/rtc.js";

test("P2P readiness waits for both the DataChannel and Service Worker", async () => {
  const listeners = new Set<() => void>();
  const serviceWorker = {
    controller: null as object | null,
    addEventListener(_name: string, cb: () => void) {
      listeners.add(cb);
    },
    removeEventListener(_name: string, cb: () => void) {
      listeners.delete(cb);
    },
  };
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  try {
    rtcConnected.value = false;
    rtcStatus.value = "connecting";
    const pending = waitForRtcReady(500, new AbortController().signal);
    rtcConnected.value = true;
    serviceWorker.controller = {};
    for (const notify of listeners) notify();
    assert.equal(await pending, true);
    assert.equal(listeners.size, 0);

    rtcConnected.value = false;
    serviceWorker.controller = null;
    const timedOut = await waitForRtcReady(10, new AbortController().signal);
    assert.equal(timedOut, false);
    assert.equal(listeners.size, 0);

    const aborter = new AbortController();
    const aborted = waitForRtcReady(500, aborter.signal);
    aborter.abort();
    assert.equal(await aborted, false);
    assert.equal(listeners.size, 0);

    rtcStatus.value = "unavailable";
    assert.equal(
      await waitForRtcReady(500, new AbortController().signal),
      false,
    );
  } finally {
    rtcConnected.value = false;
    rtcStatus.value = "unavailable";
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("explicit HTTP file downloads bypass an active P2P Service Worker", async () => {
  const events = new Map<string, (event: any) => void>();
  const origin = "https://chatroom.example";
  let httpRequests = 0;
  const worker = {
    location: { origin },
    addEventListener(name: string, cb: (event: any) => void) {
      events.set(name, cb);
    },
    clients: { claim: async () => {}, get: async () => ({ id: "client1" }) },
    skipWaiting() {},
  };
  const code = readFileSync(
    path.join(process.cwd(), "src/plugins/web/ui/public/transport-sw.js"),
    "utf8",
  );
  vm.runInNewContext(code, {
    self: worker,
    URL,
    Headers,
    Request,
    Response,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      httpRequests++;
      return new Response("http-file", { status: 200 });
    },
  });
  events.get("message")?.({
    data: { type: "chatroom-v2-state", active: true },
    source: { id: "client1" },
  });
  const download = { response: null as Promise<Response> | null };
  events.get("fetch")?.({
    request: new Request(
      origin +
        "/api/workspace/file/download?workspace=x&path=a.txt&__chatroom_http=1",
    ),
    clientId: "client1",
    respondWith(value: Promise<Response>) {
      download.response = value;
    },
  });
  assert.ok(download.response);
  const reply = await download.response;
  assert.equal(await reply.text(), "http-file");
  assert.equal(httpRequests, 1);
});
