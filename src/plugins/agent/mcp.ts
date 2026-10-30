import { z } from "zod";
import type { PluginMcpRegistrar } from "#mcp/server/plugin-mcp-registrar";
import {
  closedRead,
  destructiveLocalMutation,
  openWorldMutation,
} from "#mcp/server/tool-support";
import type { AgentRuntime } from "./runtime.js";
import {
  AGENT_PROVIDER_ID_PATTERN,
  AGENT_PERMISSION_MODES,
  type AgentSessionConfig,
} from "./types.js";

const provider = z
  .string()
  .regex(AGENT_PROVIDER_ID_PATTERN)
  .describe("Registered Agent provider identifier.");
const attachment = z.object({
  kind: z.enum(["image", "audio", "skill", "file"]),
  name: z.string(),
  path: z.string(),
  mimeType: z.string().nullable().default(null),
});

const granularApprovalPolicy = z.object({
  granular: z.object({
    sandbox_approval: z.boolean(),
    rules: z.boolean(),
    skill_approval: z.boolean(),
    request_permissions: z.boolean(),
    mcp_elicitations: z.boolean(),
  }),
});
const approvalPolicy = z
  .union([z.enum(["untrusted", "on-request", "never"]), granularApprovalPolicy])
  .nullable()
  .describe(
    'Codex approvalPolicy: "untrusted", "on-request", {granular:{...}}, "never", or null for the provider default.',
  );
const approvalsReviewer = z
  .enum(["user", "auto_review", "guardian_subagent"])
  .nullable()
  .describe(
    'Codex approvalsReviewer: "user", "auto_review", "guardian_subagent", or null for the provider default.',
  );
const permissionMode = z
  .enum(AGENT_PERMISSION_MODES)
  .nullable()
  .describe(
    "Provider-native permissions. Codex supports read-only, workspace-write, and danger-full-access. Null uses the provider default. Read agent_providers for supported options.",
  );

const settings = {
  model: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "Model identifier advertised by agent_models; null selects the provider default.",
    ),
  reasoningEffort: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "A reasoning effort advertised by the selected model; null uses its default.",
    ),
  reasoningSummary: z
    .enum(["auto", "concise", "detailed", "none"])
    .nullable()
    .describe(
      "A reasoning summary value supported by the provider/model; null uses its default.",
    ),
  serviceTier: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "A service tier advertised by the selected model; null uses its default.",
    ),
  approvalPolicy,
  approvalsReviewer,
  permissionMode,
};

const tokenUsageBreakdown = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

const tokenUsage = z.object({
  total: tokenUsageBreakdown,
  last: tokenUsageBreakdown,
  modelContextWindow: z.number().nullable(),
});

const capabilities = z
  .object({
    namespaceTools: z.boolean(),
    imageGeneration: z.boolean(),
    webSearch: z.boolean(),
  })
  .catchall(z.boolean())
  .nullable();

const session = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  provider,
  ...settings,
  tokenUsage: tokenUsage.nullable(),
  status: z.enum(["idle", "running", "waiting_input", "error"]),
  attention: z
    .object({
      kind: z.enum(["approval", "input"]),
      count: z.number().int().positive(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const turn = z.object({
  id: z.string(),
  sessionId: z.string(),
  providerTurnId: z.string().nullable(),
  provider,
  ...settings,
  source: z.enum(["human", "mcp"]),
  status: z.enum(["running", "completed", "interrupted", "failed"]),
  usage: tokenUsageBreakdown.nullable(),
  error: z
    .object({
      message: z.string(),
      details: z.string().nullable(),
      providerData: z.unknown().nullable(),
    })
    .nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

const interactionResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval"),
    decision: z.string().min(1),
  }),
  z.object({
    type: z.literal("input"),
    answers: z.record(z.string(), z.array(z.string())),
  }),
]);

const interactionOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});

