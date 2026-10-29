import { randomUUID } from "node:crypto";
import { ChatRoomError } from "#core/errors/chatroom-error";
import { HeadTailBuffer } from "#core/runtime/head-tail-buffer";
import type { RuntimeEventBus } from "#app/event-bus";
import type { WorkspaceAccess } from "#app/workspace-access";
import type {
  AgentProvider,
  AgentProviderContext,
  ProviderEvent,
  ProviderSession,
} from "./provider.js";
import type { AgentStore } from "./store.js";
import {
  approvalPolicySupported,
  copyAgentSessionConfig,
  emptyAgentSessionConfig,
  validateReviewTarget,
} from "./runtime-config.js";
import {
  cleanupOrphanAttachments as cleanupOrphanAttachmentFiles,
  cleanupSessionFiles,
  prepareProviderItem,
  validateAttachments,
} from "./runtime-files.js";
import {
  applyItemDelta,
  buildContinuityDelta,
  materializeInteraction,
  materializeProviderItem,
  mergeContinuityContext,
  nextSessionUpdatedAt,
  structuredError,
} from "./runtime-state.js";
import { isAgentProviderId, isAgentPermissionMode } from "./types.js";
import type {
  AgentError,
  AgentSessionConfig,
  AgentHistory,
  AgentHistoryUpdate,
  AgentInteractionResponse,
  AgentItem,
  AgentModel,
  AgentProviderId,
  AgentProviderSessionState,
  AgentProviderStatus,
  AgentProviderDetails,
  AgentReviewTarget,
  AgentSession,
  AgentTurn,
  AgentTurnInput,
  AgentTurnSource,
  CreateAgentSessionInput,
} from "./types.js";

interface ActiveTurn {
  turn: AgentTurn;
  providerSession: ProviderSession;
  items: Map<string, AgentItem>;
  commandOutputs: Map<string, HeadTailBuffer>;
  interactions: Map<string, string>;
  respondingInteractions: Set<string>;
  nextSequence: number;
}

interface AgentInvalidation {
  turnIds?: readonly string[];
  itemIds?: readonly string[];
  deleted?: boolean;
}

interface PendingAgentInvalidation {
  timer: ReturnType<typeof setTimeout>;
  turnIds: Set<string>;
  itemIds: Set<string>;
  persistedItems: Map<string, AgentItem>;
  deleted: boolean;
}

const AGENT_COMMAND_OUTPUT_LIMIT_BYTES = 512 * 1024;

export class AgentRuntime {
  private readonly providerSessions = new Map<string, ProviderSession>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly sessionMutations = new Set<string>();
  private readonly deltaInvalidations = new Map<
    string,
    PendingAgentInvalidation
  >();
  private closed = false;
  private readonly providers: Map<AgentProviderId, AgentProvider>;

  constructor(
    private readonly store: AgentStore,
    private readonly workspaces: WorkspaceAccess,
    private readonly events: RuntimeEventBus,
    providers: AgentProvider[],
  ) {
    this.providers = new Map();
    for (const provider of providers) {
      if (!isAgentProviderId(provider.id))
        throw new Error("Invalid Agent provider id: " + provider.id);
      if (this.providers.has(provider.id))
        throw new Error("Duplicate Agent provider id: " + provider.id);
      this.providers.set(provider.id, provider);
    }
    this.store.reconcileInterrupted(new Date().toISOString());
  }

