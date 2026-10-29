import type {
  AgentAttachment,
  AgentError,
  AgentInteractionOption,
  AgentPlanStep,
  AgentSessionConfig,
  AgentTokenUsage,
  AgentFileChange,
  AgentInputQuestion,
  AgentInteractionResponse,
  AgentModel,
  AgentProviderFeatures,
  AgentProviderId,
  AgentProviderNativeSetting,
  AgentProviderProbe,
  AgentProviderDetails,
  AgentReviewTarget,
} from "./types.js";

export interface AgentProviderContext extends AgentSessionConfig {
  workspaceRoot: string;
  workspacePrompt: string | null;
  continuityContext: string | null;
  continuityDelta: string | null;
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly displayName: string;
  readonly icon: string | null;
  readonly features: AgentProviderFeatures;
  readonly nativeSettings: readonly AgentProviderNativeSetting[];
  probe(): Promise<AgentProviderProbe>;
  details(): Promise<AgentProviderDetails>;
  listModels(): Promise<AgentModel[]>;
  createSession(context: AgentProviderContext): Promise<ProviderSession>;
  resumeSession(
    context: AgentProviderContext,
    providerSessionId: string,
  ): Promise<ProviderSession>;
  close(): Promise<void>;
  refreshMcpServers?(): Promise<void>;
}

export interface ProviderSession {
  readonly providerSessionId: string;
  runTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent>;
  runReview?(target: AgentReviewTarget): AsyncIterable<ProviderEvent>;
  steer?(input: Pick<ProviderTurnInput, "text" | "attachments">): Promise<void>;
  interrupt(): Promise<void>;
  configure(config: AgentSessionConfig): Promise<void>;
  resolveInteraction(
    interactionId: string,
    response: AgentInteractionResponse,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderTurnInput {
  outputSchema: unknown | null;
  text: string;
  attachments: AgentAttachment[];
}

export type ProviderItem =
  | {
      type: "assistant_message";
      text: string;
      phase: "commentary" | "final_answer" | null;
    }
  | {
      type: "command";
      command: string;
      cwd: string | null;
      output: string;
      exitCode: number | null;
    }
  | {
      type: "tool";
      progress: string | null;
      name: string;
      server: string | null;
      input: unknown;
      output: unknown;
      error: string | null;
    }
  | {
      type: "turn_diff";
      diff: string;
    }
  | {
      type: "file_change";
      changes: AgentFileChange[];
    }
  | {
      type: "plan";
      text: string;
      steps: AgentPlanStep[];
    }
  | {
      type: "reasoning_summary";
      text: string;
    }
  | {
      type: "artifact";
      artifact: {
        kind: "image" | "file";
        name: string;
        path: string;
        mimeType: string | null;
      };
    }
  | {
      type: "context_compaction";
      trigger: "auto" | "manual" | null;
      error: string | null;
    }
  | {
      type: "notice";
      level: "info" | "warning" | "error";
      text: string;
    };

export interface ProviderInteraction {
  id: string;
  kind: "approval" | "input";
  title: string;
  description: string | null;
  questions: AgentInputQuestion[];
  approvalOptions: AgentInteractionOption[];
}

export type ProviderEvent =
  | { type: "interaction.resolved"; providerRequestId: string }
  | { type: "token.usage"; usage: AgentTokenUsage }
  | {
      type: "model.rerouted";
      fromModel: string;
      toModel: string;
      reason: string;
    }
  | { type: "item.updated"; providerItemId: string; item: ProviderItem }
  | { type: "turn.started"; providerTurnId: string | null }
  | {
      type: "item.started";
      providerItemId: string;
      item: ProviderItem;
    }
  | {
      type: "item.delta";
      providerItemId: string;
      field: "text" | "output";
      delta: string;
    }
  | {
      type: "item.completed";
      providerItemId: string;
      item: ProviderItem;
      failed?: boolean;
    }
  | {
      type: "interaction.requested";
      providerItemId: string;
      interaction: ProviderInteraction;
    }
  | {
      type: "turn.completed";
      status: "completed" | "interrupted" | "failed";
      error: AgentError | null;
    };
