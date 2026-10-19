import { Router, type Request } from "express";
import type { IngressPolicy } from "#auth/ingress-policy";
import { ChatRoomError } from "#core/errors/chatroom-error";
import type { CustomMcpConfig } from "#mcp/custom/types";
import type { CustomMcpManager } from "#mcp/custom/manager";
import { bodyRecord, requireString } from "#presentation/http/http-utils";

type Editable = Omit<CustomMcpConfig, "id">;

function settings(
  body: Record<string, unknown>,
  partial = false,
): Partial<Editable> {
  const config: Partial<Editable> = {};
  const str = (key: string): string => {
    if (typeof body[key] !== "string")
      throw new ChatRoomError("INVALID_INPUT", key + " must be a string");
    return body[key] as string;
  };
  if (!partial || "name" in body) config.name = str("name").trim();
  if (!partial || "type" in body) {
    const type = str("type");
    if (type !== "stdio" && type !== "http")
      throw new ChatRoomError("INVALID_INPUT", "Unsupported MCP transport");
    config.type = type;
  }
  for (const key of ["command", "cwd", "url"] as const)
    if (key in body) config[key] = str(key);
  if ("args" in body) {
    if (
      !Array.isArray(body.args) ||
      body.args.some((value) => typeof value !== "string")
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "args must be an array of strings",
      );
    config.args = body.args as string[];
  }
  for (const key of ["env", "headers"] as const) {
    if (!(key in body)) continue;
    const data = body[key];
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.entries(data).some(
        ([name, value]) => !name.trim() || typeof value !== "string",
      )
    )
      throw new ChatRoomError("INVALID_INPUT", key + " must be a string map");
    config[key] = data as Record<string, string>;
  }
  if ("authMode" in body) {
    const value = str("authMode");
    if (!["auto", "none", "headers"].includes(value))
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Unsupported MCP authentication",
      );
    config.authMode = value as "auto" | "none" | "headers";
  }
  if (!partial || "enabled" in body) {
    if (typeof body.enabled !== "boolean")
      throw new ChatRoomError("INVALID_INPUT", "enabled must be a boolean");
    config.enabled = body.enabled;
  }
  return config;
}

export function createCustomMcpApiRouter(
  manager: CustomMcpManager,
  ingress: IngressPolicy,
): Router {
  const router = Router();
  router.get("/mcp/servers", (_req, res) => res.json(manager.list()));
  router.post("/mcp/servers", async (req, res) => {
    const config = settings(bodyRecord(req.body)) as Editable;
    res.status(201).json(await manager.create(config));
  });
  router.post("/mcp/servers/test", async (req, res) => {
    const config = settings(bodyRecord(req.body)) as Editable;
    res.json(await manager.test(config));
  });
  router.post("/mcp/servers/:id/test", async (req, res) => {
    res.json(await manager.testStored(requireString(req.params.id, "id")));
  });
  router.patch("/mcp/servers/:id", async (req, res) => {
    const id = requireString(req.params.id, "id");
    res.json(await manager.update(id, settings(bodyRecord(req.body), true)));
  });
  router.delete("/mcp/servers/:id", async (req, res) => {
    await manager.remove(requireString(req.params.id, "id"));
    res.json({ ok: true });
  });
  router.post("/mcp/servers/:id/authorize", async (req, res) => {
    const id = requireString(req.params.id, "id");
    const origin =
      ingress.expectedWebOrigin(req) ??
      `http://${req.get("host") ?? "localhost:8765"}`;
    res.json(await manager.authorize(id, origin + "/api/mcp/oauth/callback"));
  });
  router.post("/mcp/servers/:id/revoke", async (req, res) => {
    await manager.revokeAuthorization(requireString(req.params.id, "id"));
    res.json({ ok: true });
  });
  router.post("/mcp/servers/:id/refresh", async (req, res) => {
    res.json(await manager.refresh(requireString(req.params.id, "id")));
  });
  return router;
}

/** Public OAuth callback: the random state is single-use and scoped to an initiated login. */
export function createCustomMcpOAuthCallbackRouter(
  manager: CustomMcpManager,
): Router {
  const router = Router();
  router.get("/mcp/oauth/callback", async (req: Request, res) => {
    const query = new URLSearchParams();
    for (const key of ["state", "code", "iss", "error"])
      if (typeof req.query[key] === "string") query.set(key, req.query[key]);
    let success = false;
    try {
      await manager.completeAuthorization(query);
      success = true;
    } catch {
      // Never expose OAuth codes, provider errors, or credentials in this page.
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    res.status(success ? 200 : 400).type("html")
      .send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>ChatRoom MCP</title>
<body><p>${success ? "Authorization completed. You may close this window." : "Authorization failed. Return to ChatRoom and retry."}</p>
<script>window.opener?.postMessage({type:"chatroom:mcp-oauth-completed",success:${success}},window.location.origin);window.close();</script>
</body></html>`);
  });
  return router;
}