  async refreshMcpServers(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.providers.values()].map((provider) =>
        provider.refreshMcpServers?.(),
      ),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Failed to refresh MCP servers for one or more Agent providers",
      );
  }

  async providerStatuses(): Promise<AgentProviderStatus[]> {
    return Promise.all(
      [...this.providers.values()].map(async (provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        icon: provider.icon,
        features: provider.features,
        nativeSettings: provider.nativeSettings,
        ...(await provider.probe()),
      })),
    );
  }

  async providerDetails(
    providerId: AgentProviderId,
  ): Promise<AgentProviderDetails> {
    return this.requireProvider(providerId).details();
  }

  async models(providerId: AgentProviderId): Promise<AgentModel[]> {
    return this.requireProvider(providerId).listModels();
  }

  listSessions(): AgentSession[] {
    return this.store.listSessions();
  }

  getSession(sessionId: string): AgentSession {
    return this.requireSession(sessionId);
  }

  history(sessionId: string): AgentHistory {
    this.persistPendingSession(sessionId);
    const history = this.store.history(sessionId);
    if (!history)
      throw new ChatRoomError(
        "NOT_FOUND",
        "Unknown Agent session: " + sessionId,
      );
    return history;
  }

  historyUpdate(
    sessionId: string,
    turnIds: readonly string[],
    itemIds: readonly string[],
  ): AgentHistoryUpdate {
    this.persistPendingSession(sessionId);
    const update = this.store.historyUpdate(sessionId, turnIds, itemIds);
    if (!update)
      throw new ChatRoomError(
        "NOT_FOUND",
        "Unknown Agent session: " + sessionId,
      );
    return update;
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const workspace = await this.workspaces.info(input.workspaceRoot);
    const workspaceRoot = workspace.root;
    const provider = this.requireProvider(input.provider);
    const providerStatus = await provider.probe();
    if (!providerStatus.installed)
      throw new ChatRoomError(
        "UNSUPPORTED",
        input.provider + " is not installed",
      );
    if (!providerStatus.authenticated)
      throw new ChatRoomError(
        "FORBIDDEN",
        input.provider + " is not authenticated",
        providerStatus.error ? { error: providerStatus.error } : undefined,
      );
    const config = await this.validateConfig(
      provider,
      emptyAgentSessionConfig(),
      input,
    );
    const context: AgentProviderContext = {
      workspaceRoot,
      workspacePrompt: workspace.presetPrompt,
      ...config,
      continuityContext: null,
      continuityDelta: null,
    };
    const providerSession = await provider.createSession(context);
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: "agent_" + randomUUID(),
      workspaceRoot,
      provider: input.provider,
      ...config,
      tokenUsage: null,
      status: "idle",
      attention: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSession(session);
    this.store.upsertProviderState({
      sessionId: session.id,
      provider: session.provider,
      providerSessionId: providerSession.providerSessionId,
      ...copyAgentSessionConfig(session),
      tokenUsage: null,
      continuityContext: "",
      syncedThroughTurnId: null,
      createdAt: now,
      updatedAt: now,
    });
    this.providerSessions.set(session.id, providerSession);
    this.invalidateSession(session.id);
    return session;
  }

  async startTurn(
    sessionId: string,
    input: AgentTurnInput,
    source: AgentTurnSource,
  ): Promise<AgentTurn> {
    return this.withSessionMutation(sessionId, () =>
      this.startTurnUnlocked(sessionId, input, source),
    );
  }

  private async startTurnUnlocked(
    sessionId: string,
    input: AgentTurnInput,
    source: AgentTurnSource,
  ): Promise<AgentTurn> {
    const session = this.requireSession(sessionId);
    if (this.activeTurns.has(sessionId) || session.status === "running")
      throw new ChatRoomError(
        "CONFLICT",
        "Agent session already has an active turn",
      );
    const text = input.text.trim();
    if (!text && input.attachments.length === 0)
      throw new ChatRoomError("INVALID_INPUT", "Agent message is empty");
    const attachments = await validateAttachments(session, input.attachments);
    await this.validateInputModalities(session, text, attachments);
    const providerSession = await this.providerSession(session);
    const active = this.beginTurn(
      session,
      providerSession,
      source,
      session.serviceTier,
      { text, attachments },
    );
    void this.executeTurn(session, active, () =>
      providerSession.runTurn({
        text,
        attachments,
        outputSchema: input.outputSchema ?? null,
      }),
    );
    return active.turn;
  }

  async startReview(
    sessionId: string,
    target: AgentReviewTarget,
    source: AgentTurnSource,
  ): Promise<AgentTurn> {
    return this.withSessionMutation(sessionId, async () => {
      const session = this.requireSession(sessionId);
      if (this.activeTurns.has(sessionId) || session.status === "running")
        throw new ChatRoomError(
          "CONFLICT",
          "Agent session already has an active turn",
        );
      const provider = this.requireProvider(session.provider);
      if (!provider.features.nativeReview)
        throw new ChatRoomError(
          "UNSUPPORTED",
          session.provider + " does not support native review turns",
        );
      validateReviewTarget(target);
      const providerSession = await this.providerSession(session);
      if (!providerSession.runReview)
        throw new ChatRoomError(
          "INTERNAL",
          session.provider + " declares native review without implementing it",
        );
      const runReview = providerSession.runReview.bind(providerSession);
      const active = this.beginTurn(
        session,
        providerSession,
        source,
        session.serviceTier,
        null,
      );
      void this.executeTurn(session, active, () => runReview(target));
      return active.turn;
    });
  }

  async steer(
    sessionId: string,
    input: Pick<AgentTurnInput, "text" | "attachments">,
    source: AgentTurnSource,
  ): Promise<void> {
    return this.withSessionMutation(sessionId, async () => {
      const active = this.activeTurns.get(sessionId);
      if (!active)
        throw new ChatRoomError("CONFLICT", "Agent session has no active turn");
      const session = this.requireSession(sessionId);
      const text = input.text.trim();
      if (!text && input.attachments.length === 0)
        throw new ChatRoomError("INVALID_INPUT", "Agent message is empty");
      const attachments = await validateAttachments(session, input.attachments);
      await this.validateInputModalities(session, text, attachments);
      if (this.activeTurns.get(sessionId) !== active)
        throw new ChatRoomError("CONFLICT", "Agent turn ended before steering");
      const provider = this.requireProvider(session.provider);
      if (!provider.features.steering)
        throw new ChatRoomError(
          "UNSUPPORTED",
          session.provider + " does not support steering an active turn",
        );
      if (!active.providerSession.steer)
        throw new ChatRoomError(
          "INTERNAL",
          session.provider + " declares steering without implementing it",
        );
      const sequence = active.nextSequence++;
      await active.providerSession.steer({ text, attachments });
      const now = new Date().toISOString();
      const item: AgentItem = {
        id: "item_" + randomUUID(),
        turnId: active.turn.id,
        providerItemId: null,
        sequence,
        status: "completed",
        type: "user_message",
        source,
        text,
        attachments,
        createdAt: now,
        updatedAt: now,
      };
      this.store.insertItem(item);
      this.invalidateSession(sessionId, {
        turnIds: [active.turn.id],
        itemIds: [item.id],
      });
    });
  }

  private beginTurn(
    session: AgentSession,
    providerSession: ProviderSession,
    source: AgentTurnSource,
    serviceTier: string | null,
    userInput: Pick<AgentTurnInput, "text" | "attachments"> | null,
  ): ActiveTurn {
    const now = new Date().toISOString();
    const turn: AgentTurn = {
      id: "turn_" + randomUUID(),
      sessionId: session.id,
      providerTurnId: null,
      provider: session.provider,
      ...copyAgentSessionConfig(session),
      serviceTier,
      usage: null,
      source,
      status: "running",
      error: null,
      startedAt: now,
      completedAt: null,
    };
    this.store.insertTurn(turn);
    const userItem: AgentItem | null = userInput
      ? {
          id: "item_" + randomUUID(),
          turnId: turn.id,
          providerItemId: null,
          sequence: 0,
          status: "completed",
          type: "user_message",
          source,
          ...userInput,
          createdAt: now,
          updatedAt: now,
        }
      : null;
    if (userItem) this.store.insertItem(userItem);
    const active: ActiveTurn = {
      turn,
      providerSession,
      items: new Map(),
      commandOutputs: new Map(),
      interactions: new Map(),
      respondingInteractions: new Set(),
      nextSequence: userInput ? 1 : 0,
    };
    this.activeTurns.set(session.id, active);
    this.updateSessionStatus(session, "running", {
      turnIds: [turn.id],
      itemIds: userItem ? [userItem.id] : [],
    });
    return active;
  }

  async configureSession(
    sessionId: string,
    patch: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return this.withSessionMutation(sessionId, () =>
      this.configureSessionUnlocked(sessionId, patch),
    );
  }

  private async configureSessionUnlocked(
    sessionId: string,
    patch: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const session = this.requireSession(sessionId);
    if (this.activeTurns.has(sessionId) || session.status !== "idle")
      throw new ChatRoomError(
        "CONFLICT",
        "Cannot configure an active Agent session",
      );
    const config = await this.validateConfig(
      this.requireProvider(session.provider),
      copyAgentSessionConfig(session),
      patch,
    );
    const providerSession = await this.providerSession(session);
    await providerSession.configure(config);
    const updated = {
      ...session,
      ...config,
      updatedAt: nextSessionUpdatedAt(session.updatedAt),
    };
    const providerState = this.requireProviderState(
      sessionId,
      session.provider,
    );
    this.store.upsertProviderState({
      ...providerState,
      ...config,
      providerSessionId: providerSession.providerSessionId,
      updatedAt: updated.updatedAt,
    });
    this.store.updateSession(updated);
    this.invalidateSession(sessionId);
    return updated;
  }

  private async validateConfig(
    provider: AgentProvider,
    current: AgentSessionConfig,
    patch: Partial<AgentSessionConfig>,
  ): Promise<AgentSessionConfig> {
    const config = { ...current };
    for (const key of [
      "model",
      "reasoningEffort",
      "reasoningSummary",
      "serviceTier",
      "approvalPolicy",
      "approvalsReviewer",
      "permissionMode",
    ] as const) {
      if (patch[key] !== undefined)
        Object.assign(config, { [key]: patch[key] });
    }
    const approvalPolicySetting = provider.nativeSettings.find(
      (setting) => setting.id === "approvalPolicy",
    );
    const approvalsReviewerSetting = provider.nativeSettings.find(
      (setting) => setting.id === "approvalsReviewer",
    );
    const permissionModeSetting = provider.nativeSettings.find(
      (setting) => setting.id === "permissionMode",
    );

    if (approvalPolicySetting) {
      config.approvalPolicy ??=
        approvalPolicySetting.defaultValue === "untrusted" ||
        approvalPolicySetting.defaultValue === "on-request" ||
        approvalPolicySetting.defaultValue === "never"
          ? approvalPolicySetting.defaultValue
          : "on-request";
      if (
        !approvalPolicySupported(config.approvalPolicy, approvalPolicySetting)
      )
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Unsupported approvalPolicy for " + provider.id,
        );
    } else if (config.approvalPolicy !== null) {
      throw new ChatRoomError(
        "INVALID_INPUT",
        provider.id + " does not support approvalPolicy",
      );
    }

    if (approvalsReviewerSetting) {
      config.approvalsReviewer ??=
        approvalsReviewerSetting.defaultValue === "auto_review" ||
        approvalsReviewerSetting.defaultValue === "guardian_subagent"
          ? approvalsReviewerSetting.defaultValue
          : "user";
      if (
        !approvalsReviewerSetting.options.some(
          (option) => option.id === config.approvalsReviewer,
        )
      )
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Unsupported approvalsReviewer for " + provider.id,
        );
    } else if (config.approvalsReviewer !== null) {
      throw new ChatRoomError(
        "INVALID_INPUT",
        provider.id + " does not support approvalsReviewer",
      );
    }

    if (permissionModeSetting) {
      config.permissionMode ??= isAgentPermissionMode(
        permissionModeSetting.defaultValue,
      )
        ? permissionModeSetting.defaultValue
        : "workspace-write";
      if (
        !permissionModeSetting.options.some(
          (option) => option.id === config.permissionMode,
        )
      )
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Unsupported permissionMode for " + provider.id,
        );
    } else if (config.permissionMode !== null) {
      throw new ChatRoomError(
        "INVALID_INPUT",
        provider.id + " does not support permissionMode",
      );
    }

    const models = await provider.listModels();
    const model =
      config.model === null
        ? (models.find((candidate) => candidate.isDefault) ?? models[0])
        : models.find((candidate) => candidate.id === config.model);
    if (config.model !== null && !model)
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Unknown model for " + provider.id + ": " + config.model,
      );
    const supportsEffort = (value: string | null) =>
      value === null ||
      !!model?.reasoningEfforts.some((effort) => effort.id === value);
    const supportsTier = (value: string | null) =>
      value === null || !!model?.serviceTiers.some((tier) => tier.id === value);
    if (config.model !== current.model) {
      if (
        patch.reasoningEffort === undefined &&
        !supportsEffort(config.reasoningEffort)
      )
        config.reasoningEffort = supportsEffort(
          model?.defaultReasoningEffort ?? null,
        )
          ? (model?.defaultReasoningEffort ?? null)
          : null;
      if (patch.serviceTier === undefined && !supportsTier(config.serviceTier))
        config.serviceTier = supportsTier(model?.defaultServiceTier ?? null)
          ? (model?.defaultServiceTier ?? null)
          : null;
      if (
        patch.reasoningSummary === undefined &&
        !model?.reasoningSummaries.includes(config.reasoningSummary ?? "none")
      )
        config.reasoningSummary =
          model?.defaultReasoningSummary &&
          model.reasoningSummaries.includes(model.defaultReasoningSummary)
            ? model.defaultReasoningSummary
            : null;
    }
    if (!supportsEffort(config.reasoningEffort))
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Unsupported reasoning effort: " + config.reasoningEffort,
      );
    if (!supportsTier(config.serviceTier))
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Unsupported service tier: " + config.serviceTier,
      );
    if (
      config.reasoningSummary !== null &&
      !model?.reasoningSummaries.includes(config.reasoningSummary)
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Unsupported reasoning summary: " + config.reasoningSummary,
      );
    return config;
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId);
    if (!active)
      throw new ChatRoomError("CONFLICT", "Agent session has no active turn");
    await active.providerSession.interrupt();
  }

  async respondInteraction(
    sessionId: string,
    itemId: string,
    response: AgentInteractionResponse,
  ): Promise<AgentItem> {
    const active = this.activeTurns.get(sessionId);
    if (!active)
      throw new ChatRoomError("CONFLICT", "Agent session has no active turn");
    const providerInteractionId = active.interactions.get(itemId);
    if (!providerInteractionId)
      throw new ChatRoomError(
        "NOT_FOUND",
        "Unknown agent interaction: " + itemId,
      );
    const item = [...active.items.values()].find(
      (value) => value.id === itemId,
    );
    if (!item || item.type !== "interaction")
      throw new ChatRoomError(
        "NOT_FOUND",
        "Unknown agent interaction: " + itemId,
      );
    if (response.type !== item.interaction.kind)
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Interaction response type does not match the request",
      );
    if (
      response.type === "approval" &&
      !item.interaction.approvalOptions.some(
        (option) => option.id === response.decision,
      )
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Unknown approval option: " + response.decision,
      );
    if (active.respondingInteractions.has(itemId))
      throw new ChatRoomError(
        "CONFLICT",
        "Agent interaction response is already being submitted",
      );
    active.respondingInteractions.add(itemId);
    try {
      await active.providerSession.resolveInteraction(
        providerInteractionId,
        response,
      );
    } finally {
      active.respondingInteractions.delete(itemId);
    }
    active.interactions.delete(itemId);
    const current = active.items.get(item.providerItemId ?? item.id);
    const updated: AgentItem = {
      ...item,
      status:
        current?.status === "interrupted" || current?.status === "failed"
          ? current.status
          : "completed",
      interaction: { ...item.interaction, response },
      updatedAt: new Date().toISOString(),
    };
    active.items.set(item.providerItemId ?? item.id, updated);
    this.persistItem(sessionId, updated);
    if (this.activeTurns.get(sessionId) === active)
      this.updateSessionStatus(
        this.requireSession(sessionId),
        active.interactions.size ? "waiting_input" : "running",
        {
          turnIds: [active.turn.id],
          itemIds: [updated.id],
        },
      );
    else
      this.invalidateSession(sessionId, {
        turnIds: [active.turn.id],
        itemIds: [updated.id],
      });
    return updated;
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.withSessionMutation(sessionId, () =>
      this.deleteSessionUnlocked(sessionId),
    );
  }

  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0)
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Select at least one Agent session",
      );
    if (ids.length > 100)
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Cannot delete more than 100 Agent sessions at once",
      );

    // Validate every target before changing anything, so active/unknown sessions
    // cannot cause an avoidable partial batch deletion.
    for (const id of ids) {
      this.requireSession(id);
      if (this.sessionMutations.has(id))
        throw new ChatRoomError(
          "CONFLICT",
          "An Agent session is already being modified",
        );
      if (this.activeTurns.has(id))
        throw new ChatRoomError(
          "CONFLICT",
          "Cannot delete a running Agent session",
        );
    }

    // Acquire all locks synchronously before the first await, preventing a turn
    // or another mutation from starting for any member of this batch.
    for (const id of ids) this.sessionMutations.add(id);
    try {
      for (const id of ids) await this.deleteSessionUnlocked(id);
    } finally {
      for (const id of ids) this.sessionMutations.delete(id);
    }
  }

  private async deleteSessionUnlocked(sessionId: string): Promise<void> {
    if (this.activeTurns.has(sessionId))
      throw new ChatRoomError(
        "CONFLICT",
        "Cannot delete a running Agent session",
      );
    const history = this.history(sessionId);
    const providerSession = this.providerSessions.get(sessionId);
    if (providerSession) {
      await providerSession.close().catch(() => undefined);
      this.providerSessions.delete(sessionId);
    }
    await cleanupSessionFiles(this.store, history);
    this.store.deleteSession(sessionId);
    this.invalidateSession(sessionId, { deleted: true });
  }

  async switchProvider(
    sessionId: string,
    targetProvider: AgentProviderId,
    patch: Partial<AgentSessionConfig> = {},
  ): Promise<AgentSession> {
    return this.withSessionMutation(sessionId, () =>
      this.switchProviderUnlocked(sessionId, targetProvider, patch),
    );
  }

  private async switchProviderUnlocked(
    sessionId: string,
    targetProvider: AgentProviderId,
    patch: Partial<AgentSessionConfig> = {},
  ): Promise<AgentSession> {
    const session = this.requireSession(sessionId);
    if (this.activeTurns.has(sessionId) || session.status !== "idle")
      throw new ChatRoomError(
        "CONFLICT",
        "Wait for the current turn to finish before switching agents",
      );

    if (session.provider === targetProvider)
      return this.configureSessionUnlocked(sessionId, patch);

    const workspace = await this.workspaces.info(session.workspaceRoot);
    const workspaceRoot = workspace.root;
    const provider = this.requireProvider(targetProvider);
    const providerStatus = await provider.probe();
    if (!providerStatus.installed)
      throw new ChatRoomError(
        "UNSUPPORTED",
        targetProvider + " is not installed",
      );
    if (!providerStatus.authenticated)
      throw new ChatRoomError(
        "FORBIDDEN",
        targetProvider + " is not authenticated",
        providerStatus.error ? { error: providerStatus.error } : undefined,
      );

    const existingState = this.store.getProviderState(
      sessionId,
      targetProvider,
    );
    const config = await this.validateConfig(
      provider,
      existingState
        ? copyAgentSessionConfig(existingState)
        : emptyAgentSessionConfig(),
      patch,
    );

    const history = this.history(sessionId);
    const latestTurnId = history.turns.at(-1)?.turn.id ?? null;
    const delta = buildContinuityDelta(
      history,
      existingState?.syncedThroughTurnId ?? null,
    );
    const continuityContext = mergeContinuityContext(
      existingState?.continuityContext ?? "",
      delta,
    );

    const currentState = this.requireProviderState(sessionId, session.provider);
    this.store.upsertProviderState({
      ...currentState,
      ...copyAgentSessionConfig(session),
      tokenUsage: session.tokenUsage,
      syncedThroughTurnId: latestTurnId,
      createdAt: currentState.createdAt,
      updatedAt: new Date().toISOString(),
    });

    const context: AgentProviderContext = {
      workspaceRoot,
      workspacePrompt: workspace.presetPrompt,
      ...config,
      continuityContext: continuityContext || null,
      continuityDelta: delta || null,
    };

    const currentProviderSession = this.providerSessions.get(sessionId);
    if (currentProviderSession) {
      await currentProviderSession.close().catch(() => undefined);
      this.providerSessions.delete(sessionId);
    }

    const providerSession = existingState
      ? await provider.resumeSession(context, existingState.providerSessionId)
      : await provider.createSession(context);
    const now = new Date().toISOString();
    const providerState: AgentProviderSessionState = {
      sessionId,
      provider: targetProvider,
      providerSessionId: providerSession.providerSessionId,
      ...config,
      tokenUsage: existingState?.tokenUsage ?? null,
      continuityContext,
      syncedThroughTurnId: latestTurnId,
      createdAt: existingState?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.upsertProviderState(providerState);
    this.providerSessions.set(sessionId, providerSession);

    const updated: AgentSession = {
      ...session,
      provider: targetProvider,
      ...config,
      tokenUsage: existingState?.tokenUsage ?? null,
      status: "idle",
      attention: null,
      updatedAt: nextSessionUpdatedAt(session.updatedAt),
    };
    this.store.updateSession(updated);
    this.invalidateSession(updated.id);
    return updated;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.deltaInvalidations.values()) {
      clearTimeout(pending.timer);
      this.persistPendingItems(pending);
    }
    this.deltaInvalidations.clear();
    for (const active of this.activeTurns.values())
      await active.providerSession.interrupt().catch(() => undefined);
    this.activeTurns.clear();
    for (const session of this.providerSessions.values())
      await session.close().catch(() => undefined);
    this.providerSessions.clear();
    await Promise.all(
      [...this.providers.values()].map((provider) =>
        provider.close().catch(() => undefined),
      ),
    );
  }

  private async executeTurn(
    session: AgentSession,
    active: ActiveTurn,
    events: () => AsyncIterable<ProviderEvent>,
  ): Promise<void> {
    try {
      for await (const event of events()) {
        if (this.activeTurns.get(session.id) !== active) break;
        await this.handleProviderEvent(session, active, event);
      }
    } catch (error) {
      if (this.activeTurns.get(session.id) === active)
        this.finishTurn(session, active, "failed", structuredError(error));
    }
  }

  private async handleProviderEvent(
    session: AgentSession,
    active: ActiveTurn,
    event: ProviderEvent,
  ): Promise<void> {
    if (event.type === "turn.started") {
      active.turn = {
        ...active.turn,
        providerTurnId: event.providerTurnId,
      };
      this.store.updateTurn(active.turn);
      this.invalidateSession(session.id, { turnIds: [active.turn.id] });
      return;
    }

    if (event.type === "item.started") {
      const existing = active.items.get(event.providerItemId);
      if (existing) return;
      const materialized = materializeProviderItem(
        active.turn.id,
        event.providerItemId,
        active.nextSequence++,
        "running",
        event.item,
      );
      const item = this.boundCommandOutput(
        active,
        event.providerItemId,
        materialized,
      );
      active.items.set(event.providerItemId, item);
      this.store.insertItem(item);
      this.invalidateSession(session.id, {
        turnIds: [active.turn.id],
        itemIds: [item.id],
      });
      return;
    }

    if (event.type === "item.delta") {
      const item = active.items.get(event.providerItemId);
      if (!item) return;
      const updated =
        event.field === "output" && item.type === "command"
          ? this.appendCommandOutput(
              active,
              event.providerItemId,
              item,
              event.delta,
            )
          : applyItemDelta(item, event.field, event.delta);
      active.items.set(event.providerItemId, updated);
      this.scheduleDeltaInvalidation(
        session.id,
        {
          turnIds: [active.turn.id],
          itemIds: [updated.id],
        },
        updated,
      );
      return;
    }

    if (event.type === "item.updated") {
      const existing = active.items.get(event.providerItemId);
      const payload = await prepareProviderItem(session, event.item);
      const updated = materializeProviderItem(
        active.turn.id,
        event.providerItemId,
        existing?.sequence ?? active.nextSequence++,
        existing?.status ?? "running",
        payload,
        existing,
      );
      active.items.set(event.providerItemId, updated);
      const bounded = this.boundCommandOutput(
        active,
        event.providerItemId,
        updated,
      );
      active.items.set(event.providerItemId, bounded);
      if (existing) this.persistItem(session.id, bounded);
      else this.store.insertItem(bounded);
      this.invalidateSession(session.id, {
        turnIds: [active.turn.id],
        itemIds: [bounded.id],
      });
      return;
    }

    if (event.type === "token.usage") {
      const state = this.requireProviderState(session.id, session.provider);
      const now = new Date().toISOString();
      this.store.upsertProviderState({
        ...state,
        tokenUsage: event.usage,
        updatedAt: now,
      });
      const currentSession = this.requireSession(session.id);
      Object.assign(session, currentSession, {
        tokenUsage: event.usage,
        updatedAt: nextSessionUpdatedAt(currentSession.updatedAt),
      });
      this.store.updateSession(session);
      active.turn = { ...active.turn, usage: event.usage.last };
      this.store.updateTurn(active.turn);
      this.scheduleDeltaInvalidation(session.id, {
        turnIds: [active.turn.id],
      });
      return;
    }

    if (event.type === "model.rerouted") {
      active.turn = { ...active.turn, model: event.toModel };
      this.store.updateTurn(active.turn);
      const id = "reroute_" + randomUUID();
      const notice = materializeProviderItem(
        active.turn.id,
        id,
        active.nextSequence++,
        "completed",
        {
          type: "notice",
          level: "info",
          text: `Model rerouted from ${event.fromModel} to ${event.toModel}: ${event.reason}`,
        },
      );
      active.items.set(id, notice);
      this.store.insertItem(notice);
      this.invalidateSession(session.id, {
        turnIds: [active.turn.id],
        itemIds: [notice.id],
      });
      return;
    }

    if (event.type === "item.completed") {
      const existing = active.items.get(event.providerItemId);
      const providerItem = await prepareProviderItem(session, event.item);
      const completed = materializeProviderItem(
        active.turn.id,
        event.providerItemId,
        existing?.sequence ?? active.nextSequence++,
        event.failed ? "failed" : "completed",
        providerItem,
        existing,
      );
      active.items.set(event.providerItemId, completed);
      const bounded = this.boundCommandOutput(
        active,
        event.providerItemId,
        completed,
      );
      active.items.set(event.providerItemId, bounded);
      if (existing) this.persistItem(session.id, bounded);
      else this.store.insertItem(bounded);
      this.invalidateSession(session.id, {
        turnIds: [active.turn.id],
        itemIds: [bounded.id],
      });
      return;
    }

    if (event.type === "interaction.resolved") {
      const entry = [...active.interactions].find(
        ([, requestId]) => requestId === event.providerRequestId,
      );
      if (!entry) return;
      const [itemId] = entry;
      active.interactions.delete(itemId);
      const item = [...active.items.values()].find(
        (candidate) => candidate.id === itemId,
      );
      if (item?.type === "interaction") {
        const updated: AgentItem = {
          ...item,
          status: "completed",
          updatedAt: new Date().toISOString(),
        };
        active.items.set(item.providerItemId ?? item.id, updated);
        this.persistItem(session.id, updated);
      }
      this.updateSessionStatus(
        session,
        active.interactions.size ? "waiting_input" : "running",
        {
          turnIds: [active.turn.id],
          itemIds: item ? [item.id] : [],
        },
      );
      return;
    }

    if (event.type === "interaction.requested") {
      const item = materializeInteraction(
        active.turn.id,
        event.providerItemId,
        active.nextSequence++,
        event.interaction,
      );
      active.items.set(event.providerItemId, item);
      active.interactions.set(item.id, event.interaction.id);
      this.store.insertItem(item);
      this.updateSessionStatus(session, "waiting_input", {
        turnIds: [active.turn.id],
        itemIds: [item.id],
      });
      return;
    }

    if (event.type === "turn.completed")
      this.finishTurn(session, active, event.status, event.error ?? null);
  }

  private finishTurn(
    session: AgentSession,
    active: ActiveTurn,
    status: AgentTurn["status"],
    error: AgentError | null,
  ): void {
    if (this.activeTurns.get(session.id) !== active) return;
    const now = new Date().toISOString();
    const changedItemIds: string[] = [];
    for (const [key, item] of active.items) {
      if (item.status !== "running" && item.status !== "waiting") continue;
      const updated: AgentItem = {
        ...item,
        status: status === "completed" ? "interrupted" : status,
        updatedAt: now,
      };
      active.items.set(key, updated);
      this.persistItem(session.id, updated);
      changedItemIds.push(updated.id);
    }
    active.turn = {
      ...active.turn,
      status,
      error,
      completedAt: now,
    };
    this.store.updateTurn(active.turn);
    const providerState = this.requireProviderState(
      session.id,
      session.provider,
    );
    this.store.upsertProviderState({
      ...providerState,
      syncedThroughTurnId: active.turn.id,
      createdAt: providerState.createdAt,
      updatedAt: now,
    });
    this.activeTurns.delete(session.id);
    this.updateSessionStatus(session, "idle", {
      turnIds: [active.turn.id],
      itemIds: changedItemIds,
    });
  }

  private async providerSession(
    session: AgentSession,
  ): Promise<ProviderSession> {
    const workspace = await this.workspaces.info(session.workspaceRoot);
    const workspaceRoot = workspace.root;
    const existing = this.providerSessions.get(session.id);
    if (existing) return existing;
    const provider = this.requireProvider(session.provider);
    const providerState = this.requireProviderState(
      session.id,
      session.provider,
    );
    try {
      const resumed = await provider.resumeSession(
        {
          workspaceRoot,
          workspacePrompt: workspace.presetPrompt,
          ...copyAgentSessionConfig(providerState),
          continuityContext: providerState.continuityContext || null,
          continuityDelta: null,
        },
        providerState.providerSessionId,
      );
      this.providerSessions.set(session.id, resumed);
      return resumed;
    } catch (error) {
      this.updateSessionStatus(session, "error");
      throw error;
    }
  }

  private requireProviderState(
    sessionId: string,
    provider: AgentProviderId,
  ): AgentProviderSessionState {
    const state = this.store.getProviderState(sessionId, provider);
    if (!state)
      throw new ChatRoomError(
        "INTERNAL",
        `Missing provider state for agent session ${sessionId} (${provider})`,
      );
    return state;
  }

  private updateSessionStatus(
    session: AgentSession,
    status: AgentSession["status"],
    change: AgentInvalidation = {},
  ): AgentSession {
    const current = this.requireSession(session.id);
    const updated = {
      ...current,
      status,
      updatedAt: nextSessionUpdatedAt(current.updatedAt),
    };
    Object.assign(session, updated);
    this.store.updateSession(updated);
    this.invalidateSession(updated.id, change);
    return updated;
  }

  private requireProvider(providerId: AgentProviderId): AgentProvider {
    const provider = this.providers.get(providerId);
    if (!provider)
      throw new ChatRoomError(
        "UNSUPPORTED",
        "Unsupported Agent provider: " + providerId,
      );
    return provider;
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.store.getSession(sessionId);
    if (!session)
      throw new ChatRoomError(
        "NOT_FOUND",
        "Unknown Agent session: " + sessionId,
      );
    return session;
  }

  async cleanupOrphanAttachments(
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  ): Promise<void> {
    await cleanupOrphanAttachmentFiles(this.store, maxAgeMs);
  }

  private async withSessionMutation<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.sessionMutations.has(sessionId))
      throw new ChatRoomError(
        "CONFLICT",
        "Agent session is already being modified",
      );
    this.sessionMutations.add(sessionId);
    try {
      return await action();
    } finally {
      this.sessionMutations.delete(sessionId);
    }
  }

  private async validateInputModalities(
    session: AgentSession,
    text: string,
    attachments: AgentTurnInput["attachments"],
  ): Promise<void> {
    const models = await this.requireProvider(session.provider).listModels();
    const model =
      session.model === null
        ? (models.find((candidate) => candidate.isDefault) ?? models[0])
        : models.find((candidate) => candidate.id === session.model);
    if (!model) return;
    if (
      (text ||
        attachments.some(
          (attachment) =>
            attachment.kind === "file" || attachment.kind === "skill",
        )) &&
      !model.inputModalities.includes("text")
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Selected model does not support text input",
      );
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !model.inputModalities.includes("image")
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Selected model does not support image input",
      );
    if (
      attachments.some((attachment) => attachment.kind === "audio") &&
      !model.inputModalities.includes("audio")
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Selected model does not support audio input",
      );
  }

  private scheduleDeltaInvalidation(
    sessionId: string,
    change: AgentInvalidation = {},
    persistedItem?: AgentItem,
  ): void {
    if (this.closed) return;
    const existing = this.deltaInvalidations.get(sessionId);
    if (existing) {
      mergeInvalidation(existing, change);
      if (persistedItem)
        existing.persistedItems.set(persistedItem.id, persistedItem);
      return;
    }
    const pending: PendingAgentInvalidation = {
      timer: setTimeout(() => {
        try {
          this.flushDeltaInvalidation(sessionId);
        } catch (error) {
          this.failActiveTurn(sessionId, error);
        }
      }, 150),
      turnIds: new Set(change.turnIds ?? []),
      itemIds: new Set(change.itemIds ?? []),
      persistedItems: new Map(
        persistedItem ? [[persistedItem.id, persistedItem]] : [],
      ),
      deleted: Boolean(change.deleted),
    };
    pending.timer.unref();
    this.deltaInvalidations.set(sessionId, pending);
  }

  private flushDeltaInvalidation(sessionId: string): void {
    const pending = this.deltaInvalidations.get(sessionId);
    if (!pending) return;
    this.deltaInvalidations.delete(sessionId);
    this.persistPendingItems(pending);
    if (this.closed) return;
    this.events.emit({
      type: "agent",
      sessionId,
      ...(pending.turnIds.size ? { turnIds: [...pending.turnIds] } : {}),
      ...(pending.itemIds.size ? { itemIds: [...pending.itemIds] } : {}),
      ...(pending.deleted ? { deleted: true } : {}),
    });
  }

  private persistItem(sessionId: string, item: AgentItem): void {
    this.deltaInvalidations.get(sessionId)?.persistedItems.delete(item.id);
    this.store.updateItem(item);
  }

  private persistPendingSession(sessionId: string): void {
    const pending = this.deltaInvalidations.get(sessionId);
    if (pending) this.persistPendingItems(pending);
  }

  private failActiveTurn(sessionId: string, error: unknown): void {
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    const session = this.store.getSession(sessionId);
    if (!session) return;
    try {
      this.finishTurn(session, active, "failed", structuredError(error));
    } catch {
      this.activeTurns.delete(sessionId);
    }
  }

  private persistPendingItems(
    pending: Pick<PendingAgentInvalidation, "persistedItems">,
  ): void {
    for (const item of pending.persistedItems.values())
      this.store.updateItem(item);
    pending.persistedItems.clear();
  }

  private boundCommandOutput(
    active: ActiveTurn,
    providerItemId: string,
    item: AgentItem,
  ): AgentItem {
    if (item.type !== "command") {
      active.commandOutputs.delete(providerItemId);
      return item;
    }
    const buffer = new HeadTailBuffer(AGENT_COMMAND_OUTPUT_LIMIT_BYTES);
    buffer.append(item.output);
    active.commandOutputs.set(providerItemId, buffer);
    return { ...item, output: buffer.snapshot().text };
  }

  private appendCommandOutput(
    active: ActiveTurn,
    providerItemId: string,
    item: Extract<AgentItem, { type: "command" }>,
    delta: string,
  ): AgentItem {
    let buffer = active.commandOutputs.get(providerItemId);
    if (!buffer) {
      buffer = new HeadTailBuffer(AGENT_COMMAND_OUTPUT_LIMIT_BYTES);
      buffer.append(item.output);
      active.commandOutputs.set(providerItemId, buffer);
    }
    buffer.append(delta);
    return {
      ...item,
      output: buffer.snapshot().text,
      updatedAt: new Date().toISOString(),
    };
  }

  private invalidateSession(
    sessionId: string,
    change: AgentInvalidation = {},
  ): void {
    const pending = this.deltaInvalidations.get(sessionId);
    const turnIds = new Set(change.turnIds ?? []);
    const itemIds = new Set(change.itemIds ?? []);
    let deleted = Boolean(change.deleted);
    if (pending) {
      clearTimeout(pending.timer);
      this.deltaInvalidations.delete(sessionId);
      this.persistPendingItems(pending);
      for (const id of pending.turnIds) turnIds.add(id);
      for (const id of pending.itemIds) itemIds.add(id);
      deleted ||= pending.deleted;
    }
    if (this.closed) return;
    this.events.emit({
      type: "agent",
      sessionId,
      ...(turnIds.size ? { turnIds: [...turnIds] } : {}),
      ...(itemIds.size ? { itemIds: [...itemIds] } : {}),
      ...(deleted ? { deleted: true } : {}),
    });
  }
}

function mergeInvalidation(
  target: Pick<PendingAgentInvalidation, "turnIds" | "itemIds" | "deleted">,
  change: AgentInvalidation,
): void {
  for (const id of change.turnIds ?? []) target.turnIds.add(id);
  for (const id of change.itemIds ?? []) target.itemIds.add(id);
  target.deleted ||= Boolean(change.deleted);
}
