import type { LogWriter } from "#core/logging/types";
import { AsyncQueue } from "#plugins/agent/async-queue";
import type {
  AgentProvider,
  AgentProviderContext,
  ProviderEvent,
  ProviderItem,
  ProviderSession,
  ProviderTurnInput,
} from "#plugins/agent/provider";
import type {
  AgentInteractionOption,
  AgentInteractionResponse,
  AgentModel,
  AgentProviderProbe,
  AgentReviewTarget,
  AgentProviderStatus,
  AgentProviderDetails,
  CodexSandboxMode,
} from "#plugins/agent/types";
import {
  codexAccountUsage,
  codexInput,
  codexFileChanges,
  codexItem,
  codexItemFailed,
  codexQuestions,
  codexVersion,
  codexWarning,
  grantedPermissions,
  injectContinuity,
  injectWorkspacePrompt,
  reviewTarget,
  sessionConfig,
  standardApprovalChoices,
  stringOrNull,
  tokenUsage,
  turnError,
} from "./mapping.js";
import {
  CodexRpcClient,
  type CodexNotification,
  type CodexRequestId,
  type CodexServerRequest,
  type CodexMcpConnection,
} from "./rpc.js";
import {
  array,
  record,
  stringifyOptional,
  errorMessage,
  providerError,
  isMissingExecutable,
} from "../common.js";

interface ThreadResponse {
  thread: { id: string };
}

interface TurnResponse {
  turn: { id: string };
}

// Wire fields from Codex 0.159.3 model/list; deprecated fields are omitted.
interface ModelListResponse {
  data: Array<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    modelSpecialty: string | null;
    hidden: boolean;
    isDefault: boolean;
    upgrade: string | null;
    upgradeInfo: AgentModel["upgradeInfo"];
    availabilityNux: { message: string } | null;
    supportedReasoningEfforts: {
      reasoningEffort: string;
      description: string;
    }[];
    defaultReasoningEffort: string;
    inputModalities: AgentModel["inputModalities"];
    multiAgentVersion: AgentModel["multiAgentVersion"];
    serviceTiers: AgentModel["serviceTiers"];
    defaultServiceTier: string | null;
    availableAccessPrograms: AgentModel["availableAccessPrograms"];
  }>;
  nextCursor: string | null;
}

type SessionConfig = Parameters<ProviderSession["configure"]>[0];
type ApprovalChoice = AgentInteractionOption & { result: unknown };

function codexSandbox(
  value: SessionConfig["permissionMode"],
): CodexSandboxMode {
  if (value === null) return "workspace-write";
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  )
    return value;
  throw new Error("Unsupported Codex sandbox: " + value);
}

interface AccountResponse {
  account: unknown | null;
  requiresOpenaiAuth: boolean;
}

export class CodexProvider implements AgentProvider {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly icon = "openai";
  readonly features = { nativeReview: true, steering: true } as const;
  readonly nativeSettings = [
    {
      id: "approvalPolicy",
      defaultValue: "on-request",
      options: [
        {
          id: "untrusted",
          description:
            "Ask for approval before running commands outside the trusted set.",
        },
        {
          id: "on-request",
          description:
            "Let Codex request approval when it decides escalation is needed.",
        },
        {
          id: "granular",
          description: "Control individual Codex approval categories.",
        },
        {
          id: "never",
          description:
            "Never ask for approval; disallowed operations fail instead.",
        },
      ],
      granularFields: [
        { id: "sandbox_approval", description: "Sandbox approval requests." },
        { id: "rules", description: "Rule-based approval requests." },
        { id: "skill_approval", description: "Skill approval requests." },
        {
          id: "request_permissions",
          description: "Additional permission requests.",
        },
        { id: "mcp_elicitations", description: "MCP elicitation requests." },
      ],
    },
    {
      id: "permissionMode",
      defaultValue: "workspace-write",
      options: [
        {
          id: "read-only",
          description: "Read-only sandbox; changes require approval.",
        },
        {
          id: "workspace-write",
          description: "Allow workspace writes within the sandbox.",
        },
        {
          id: "danger-full-access",
          description:
            "Disable the sandbox; commands can access files and the network outside the workspace.",
        },
      ],
      granularFields: [],
    },
    {
      id: "approvalsReviewer",
      defaultValue: "user",
      options: [
        { id: "user", description: "Route approval requests to the user." },
        {
          id: "auto_review",
          description:
            "Use Codex auto review to approve or deny requests with a risk-based subagent.",
        },
        {
          id: "guardian_subagent",
          description:
            "Route approval requests to the Codex guardian subagent.",
        },
      ],
      granularFields: [],
    },
  ] as const;
  private readonly client: CodexRpcClient;
  private readonly modelNames = new Map<string, string>();

