import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestRuntime } from "../helpers/runtime.js";

test("workspace image preview uses versioned immutable caching and conditional 304", async () => {
  const runtime = await createTestRuntime();
  try {
    const workspace = runtime.components.database.raw
      .prepare("SELECT id FROM workspaces WHERE path=?")
      .get(runtime.workspaceRoot) as { id: string } | undefined;
    assert.ok(workspace);
    const imagePath = path.join(runtime.workspaceRoot, "preview.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const info = await stat(imagePath);
    const modifiedAt = info.mtime.toISOString();

    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);
    const base =
      `http://127.0.0.1:${address.port}/api/workspace/file/image?workspaceId=` +
      encodeURIComponent(workspace.id) +
      "&path=" +
      encodeURIComponent("preview.png");

    const versioned = await fetch(
      base + "&v=" + encodeURIComponent(modifiedAt),
    );
    assert.equal(versioned.status, 200);
    assert.equal(
      versioned.headers.get("cache-control"),
      "private, max-age=31536000, immutable",
    );
    const etag = versioned.headers.get("etag");
    assert.ok(etag);
    await versioned.arrayBuffer();

    const conditional = await fetch(base + "&v=agent-item-version", {
      headers: { "If-None-Match": etag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get("cache-control"), "private, no-cache");
  } finally {
    await runtime.cleanup();
  }
});
