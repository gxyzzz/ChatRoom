import { Router } from "express";
import { ChatRoomError } from "#core/errors/chatroom-error";
import type { AgentRuntime } from "#plugins/agent/runtime";
import { isAgentProviderId, isAgentPermissionMode } from "#plugins/agent/types";
import type {
  AgentAttachment,
  AgentInteractionResponse,
  AgentProviderId,
  AgentReviewTarget,
  AgentSessionConfig,
} from "#plugins/agent/types";
import {
  asyncRoute,
  bodyRecord,
  requireString,
} from "#presentation/http/http-utils";

export function createAgentApiRouter(agents: AgentRuntime): Router {
  const router = Router();

  router.get(
    "/agents/providers",
    asyncRoute(async (_req, res) => {
      res.json(await agents.providerStatuses());
    }),
  );

  router.get(
    "/agents/providers/:provider/models",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.models(
          requireProvider(requireString(req.params.provider, "provider")),
        ),
      );
    }),
  );

  router.get(
    "/agents/providers/:provider/details",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.providerDetails(
          requireProvider(requireString(req.params.provider, "provider")),
        ),
      );
    }),
  );

  router.get("/agents/sessions", (_req, res) => {
    res.json(agents.listSessions());
  });

  router.post(
    "/agents/sessions",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      res.json(
        await agents.createSession({
          workspaceId: requireString(body.workspaceId, "workspaceId"),
          provider: requireProvider(requireString(body.provider, "provider")),
          model: null,
          reasoningEffort: null,
          reasoningSummary: null,
          serviceTier: null,
          approvalPolicy: null,
          approvalsReviewer: null,
          permissionMode: null,
          ...parseConfig(body),
        }),
      );
    }),
  );

  router.get("/agents/sessions/:sessionId/history", (req, res) => {
    res.json(agents.history(requireString(req.params.sessionId, "sessionId")));
  });

  router.get("/agents/sessions/:sessionId/update", (req, res) => {
    res.json(
      agents.historyUpdate(
        requireString(req.params.sessionId, "sessionId"),
        parseIdList(req.query.turnIds),
        parseIdList(req.query.itemIds),
      ),
    );
  });

  router.put(
    "/agents/sessions/:sessionId/config",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      res.json(
        await agents.configureSession(
          requireString(req.params.sessionId, "sessionId"),
          parseConfig(body),
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/turns",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      res.json(
        await agents.startTurn(
          requireString(req.params.sessionId, "sessionId"),
          {
            text: typeof body.text === "string" ? body.text : "",
            attachments: parseAttachments(body.attachments),
            outputSchema: body.outputSchema ?? null,
          },
          "human",
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/steer",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      requireKeys(body, ["text", "attachments"]);
      if (body.text !== undefined && typeof body.text !== "string")
        throw new ChatRoomError("INVALID_INPUT", "text must be a string");
      await agents.steer(
        requireString(req.params.sessionId, "sessionId"),
        {
          text: typeof body.text === "string" ? body.text : "",
          attachments: parseAttachments(body.attachments),
        },
        "human",
      );
      res.status(204).end();
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/review",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      requireKeys(body, ["target"]);
      res.json(
        await agents.startReview(
          requireString(req.params.sessionId, "sessionId"),
          parseReviewTarget(body.target),
          "human",
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/interrupt",
    asyncRoute(async (req, res) => {
      await agents.interrupt(requireString(req.params.sessionId, "sessionId"));
      res.status(204).end();
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/interactions/:itemId",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.respondInteraction(
          requireString(req.params.sessionId, "sessionId"),
          requireString(req.params.itemId, "itemId"),
          parseInteractionResponse(bodyRecord(req.body)),
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/provider",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      res.json(
        await agents.switchProvider(
          requireString(req.params.sessionId, "sessionId"),
          requireProvider(requireString(body.provider, "provider")),
          parseConfig(body),
        ),
      );
    }),
  );

  const bulkDeleteSessions = asyncRoute(async (req, res) => {
    const body = bodyRecord(req.body);
    if (!Array.isArray(body.sessionIds) || body.sessionIds.length === 0)
      throw new ChatRoomError(
        "INVALID_INPUT",
        "sessionIds must be a non-empty array",
      );
    if (body.sessionIds.length > 100)
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Cannot delete more than 100 Agent sessions at once",
      );
    const sessionIds = body.sessionIds.map((id) =>
      requireString(id, "sessionIds[]"),
    );
    await agents.deleteSessions(sessionIds);
    res.status(204).end();
  });
  // POST is the primary batch action for maximum compatibility with clients
  // and intermediaries that mishandle bodies on DELETE requests.
  router.post("/agents/sessions/bulk-delete", bulkDeleteSessions);
  router.delete("/agents/sessions", bulkDeleteSessions);

  router.delete(
    "/agents/sessions/:sessionId",
    asyncRoute(async (req, res) => {
      await agents.deleteSession(
        requireString(req.params.sessionId, "sessionId"),
      );
      res.status(204).end();
    }),
  );

  return router;
}

function parseIdList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const output = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== "string") continue;
    for (const id of entry.split(",")) {
      if (!id) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new ChatRoomError("INVALID_INPUT", "Invalid Agent update id");
      output.add(id);
      if (output.size > 256)
        throw new ChatRoomError("INVALID_INPUT", "Too many Agent update ids");
    }
  }
  return [...output];
}

function requireProvider(value: string): AgentProviderId {
  if (isAgentProviderId(value)) return value;
  throw new ChatRoomError("INVALID_INPUT", "Invalid Agent provider id");
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string")
    throw new ChatRoomError("INVALID_INPUT", "Expected a string");
  return value;
}

function parseAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new ChatRoomError("INVALID_INPUT", "attachments must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Invalid attachment at index " + index,
      );
    const record = entry as Record<string, unknown>;
    const kind = requireString(record.kind, "attachments.kind");
    if (!["image", "audio", "skill", "file"].includes(kind))
      throw new ChatRoomError("INVALID_INPUT", "Invalid attachment kind");
    return {
      kind: kind as AgentAttachment["kind"],
      name: requireString(record.name, "attachments.name"),
      path: requireString(record.path, "attachments.path"),
      mimeType: optionalString(record.mimeType),
    };
  });
}

function parseInteractionResponse(
  body: Record<string, unknown>,
): AgentInteractionResponse {
  const type = requireString(body.type, "type");
  if (type === "approval") {
    const decision = requireString(body.decision, "decision");
    return { type, decision };
  }
  if (type === "input") {
    if (
      !body.answers ||
      typeof body.answers !== "object" ||
      Array.isArray(body.answers)
    )
      throw new ChatRoomError("INVALID_INPUT", "answers must be an object");
    const answers: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(
      body.answers as Record<string, unknown>,
    )) {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string")
      )
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Interaction answers must be string arrays",
        );
      answers[key] = value as string[];
    }
    return { type, answers };
  }
  throw new ChatRoomError("INVALID_INPUT", "Unsupported interaction response");
}

function parseConfig(
  body: Record<string, unknown>,
): Partial<AgentSessionConfig> {
  const config: Partial<AgentSessionConfig> = {};
  for (const key of ["model", "reasoningEffort", "serviceTier"] as const) {
    if (Object.hasOwn(body, key)) config[key] = optionalString(body[key]);
  }
  if (Object.hasOwn(body, "approvalPolicy"))
    config.approvalPolicy = parseApprovalPolicy(body.approvalPolicy);
  if (Object.hasOwn(body, "approvalsReviewer")) {
    const value = optionalString(body.approvalsReviewer);
    if (
      value !== null &&
      !["user", "auto_review", "guardian_subagent"].includes(value)
    )
      throw new ChatRoomError("INVALID_INPUT", "Invalid approvalsReviewer");
    config.approvalsReviewer = value as AgentSessionConfig["approvalsReviewer"];
  }
  if (Object.hasOwn(body, "permissionMode")) {
    const value = optionalString(body.permissionMode);
    if (value !== null && !isAgentPermissionMode(value))
      throw new ChatRoomError("INVALID_INPUT", "Invalid permissionMode");
    config.permissionMode = value as AgentSessionConfig["permissionMode"];
  }
  if (Object.hasOwn(body, "reasoningSummary")) {
    const value = optionalString(body.reasoningSummary);
    if (
      value !== null &&
      !["auto", "concise", "detailed", "none"].includes(value)
    )
      throw new ChatRoomError("INVALID_INPUT", "Invalid reasoning summary");
    config.reasoningSummary = value as AgentSessionConfig["reasoningSummary"];
  }
  return config;
}

function parseApprovalPolicy(
  value: unknown,
): AgentSessionConfig["approvalPolicy"] {
  if (value === null || value === undefined) return null;
  if (value === "untrusted" || value === "on-request" || value === "never")
    return value;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatRoomError("INVALID_INPUT", "Invalid approvalPolicy");
  const record = value as Record<string, unknown>;
  requireKeys(record, ["granular"]);
  const granularValue = record.granular;
  if (
    !granularValue ||
    typeof granularValue !== "object" ||
    Array.isArray(granularValue)
  )
    throw new ChatRoomError("INVALID_INPUT", "Invalid granular approvalPolicy");
  const granular = granularValue as Record<string, unknown>;
  const keys = [
    "sandbox_approval",
    "rules",
    "skill_approval",
    "request_permissions",
    "mcp_elicitations",
  ] as const;
  requireKeys(granular, [...keys]);
  if (
    keys.some(
      (key) =>
        !Object.hasOwn(granular, key) || typeof granular[key] !== "boolean",
    )
  )
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Granular approvalPolicy fields must be booleans",
    );
  return {
    granular: {
      sandbox_approval: granular.sandbox_approval as boolean,
      rules: granular.rules as boolean,
      skill_approval: granular.skill_approval as boolean,
      request_permissions: granular.request_permissions as boolean,
      mcp_elicitations: granular.mcp_elicitations as boolean,
    },
  };
}

function requireKeys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new ChatRoomError("INVALID_INPUT", "Unexpected request field");
}

function parseReviewTarget(value: unknown): AgentReviewTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatRoomError("INVALID_INPUT", "target must be an object");
  const target = value as Record<string, unknown>;
  const type = requireString(target.type, "target.type");
  switch (type) {
    case "uncommittedChanges":
      requireKeys(target, ["type"]);
      return { type };
    case "baseBranch":
      requireKeys(target, ["type", "branch"]);
      return { type, branch: requireString(target.branch, "target.branch") };
    case "commit":
      requireKeys(target, ["type", "sha", "title"]);
      return {
        type,
        sha: requireString(target.sha, "target.sha"),
        title: optionalString(target.title),
      };
    case "custom":
      requireKeys(target, ["type", "instructions"]);
      return {
        type,
        instructions: requireString(target.instructions, "target.instructions"),
      };
    default:
      throw new ChatRoomError("INVALID_INPUT", "Unsupported review target");
  }
}