  constructor(
    private readonly logs: LogWriter,
    mcpConnection: CodexMcpConnection = {
      url: "http://127.0.0.1:1/mcp",
      token: "test-only-token",
    },
  ) {
    this.client = new CodexRpcClient(logs, mcpConnection);
  }

  async probe(): Promise<AgentProviderProbe> {
    try {
      const initialized = await this.client.ensureStarted();
      const account = await this.client.request<AccountResponse>(
        "account/read",
        {
          refreshToken: false,
        },
      );
      const capabilities = await this.client
        .request<NonNullable<AgentProviderStatus["capabilities"]>>(
          "modelProvider/capabilities/read",
          {},
        )
        .catch(() => null);
      return {
        capabilities,
        installed: true,
        authenticated: Boolean(account.account) || !account.requiresOpenaiAuth,
        version: codexVersion(initialized.userAgent),
        error: null,
      };
    } catch (error) {
      return {
        capabilities: null,
        installed: !isMissingExecutable(error),
        authenticated: false,
        version: null,
        error: errorMessage(error),
      };
    }
  }

  async details(): Promise<AgentProviderDetails> {
    const [requirements, rateLimits] = await Promise.allSettled([
      this.client.request<{
        requirements: AgentProviderDetails["configRequirements"];
      }>("configRequirements/read"),
      this.client.request<AgentProviderDetails["rateLimits"]>(
        "account/rateLimits/read",
      ),
    ]);
    const rawRateLimits =
      rateLimits.status === "fulfilled" ? rateLimits.value : null;
    return {
      configRequirements:
        requirements.status === "fulfilled"
          ? requirements.value.requirements
          : null,
      rateLimits: rawRateLimits,
      accountUsage: codexAccountUsage(rawRateLimits),
    };
  }

