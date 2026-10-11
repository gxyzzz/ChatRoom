import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileLogStore } from "../../src/infrastructure/logging/file-log-store.js";
import { SystemLog } from "../../src/infrastructure/logging/system-log.js";
import { SecretRedactor } from "../../src/core/operations/redactor.js";

test("SystemLog persists redacted JSONL and filters history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatroom-system-log-"));
  try {
    const store = new FileLogStore(dir);
    const logs = new SystemLog(store);
    const shared = { value: "shared" };
    logs.info("auth", "auth.success", "Authentication succeeded", {
      method: "owner_token",
      token: "do-not-persist-this",
      first: shared,
      second: shared,
    });
    logs.warn("cloud", "cloud.disconnected", "Cloud tunnel disconnected");
    await logs.flush();
    await store.append({
      id: "large-record",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      level: "debug",
      module: "app",
      event: "app.large",
      message: "x".repeat(70_000),
    });

    const raw = await readFile(store.filePath, "utf8");
    assert.doesNotMatch(raw, /do-not-persist-this/);
    assert.match(raw, /\[redacted\]/);

    const page = await logs.list({
      limit: 10,
      levels: new Set(["info"]),
      modules: new Set(["auth"]),
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.event, "auth.success");
    assert.equal(page.items[0]?.data?.token, "[redacted]");
    assert.deepEqual(page.items[0]?.data?.first, { value: "shared" });
    assert.deepEqual(page.items[0]?.data?.second, { value: "shared" });
    assert.equal(page.nextCursor, null);

    const firstPage = await logs.list({ limit: 1 });
    assert.equal(firstPage.items[0]?.id, "large-record");
    assert.ok(firstPage.nextCursor);
    const secondPage = await logs.list({
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    assert.equal(secondPage.items[0]?.event, "cloud.disconnected");

    const sharedRedacted = { value: "safe" };
    assert.deepEqual(
      new SecretRedactor().redact({
        first: sharedRedacted,
        second: sharedRedacted,
      }),
      {
        first: { value: "safe" },
        second: { value: "safe" },
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SystemLog strips ANSI escapes from new records", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "chatroom-system-log-ansi-"),
  );
  try {
    const store = new FileLogStore(dir);
    const logs = new SystemLog(store);
    const received: string[] = [];
    logs.subscribe((record) => received.push(record.message));

    logs.debug(
      "agent.codex",
      "codex.stderr",
      "\u001b[2m2026-10-09T04:21:39Z\u001b[0m \u001b[31mERROR\u001b[0m failed to load cache",
    );
    await logs.flush();

    assert.deepEqual(received, [
      "2026-10-09T04:21:39Z ERROR failed to load cache",
    ]);
    const saved = await readFile(store.filePath, "utf8");
    assert.doesNotMatch(saved, /\\u001b/);
    assert.match(saved, /ERROR failed to load cache/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
