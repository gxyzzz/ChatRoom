import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestRuntime } from "../helpers/runtime.js";

async function getFile(port: number, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "workspace_file_get", arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const event = body.split("\n").find((part) => part.startsWith("data: "));
  const payload = JSON.parse(event ? event.slice(6) : body);
  assert.equal(payload.id, 42);
  return payload.result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { type: string; text?: string }[];
  };
}

test("MCP workspace_file_get returns chunked text, binary and Web links without logging content", async () => {
  const runtime = await createTestRuntime({
    configure(config) {
      config.auth.webPublicBaseUrl = "https://files.example.com";
    },
  });
  try {
    const data = "sensitive-content-5798你好abc";
    await writeFile(path.join(runtime.workspaceRoot, "text.txt"), data);
    const binary = Buffer.from([0xff, 0x00, 0x81, 0x23]);
    await writeFile(path.join(runtime.workspaceRoot, "binary.dat"), binary);
    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);

    const first = await getFile(address.port, {
      root: runtime.workspaceRoot,
      path: "text.txt",
      maxBytes: 23,
    });
    assert.equal(first.isError, undefined);
    assert.equal(first.structuredContent?.content, "sensitive-content-5798");
    assert.equal(first.structuredContent?.nextOffset, 22);

    const rest = await getFile(address.port, {
      root: runtime.workspaceRoot,
      path: "text.txt",
      offset: 22,
    });
    assert.equal(rest.structuredContent?.content, "你好abc");
    assert.equal(rest.structuredContent?.nextOffset, null);

    const asBase64 = await getFile(address.port, {
      root: runtime.workspaceRoot,
      path: "binary.dat",
      encoding: "base64",
    });
    assert.equal(
      asBase64.structuredContent?.content,
      binary.toString("base64"),
    );

    const link = await getFile(address.port, {
      root: runtime.workspaceRoot,
      path: "text.txt",
      mode: "link",
    });
    const uri = new URL(String(link.structuredContent?.url));
    assert.equal(uri.origin, "https://files.example.com");
    assert.equal(uri.pathname, "/download");
    assert.equal(uri.searchParams.get("path"), "text.txt");
    assert.equal(
      uri.searchParams.get("workspace"),
      path.basename(runtime.workspaceRoot),
    );
    assert.equal(uri.searchParams.has("root"), false);
    assert.equal(uri.toString().includes(runtime.workspaceRoot), false);

    const logs = JSON.stringify(
      runtime.components.operations.list({ limit: 100 }),
    );
    assert.equal(logs.includes(data), false);
    assert.equal(logs.includes(uri.toString()), false);
  } finally {
    await runtime.cleanup();
  }
});

test("MCP file link returns an error if Web has no public address", async () => {
  const runtime = await createTestRuntime();
  try {
    await writeFile(path.join(runtime.workspaceRoot, "file.txt"), "abc");
    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);
    const result = await getFile(address.port, {
      root: runtime.workspaceRoot,
      path: "file.txt",
      mode: "link",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /No public Web URL/);
  } finally {
    await runtime.cleanup();
  }
});