  async listModels(): Promise<AgentModel[]> {
    const output: AgentModel[] = [];
    let cursor: string | null = null;
    do {
      const response: ModelListResponse =
        await this.client.request<ModelListResponse>("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        });
      for (const model of response.data) {
        if (model.hidden) continue;
        this.modelNames.set(model.id, model.model);
        output.push({
          id: model.id,
          model: model.model,
          modelSpecialty: model.modelSpecialty,
          upgrade: model.upgrade,
          upgradeInfo: model.upgradeInfo,
          availabilityMessage: model.availabilityNux?.message ?? null,
          reasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
            id: effort.reasoningEffort,
            description: effort.description,
          })),
          defaultReasoningEffort: model.defaultReasoningEffort,
          reasoningSummaries: ["auto", "concise", "detailed", "none"],
          defaultReasoningSummary: null,
          inputModalities: model.inputModalities,
          multiAgentVersion: model.multiAgentVersion,
          serviceTiers: model.serviceTiers,
          defaultServiceTier: model.defaultServiceTier,
          availableAccessPrograms: model.availableAccessPrograms,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.isDefault,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
    return output;
  }

  async createSession(context: AgentProviderContext): Promise<ProviderSession> {
    const model = await this.resolveModel(context.model);
    const response = await this.client.request<ThreadResponse>("thread/start", {
      cwd: context.workspaceRoot,
      model,
      serviceTier: context.serviceTier,
      approvalPolicy: context.approvalPolicy ?? "on-request",
      approvalsReviewer: context.approvalsReviewer ?? "user",
      sandbox: codexSandbox(context.permissionMode),
    });
    await injectWorkspacePrompt(
      this.client,
      response.thread.id,
      context.workspacePrompt,
    );
    await injectContinuity(
      this.client,
      response.thread.id,
      context.continuityDelta,
    );
    const session = new CodexSession(
      this.client,
      response.thread.id,
      context.workspaceRoot,
      sessionConfig(context),
      (modelId) => this.resolveModel(modelId),
      this.logs,
    );
    await session.configure(sessionConfig(context));
    return session;
  }

  async resumeSession(
    context: AgentProviderContext,
    providerSessionId: string,
  ): Promise<ProviderSession> {
    const model = await this.resolveModel(context.model);
    await this.client.request<ThreadResponse>("thread/resume", {
      threadId: providerSessionId,
      cwd: context.workspaceRoot,
      model,
      serviceTier: context.serviceTier,
      approvalPolicy: context.approvalPolicy ?? "on-request",
      approvalsReviewer: context.approvalsReviewer ?? "user",
      sandbox: codexSandbox(context.permissionMode),
      excludeTurns: true,
    });
    await injectContinuity(
      this.client,
      providerSessionId,
      context.continuityDelta,
    );
    const session = new CodexSession(
      this.client,
      providerSessionId,
      context.workspaceRoot,
      sessionConfig(context),
      (modelId) => this.resolveModel(modelId),
      this.logs,
    );
    await session.configure(sessionConfig(context));
    return session;
  }

  private async resolveModel(modelId: string | null): Promise<string | null> {
    if (modelId === null) return null;
    const cached = this.modelNames.get(modelId);
    if (cached) return cached;
    const models = await this.listModels();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("Unknown Codex model: " + modelId);
    return model.model;
  }

  async refreshMcpServers(): Promise<void> {
    await this.client.reloadMcpConfiguration();
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

class CodexSession implements ProviderSession {
  private readonly pendingInteractions = new Map<
    string,
    | { requestId: CodexRequestId; kind: "input" }
    | {
        requestId: CodexRequestId;
        kind: "approval";
        choices: Map<string, unknown>;
      }
  >();
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRequest: () => void;
  private readonly unsubscribeTransportClose: () => void;
  private queue: AsyncQueue<ProviderEvent> | null = null;
  private activeTurnId: string | null = null;
  private needsResume = false;
  private noticeSequence = 0;
  private readonly toolItems = new Map<
    string,
    Extract<ProviderItem, { type: "tool" }>
  >();
  private turnDiff: {
    id: string;
    item: Extract<ProviderItem, { type: "turn_diff" }>;
  } | null = null;
  private turnPlan: {
    id: string;
    item: Extract<ProviderItem, { type: "plan" }>;
  } | null = null;

  constructor(
    private readonly client: CodexRpcClient,
    readonly providerSessionId: string,
    private readonly workspaceRoot: string,
    private config: SessionConfig,
    private readonly resolveModel: (
      modelId: string | null,
    ) => Promise<string | null>,
    private readonly logs: LogWriter,
  ) {
    this.unsubscribeNotification = client.onNotification((notification) =>
      this.onNotification(notification),
    );
    this.unsubscribeRequest = client.onServerRequest((request) =>
      this.onServerRequest(request),
    );
    this.unsubscribeTransportClose = client.onTransportClose((error) =>
      this.onTransportClose(error),
    );
  }

  runTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    if (this.queue) throw new Error("Codex session already has an active turn");
    const queue = new AsyncQueue<ProviderEvent>();
    this.queue = queue;
    void this.startTurn(input, queue);
    return queue;
  }

  async steer(
    input: Pick<ProviderTurnInput, "text" | "attachments">,
  ): Promise<void> {
    if (!this.queue || !this.activeTurnId)
      throw new Error("Codex session has no active turn to steer");
    await this.client.request<{ turnId: string }>("turn/steer", {
      threadId: this.providerSessionId,
      expectedTurnId: this.activeTurnId,
      input: codexInput(input, this.workspaceRoot),
    });
  }

  runReview(target: AgentReviewTarget): AsyncIterable<ProviderEvent> {
    if (this.queue) throw new Error("Codex session already has an active turn");
    const queue = new AsyncQueue<ProviderEvent>();
    this.queue = queue;
    void this.startReview(target, queue);
    return queue;
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId) return;
    await this.client.request(
      "turn/interrupt",
      {
        threadId: this.providerSessionId,
        turnId: this.activeTurnId,
      },
      5_000,
    );
  }

  async configure(config: SessionConfig): Promise<void> {
    const permissionsChanged =
      JSON.stringify(this.config.approvalPolicy) !==
        JSON.stringify(config.approvalPolicy) ||
      this.config.approvalsReviewer !== config.approvalsReviewer ||
      this.config.permissionMode !== config.permissionMode;
    this.config = { ...config };
    if (permissionsChanged) this.needsResume = true;
  }

  async resolveInteraction(
    interactionId: string,
    response: AgentInteractionResponse,
  ): Promise<void> {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending)
      throw new Error("Unknown Codex interaction: " + interactionId);
    if (pending.kind === "input") {
      if (response.type !== "input")
        throw new Error("Codex interaction requires input answers");
      const answers: Record<string, { answers: string[] }> = {};
      for (const [id, values] of Object.entries(response.answers))
        answers[id] = { answers: values };
      this.client.respond(pending.requestId, { answers });
      this.pendingInteractions.delete(interactionId);
      return;
    }

    if (response.type !== "approval")
      throw new Error("Codex interaction requires an approval decision");
    if (!pending.choices.has(response.decision))
      throw new Error("Unknown Codex approval option: " + response.decision);
    this.client.respond(
      pending.requestId,
      pending.choices.get(response.decision),
    );
    this.pendingInteractions.delete(interactionId);
  }

  async close(): Promise<void> {
    this.unsubscribeNotification();
    this.unsubscribeRequest();
    this.unsubscribeTransportClose();
    if (this.activeTurnId) {
      await this.interrupt().catch(() => undefined);
    }
    if (this.queue) this.completeTurnItems(this.queue);
    this.queue?.close();
    this.queue = null;
    this.activeTurnId = null;
    this.pendingInteractions.clear();
  }

  private async startTurn(
    input: ProviderTurnInput,
    queue: AsyncQueue<ProviderEvent>,
  ): Promise<void> {
    const config = { ...this.config };
    try {
      await this.resumeIfNeeded(config);
      const response = await this.client.request<TurnResponse>("turn/start", {
        threadId: this.providerSessionId,
        input: codexInput(input, this.workspaceRoot),
        outputSchema: input.outputSchema,
        cwd: this.workspaceRoot,
        approvalPolicy: config.approvalPolicy ?? "on-request",
        approvalsReviewer: config.approvalsReviewer ?? "user",
        model: await this.resolveModel(config.model),
        serviceTier: config.serviceTier,
        effort: config.reasoningEffort,
        summary: config.reasoningSummary,
      });
      if (this.queue === queue && !this.activeTurnId) {
        this.activeTurnId = response.turn.id;
        queue.push({
          type: "turn.started",
          providerTurnId: response.turn.id,
        });
      }
    } catch (error) {
      if (this.queue === queue) {
        this.completeTurnItems(queue);
        queue.push({
          type: "turn.completed",
          status: "failed",
          error: providerError(error),
        });
        queue.close();
        this.queue = null;
        this.activeTurnId = null;
        this.pendingInteractions.clear();
      }
    }
  }

  private async resumeIfNeeded(config: SessionConfig): Promise<void> {
    if (!this.needsResume) return;
    await this.client.request<ThreadResponse>("thread/resume", {
      threadId: this.providerSessionId,
      cwd: this.workspaceRoot,
      model: await this.resolveModel(config.model),
      serviceTier: config.serviceTier,
      approvalPolicy: config.approvalPolicy ?? "on-request",
      approvalsReviewer: config.approvalsReviewer ?? "user",
      sandbox: codexSandbox(config.permissionMode),
      excludeTurns: true,
    });
    this.needsResume = false;
  }

  private async startReview(
    target: AgentReviewTarget,
    queue: AsyncQueue<ProviderEvent>,
  ): Promise<void> {
    try {
      await this.resumeIfNeeded({ ...this.config });
      const response = await this.client.request<TurnResponse>("review/start", {
        threadId: this.providerSessionId,
        target: reviewTarget(target),
        delivery: "inline",
      });
      if (this.queue === queue && !this.activeTurnId) {
        this.activeTurnId = response.turn.id;
        queue.push({ type: "turn.started", providerTurnId: response.turn.id });
      }
    } catch (error) {
      if (this.queue !== queue) return;
      this.completeTurnItems(queue);
      queue.push({
        type: "turn.completed",
        status: "failed",
        error: providerError(error),
      });
      queue.close();
      this.queue = null;
      this.activeTurnId = null;
      this.pendingInteractions.clear();
    }
  }

  private onTransportClose(error: Error): void {
    this.needsResume = true;
    const queue = this.queue;
    if (!queue) return;
    this.completeTurnItems(queue);
    queue.push({
      type: "turn.completed",
      status: "failed",
      error: providerError(error),
    });
    queue.close();
    this.queue = null;
    this.activeTurnId = null;
    this.pendingInteractions.clear();
  }

  private onNotification(notification: CodexNotification): void {
    const params = record(notification.params);
    if (!params) return;
    // Summary parts carry no text. Raw reasoning is never exposed.
    if (
      notification.method === "item/reasoning/textDelta" ||
      notification.method === "item/reasoning/summaryPartAdded"
    )
      return;
    const warning = codexWarning(notification.method, params);
    if (warning !== null) {
      const global =
        notification.method === "configWarning" ||
        notification.method === "deprecationNotice" ||
        (notification.method === "warning" && params.threadId === null);
      if (global) return;
      if (params.threadId !== this.providerSessionId) return;
      this.logs.warn("agent.codex", "codex." + notification.method, warning, {
        threadId: this.providerSessionId,
      });
      this.emitNotice("warning", warning);
      return;
    }
    if (params.threadId !== this.providerSessionId) return;
    if (notification.method === "serverRequest/resolved") {
      if (
        typeof params.requestId !== "string" &&
        typeof params.requestId !== "number"
      )
        return;
      const interactionId = String(params.requestId);
      this.pendingInteractions.delete(interactionId);
      this.queue?.push({
        type: "interaction.resolved",
        providerRequestId: interactionId,
      });
      return;
    }
    if (notification.method === "error") {
      const error = turnError(params.error);
      if (!error) return;
      this.logs.warn("agent.codex", "codex.error", error.message, {
        threadId: this.providerSessionId,
        error,
        willRetry: params.willRetry === true,
      });
      this.emitNotice(
        params.willRetry === true ? "warning" : "error",
        [error.message, error.details].filter(Boolean).join("\n"),
      );
      return;
    }
    const queue = this.queue;
    if (!queue) return;

    if (notification.method === "turn/diff/updated") {
      if (typeof params.turnId !== "string" || typeof params.diff !== "string")
        return;
      const id = "turn-diff:" + params.turnId;
      const item: Extract<ProviderItem, { type: "turn_diff" }> = {
        type: "turn_diff",
        diff: params.diff,
      };
      if (this.turnDiff && this.turnDiff.id !== id) this.completeDiff(queue);
      queue.push({
        type: this.turnDiff ? "item.updated" : "item.started",
        providerItemId: id,
        item,
      });
      this.turnDiff = { id, item };
      return;
    }

    if (notification.method === "item/mcpToolCall/progress") {
      if (
        typeof params.itemId !== "string" ||
        typeof params.message !== "string"
      )
        return;
      const previous = this.toolItems.get(params.itemId);
      if (!previous) return;
      const item = { ...previous, progress: params.message };
      this.toolItems.set(params.itemId, item);
      queue.push({ type: "item.updated", providerItemId: params.itemId, item });
      return;
    }

    if (notification.method === "item/reasoning/summaryTextDelta") {
      if (typeof params.itemId === "string" && typeof params.delta === "string")
        queue.push({
          type: "item.delta",
          providerItemId: params.itemId,
          field: "text",
          delta: params.delta,
        });
      return;
    }

    if (notification.method === "turn/plan/updated") {
      if (typeof params.turnId !== "string") return;
      const id = "turn-plan:" + params.turnId;
      const item: Extract<ProviderItem, { type: "plan" }> = {
        type: "plan",
        text: stringOrNull(params.explanation) ?? "",
        steps: array(params.plan).flatMap((value) => {
          const step = record(value);
          if (
            !step ||
            typeof step.step !== "string" ||
            (step.status !== "pending" &&
              step.status !== "inProgress" &&
              step.status !== "completed")
          )
            return [];
          return [{ step: step.step, status: step.status }];
        }),
      };
      if (this.turnPlan && this.turnPlan.id !== id) this.completePlan(queue);
      queue.push({
        type: this.turnPlan ? "item.updated" : "item.started",
        providerItemId: id,
        item,
      });
      this.turnPlan = { id, item };
      return;
    }

    if (notification.method === "item/fileChange/patchUpdated") {
      if (typeof params.itemId === "string")
        queue.push({
          type: "item.updated",
          providerItemId: params.itemId,
          item: {
            type: "file_change",
            changes: codexFileChanges(params.changes),
          },
        });
      return;
    }

    if (notification.method === "thread/tokenUsage/updated") {
      const usage = tokenUsage(params.tokenUsage);
      if (usage) queue.push({ type: "token.usage", usage });
      return;
    }

    if (notification.method === "model/rerouted") {
      if (
        typeof params.fromModel === "string" &&
        typeof params.toModel === "string" &&
        params.reason === "highRiskCyberActivity"
      )
        queue.push({
          type: "model.rerouted",
          fromModel: params.fromModel,
          toModel: params.toModel,
          reason: params.reason,
        });
      return;
    }

    if (notification.method === "turn/started") {
      const turn = record(params.turn);
      if (turn && typeof turn.id === "string") {
        this.activeTurnId = turn.id;
        queue.push({ type: "turn.started", providerTurnId: turn.id });
      }
      return;
    }

    if (notification.method === "item/started") {
      const item = record(params.item);
      const converted = item ? codexItem(item, this.workspaceRoot) : null;
      if (converted?.type === "tool" && typeof item?.id === "string")
        this.toolItems.set(item.id, converted);
      if (converted && typeof item?.id === "string")
        queue.push({
          type: "item.started",
          providerItemId: item.id,
          item: converted,
        });
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      if (typeof params.itemId === "string" && typeof params.delta === "string")
        queue.push({
          type: "item.delta",
          providerItemId: params.itemId,
          field: "text",
          delta: params.delta,
        });
      return;
    }

    if (notification.method === "item/plan/delta") {
      if (typeof params.itemId === "string" && typeof params.delta === "string")
        queue.push({
          type: "item.delta",
          providerItemId: params.itemId,
          field: "text",
          delta: params.delta,
        });
      return;
    }

    if (notification.method === "item/commandExecution/outputDelta") {
      if (typeof params.itemId === "string" && typeof params.delta === "string")
        queue.push({
          type: "item.delta",
          providerItemId: params.itemId,
          field: "output",
          delta: params.delta,
        });
      return;
    }

    if (notification.method === "item/completed") {
      const item = record(params.item);
      const converted = item ? codexItem(item, this.workspaceRoot) : null;
      if (typeof item?.id === "string") this.toolItems.delete(item.id);
      if (converted && typeof item?.id === "string")
        queue.push({
          type: "item.completed",
          providerItemId: item.id,
          item: converted,
          failed: codexItemFailed(item),
        });
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = record(params.turn);
      const status = typeof turn?.status === "string" ? turn.status : "";
      this.completeTurnItems(queue);
      queue.push({
        type: "turn.completed",
        status:
          status === "interrupted"
            ? "interrupted"
            : status === "failed"
              ? "failed"
              : "completed",
        error: turnError(turn?.error),
      });
      queue.close();
      this.queue = null;
      this.activeTurnId = null;
      this.pendingInteractions.clear();
      return;
    }
  }

  private emitNotice(level: "warning" | "error", text: string): void {
    this.queue?.push({
      type: "item.completed",
      providerItemId: "notice:" + ++this.noticeSequence,
      item: { type: "notice", level, text },
    });
  }

  private completeDiff(queue: AsyncQueue<ProviderEvent>): void {
    if (!this.turnDiff) return;
    queue.push({
      type: "item.completed",
      providerItemId: this.turnDiff.id,
      item: this.turnDiff.item,
    });
    this.turnDiff = null;
  }

  private completeTurnItems(queue: AsyncQueue<ProviderEvent>): void {
    this.completePlan(queue);
    this.completeDiff(queue);
    this.toolItems.clear();
  }

  private completePlan(queue: AsyncQueue<ProviderEvent>): void {
    if (!this.turnPlan) return;
    queue.push({
      type: "item.completed",
      providerItemId: this.turnPlan.id,
      item: this.turnPlan.item,
    });
    this.turnPlan = null;
  }

  private requestApproval(
    request: CodexServerRequest,
    title: string,
    description: string | null,
    choices: ApprovalChoice[],
  ): void {
    const id = String(request.id);
    this.pendingInteractions.set(id, {
      requestId: request.id,
      kind: "approval",
      choices: new Map(choices.map((choice) => [choice.id, choice.result])),
    });
    this.queue?.push({
      type: "interaction.requested",
      providerItemId: "interaction:" + id,
      interaction: {
        id,
        kind: "approval",
        title,
        description,
        questions: [],
        approvalOptions: choices.map(({ id, label, description }) => ({
          id,
          label,
          description,
        })),
      },
    });
  }

  private onServerRequest(request: CodexServerRequest): void {
    const params = record(request.params);
    if (!params || params.threadId !== this.providerSessionId) return;
    if (!this.queue) {
      this.client.respondError(request.id, -32000, "No active ChatRoom turn");
      return;
    }
    const interactionId = String(request.id);

    if (request.method === "item/commandExecution/requestApproval") {
      const choices = standardApprovalChoices();
      const amendment = params.proposedExecpolicyAmendment;
      if (
        Array.isArray(amendment) &&
        amendment.every((part) => typeof part === "string")
      )
        choices.push({
          id: "acceptWithExecpolicyAmendment",
          label: "Allow similar commands",
          description: stringifyOptional(amendment),
          result: {
            decision: {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: amendment,
              },
            },
          },
        });
      array(params.proposedNetworkPolicyAmendments).forEach((value, index) => {
        const amendment = record(value);
        if (
          !amendment ||
          typeof amendment.host !== "string" ||
          (amendment.action !== "allow" && amendment.action !== "deny")
        )
          return;
        choices.push({
          id: "applyNetworkPolicyAmendment:" + index,
          label:
            (amendment.action === "allow" ? "Allow " : "Deny ") +
            amendment.host,
          description: "Apply this network policy to future requests",
          result: {
            decision: {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: amendment.host,
                  action: amendment.action,
                },
              },
            },
          },
        });
      });
      this.requestApproval(
        request,
        "Approve command",
        stringOrNull(params.command) ?? stringOrNull(params.reason),
        choices,
      );
      return;
    }

    if (request.method === "item/fileChange/requestApproval") {
      this.requestApproval(
        request,
        "Approve file changes",
        stringOrNull(params.reason),
        standardApprovalChoices(),
      );
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      this.pendingInteractions.set(interactionId, {
        requestId: request.id,
        kind: "input",
      });
      this.queue.push({
        type: "interaction.requested",
        providerItemId: "interaction:" + interactionId,
        interaction: {
          id: interactionId,
          kind: "input",
          title: "Input required",
          description: null,
          questions: codexQuestions(params.questions),
          approvalOptions: [],
        },
      });
      return;
    }

    if (request.method === "item/permissions/requestApproval") {
      const permissions = grantedPermissions(record(params.permissions) ?? {});
      this.requestApproval(
        request,
        "Approve additional permissions",
        stringOrNull(params.reason) ?? stringifyOptional(permissions),
        [
          {
            id: "accept",
            label: "Allow for this turn",
            description: null,
            result: { permissions, scope: "turn" },
          },
          {
            id: "acceptForSession",
            label: "Allow for this session",
            description: null,
            result: { permissions, scope: "session" },
          },
          {
            id: "strictAutoReview",
            label: "Allow with strict turn review",
            description: "Review every subsequent command in this turn",
            result: { permissions, scope: "turn", strictAutoReview: true },
          },
          {
            id: "decline",
            label: "Deny",
            description: null,
            result: { permissions: {}, scope: "turn" },
          },
        ],
      );
      return;
    }

    this.client.respondError(
      request.id,
      -32601,
      "ChatRoom does not support this Codex server request",
    );
  }
}
