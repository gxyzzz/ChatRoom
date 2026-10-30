import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestRuntime } from "../helpers/runtime.js";

test("workspace file download is streamed and supports Range", async () => {
  const runtime = await createTestRuntime();
  try {
    const workspace = runtime.components.database.raw
      .prepare("SELECT id FROM workspaces WHERE path=?")
      .get(runtime.workspaceRoot) as { id: string } | undefined;
    assert.ok(workspace);
    const payload = Buffer.alloc(3 * 1024 * 1024, 147);
    await writeFile(path.join(runtime.workspaceRoot, "测试文件.bin"), payload);
    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);
    const params = new URLSearchParams({
      workspaceId: workspace.id,
      path: "测试文件.bin",
    });
    const url = `http://127.0.0.1:${address.port}/api/workspace/file/download?${params}`;
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(payload.length));
    assert.match(head.headers.get("content-disposition") ?? "", /attachment/);
    const partial = await fetch(url, {
      headers: { Range: "bytes=12-45", "Accept-Encoding": "gzip" },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-encoding"), null);
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      payload.subarray(12, 46),
    );
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);
  } finally {
    await runtime.cleanup();
  }
});

test("workspace file download shares Web session authentication", async () => {
  const runtime = await createTestRuntime({
    configure(config) {
      config.auth.localWebAuth = true;
    },
  });
  try {
    const workspace = runtime.components.database.raw
      .prepare("SELECT id FROM workspaces WHERE path=?")
      .get(runtime.workspaceRoot) as { id: string } | undefined;
    assert.ok(workspace);
    await writeFile(
      path.join(runtime.workspaceRoot, "data.txt"),
      "authenticated",
    );
    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);
    const base = `http://127.0.0.1:${address.port}`;
    const params = new URLSearchParams({
      workspaceId: workspace.id,
      path: "data.txt",
    });
    const url = `${base}/api/workspace/file/download?${params}`;
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerToken: "test-owner-token" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie);
    const file = await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "authenticated");
  } finally {
    await runtime.cleanup();
  }
});