const itemBase = z.object({
  id: z.string(),
  turnId: z.string(),
  providerItemId: z.string().nullable(),
  sequence: z.number(),
  status: z.enum(["running", "completed", "waiting", "interrupted", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const item = z.discriminatedUnion("type", [
  itemBase.extend({
    type: z.literal("user_message"),
    source: z.enum(["human", "mcp"]).optional(),
    text: z.string(),
    attachments: z.array(attachment),
  }),
  itemBase.extend({
    type: z.literal("assistant_message"),
    text: z.string(),
    phase: z.enum(["commentary", "final_answer"]).nullable(),
  }),
  itemBase.extend({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.string().nullable(),
    output: z.string(),
    exitCode: z.number().nullable(),
  }),
  itemBase.extend({
    type: z.literal("tool"),
    progress: z.string().nullable(),
    name: z.string(),
    server: z.string().nullable(),
    input: z.unknown(),
    output: z.unknown(),
    error: z.string().nullable(),
  }),
  itemBase.extend({ type: z.literal("turn_diff"), diff: z.string() }),
  itemBase.extend({
    type: z.literal("file_change"),
    changes: z.array(
      z.object({
        path: z.string(),
        kind: z.string(),
        movePath: z.string().nullable(),
        diff: z.string(),
      }),
    ),
  }),
  itemBase.extend({
    type: z.literal("plan"),
    text: z.string(),
    steps: z.array(
      z.object({
        step: z.string(),
        status: z.enum(["pending", "inProgress", "completed"]),
      }),
    ),
  }),
  itemBase.extend({ type: z.literal("reasoning_summary"), text: z.string() }),
  itemBase.extend({
    type: z.literal("artifact"),
    artifact: attachment.extend({ kind: z.enum(["image", "file"]) }),
  }),
  itemBase.extend({
    type: z.literal("interaction"),
    interaction: z.object({
      kind: z.enum(["approval", "input"]),
      title: z.string(),
      description: z.string().nullable(),
      questions: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          question: z.string(),
          options: z.array(interactionOption),
          multiSelect: z.boolean(),
          allowFreeText: z.boolean(),
          secret: z.boolean(),
        }),
      ),
      approvalOptions: z.array(interactionOption),
      response: interactionResponse.nullable(),
    }),
  }),
  itemBase.extend({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    text: z.string(),
  }),
]);

function configurationPatch(input: {
  [Key in keyof AgentSessionConfig]?: AgentSessionConfig[Key] | undefined;
}): Partial<AgentSessionConfig> {
  const patch: Partial<AgentSessionConfig> = {};
  for (const key of [
    "model",
    "reasoningEffort",
    "reasoningSummary",
    "serviceTier",
    "approvalPolicy",
    "approvalsReviewer",
    "permissionMode",
  ] as const) {
    if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
  }
  return patch;
}

export function registerAgentTools(
  mcp: PluginMcpRegistrar,
  agents: AgentRuntime,
): void {
  mcp.registerTool(
    "agent_providers",
    {
      title: "List Agent providers",
      description:
        "List registered Agent providers, availability, authentication state, runtime version, declared features, provider capabilities, and exact provider-native permission settings. Capabilities are null when unavailable.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        providers: z.array(
          z.object({
            id: provider,
            displayName: z.string(),
            icon: z.string().nullable(),
            features: z
              .object({
                nativeReview: z.boolean(),
                steering: z.boolean(),
              })
              .catchall(z.boolean()),
            nativeSettings: z.array(
              z.object({
                id: z.enum([
                  "approvalPolicy",
                  "approvalsReviewer",
                  "permissionMode",
                ]),
                defaultValue: z.string(),
                options: z.array(
                  z.object({
                    id: z.string(),
                    description: z.string().nullable(),
                  }),
                ),
                granularFields: z.array(
                  z.object({
                    id: z.string(),
                    description: z.string().nullable(),
                  }),
                ),
              }),
            ),
            installed: z.boolean(),
            authenticated: z.boolean(),
            version: z.string().nullable(),
            error: z.string().nullable(),
            capabilities,
          }),
        ),
      }),
      annotations: closedRead,
      action: "providers",
    },
    async () => ({ providers: await agents.providerStatuses() }),
  );

  mcp.registerTool(
    "agent_provider_details",
    {
      title: "Read Agent provider details",
      description:
        "Read provider-owned configuration requirements and rate limits. Each field is nullable provider-owned JSON; null means unavailable.",
      inputSchema: z.object({ provider }),
      outputSchema: z.object({
        configRequirements: z.unknown().nullable(),
        rateLimits: z.unknown().nullable(),
        accountUsage: z
          .object({
            subscriptionType: z.string().nullable(),
            windows: z.array(
              z.object({
                id: z.string(),
                label: z.string().nullable(),
                utilization: z.number().nullable(),
                resetsAt: z.string().nullable(),
              }),
            ),
            extraUsage: z
              .object({
                enabled: z.boolean(),
                monthlyLimit: z.number().nullable(),
                usedCredits: z.number().nullable(),
                utilization: z.number().nullable(),
                currency: z.string().nullable(),
              })
              .nullable(),
            updatedAt: z.string(),
          })
          .nullable(),
      }),
      annotations: closedRead,
      action: "provider_details",
    },
    ({ provider }) => agents.providerDetails(provider),
  );

  mcp.registerTool(
    "agent_models",
    {
      title: "List Agent models",
      description:
        "List provider models with advertised reasoning efforts, input modalities, service tiers, defaults, and upgrade metadata. Select supported settings from this catalog and check agent_providers capabilities before configuring a session.",
      inputSchema: z.object({ provider }),
      outputSchema: z.object({
        models: z.array(
          z.object({
            id: z.string(),
            model: z.string(),
            displayName: z.string(),
            description: z.string(),
            modelSpecialty: z.string().nullable(),
            isDefault: z.boolean(),
            upgrade: z.string().nullable(),
            upgradeInfo: z.unknown().nullable(),
            availabilityMessage: z.string().nullable(),
            reasoningEfforts: z.array(
              z.object({ id: z.string(), description: z.string() }),
            ),
            defaultReasoningEffort: z.string().nullable(),
            reasoningSummaries: z.array(
              z.enum(["auto", "concise", "detailed", "none"]),
            ),
            defaultReasoningSummary: z
              .enum(["auto", "concise", "detailed", "none"])
              .nullable(),
            inputModalities: z.array(z.enum(["text", "image", "audio"])),
            multiAgentVersion: z.string().nullable(),
            serviceTiers: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                description: z.string(),
              }),
            ),
            defaultServiceTier: z.string().nullable(),
            availableAccessPrograms: z
              .object({
                cyber: z.array(z.string()),
              })
              .catchall(z.array(z.string()))
              .nullable(),
          }),
        ),
      }),
      annotations: closedRead,
      action: "models",
    },
    async ({ provider }) => ({ models: await agents.models(provider) }),
  );

  mcp.registerTool(
    "agent_sessions",
    {
      title: "List Agent sessions",
      description: "List ChatRoom Agent sessions shared by MCP and the Web UI.",
      inputSchema: z.object({}),
      outputSchema: z.object({ sessions: z.array(session) }),
      annotations: closedRead,
      action: "sessions",
    },
    () => ({ sessions: agents.listSessions() }),
  );

  mcp.registerTool(
    "agent_create",
    {
      title: "Create Agent session",
      description:
        "Create an Agent session for a ChatRoom workspace using a registered provider. Choose settings from agent_models and agent_providers capabilities; omitted or null settings use provider/model defaults.",
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        provider,
        model: settings.model.default(null),
        reasoningEffort: settings.reasoningEffort.default(null),
        reasoningSummary: settings.reasoningSummary.default(null),
        serviceTier: settings.serviceTier.default(null),
        approvalPolicy: settings.approvalPolicy.default(null),
        approvalsReviewer: settings.approvalsReviewer.default(null),
        permissionMode: settings.permissionMode.default(null),
      }),
      outputSchema: session,
      annotations: destructiveLocalMutation,
      action: "create",
    },
    (input) => agents.createSession(input),
  );

  mcp.registerTool(
    "agent_send",
    {
      title: "Send Agent instruction",
      description:
        "Send an instruction to an existing Agent session. The turn is recorded as source=mcp and appears in the same Web UI conversation as human turns. Returns after the turn is started; use agent_history to inspect progress.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        text: z.string().default(""),
        attachments: z.array(attachment).default([]),
        outputSchema: z
          .unknown()
          .nullable()
          .default(null)
          .describe(
            "Provider-supported JSON schema constraining the final response for this turn; omitted or null requests no output constraint.",
          ),
      }),
      outputSchema: turn,
      annotations: openWorldMutation,
      action: "send",
    },
    (input) =>
      agents.startTurn(
        input.sessionId,
        {
          text: input.text,
          attachments: input.attachments,
          outputSchema: input.outputSchema,
        },
        "mcp",
      ),
  );

  mcp.registerTool(
    "agent_steer",
    {
      title: "Steer active Agent turn",
      description:
        "Steer the currently active turn with text and attachments. Requires an active turn and accepts no configuration override. Use agent_history to inspect progress.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        text: z.string().default(""),
        attachments: z.array(attachment).default([]),
      }),
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: openWorldMutation,
      action: "steer",
    },
    async ({ sessionId, text, attachments }) => {
      await agents.steer(
        sessionId,
        {
          text,
          attachments,
        },
        "mcp",
      );
      return { ok: true as const };
    },
  );

  mcp.registerTool(
    "agent_review",
    {
      title: "Start Agent review",
      description:
        "Start an inline review in the existing Agent conversation for uncommitted changes, a base branch, a commit, or custom instructions. Uses the session settings and records source=mcp. Returns after the review turn starts; use agent_history to inspect progress.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        target: z.discriminatedUnion("type", [
          z.object({ type: z.literal("uncommittedChanges") }),
          z.object({ type: z.literal("baseBranch"), branch: z.string() }),
          z.object({
            type: z.literal("commit"),
            sha: z.string(),
            title: z.string().nullable(),
          }),
          z.object({ type: z.literal("custom"), instructions: z.string() }),
        ]),
      }),
      outputSchema: turn,
      annotations: openWorldMutation,
      action: "review",
    },
    ({ sessionId, target }) => agents.startReview(sessionId, target, "mcp"),
  );

  mcp.registerTool(
    "agent_history",
    {
      title: "Read Agent history",
      description:
        "Read one Agent conversation including human/MCP source, tool activity, file changes, artifacts, reasoning summaries, plans, and pending interactions with their offered approvalOptions.",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      outputSchema: z.object({
        session,
        turns: z.array(
          z.object({
            turn,
            items: z.array(item),
          }),
        ),
      }),
      annotations: closedRead,
      action: "history",
    },
    ({ sessionId }) => agents.history(sessionId),
  );

  mcp.registerTool(
    "agent_configure",
    {
      title: "Configure Agent session",
      description:
        "Atomically update model settings and provider-native permission settings for subsequent turns. Codex uses approvalPolicy, approvalsReviewer and permissionMode (sandbox). Omitted fields retain current values; null resets a field to its provider default. Read agent_providers for the exact native options.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        model: settings.model.optional(),
        reasoningEffort: settings.reasoningEffort.optional(),
        reasoningSummary: settings.reasoningSummary.optional(),
        serviceTier: settings.serviceTier.optional(),
        approvalPolicy: settings.approvalPolicy.optional(),
        approvalsReviewer: settings.approvalsReviewer.optional(),
        permissionMode: settings.permissionMode.optional(),
      }),
      outputSchema: session,
      annotations: destructiveLocalMutation,
      action: "configure",
    },
    ({ sessionId, ...patch }) =>
      agents.configureSession(sessionId, configurationPatch(patch)),
  );

  mcp.registerTool(
    "agent_respond",
    {
      title: "Respond to Agent interaction",
      description:
        "Answer a pending Agent approval or structured input request. For approval, read interaction.approvalOptions in agent_history and submit one offered option’s id as the decision string.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        itemId: z.string().min(1),
        response: interactionResponse,
      }),
      outputSchema: item,
      annotations: openWorldMutation,
      action: "respond",
    },
    ({ sessionId, itemId, response }) =>
      agents.respondInteraction(sessionId, itemId, response),
  );

  mcp.registerTool(
    "agent_interrupt",
    {
      title: "Interrupt Agent",
      description: "Interrupt the active turn of an Agent session.",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: destructiveLocalMutation,
      action: "interrupt",
    },
    async ({ sessionId }) => {
      await agents.interrupt(sessionId);
      return { ok: true as const };
    },
  );

  mcp.registerTool(
    "agent_switch_provider",
    {
      title: "Switch Agent provider",
      description:
        "Switch the active provider for the same Agent conversation, preserving visible history and synchronizing cross-provider context. Configure model settings from agent_models and provider-native permission settings from agent_providers. Omitted settings restore the target provider’s saved settings, or use defaults on its first activation; null resets a setting to its provider default. Returns the active target provider’s settings.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        provider,
        model: settings.model.optional(),
        reasoningEffort: settings.reasoningEffort.optional(),
        reasoningSummary: settings.reasoningSummary.optional(),
        serviceTier: settings.serviceTier.optional(),
        approvalPolicy: settings.approvalPolicy.optional(),
        approvalsReviewer: settings.approvalsReviewer.optional(),
        permissionMode: settings.permissionMode.optional(),
      }),
      outputSchema: session,
      annotations: destructiveLocalMutation,
      action: "switch_provider",
    },
    ({ sessionId, provider, ...patch }) =>
      agents.switchProvider(sessionId, provider, configurationPatch(patch)),
  );
}
