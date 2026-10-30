export type AgentProviderId = string;

export const AGENT_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && AGENT_PROVIDER_ID_PATTERN.test(value);
}

export type AgentSessionStatus = "idle" | "running" | "waiting_input" | "error";
export type AgentTurnStatus =
  "running" | "completed" | "interrupted" | "failed";
export type AgentTurnSource = "human" | "mcp";
export type AgentItemStatus =
  "running" | "completed" | "waiting" | "interrupted" | "failed";

export type AgentReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface CodexGranularApprovalPolicy {
  sandbox_approval: boolean;
  rules: boolean;
  skill_approval: boolean;
  request_permissions: boolean;
  mcp_elicitations: boolean;
}

export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | { granular: CodexGranularApprovalPolicy }
  | "never";

export type CodexApprovalsReviewer =
  "user" | "auto_review" | "guardian_subagent";

export type CodexSandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

export const AGENT_PERMISSION_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export function isAgentPermissionMode(
  value: unknown,
): value is CodexSandboxMode {
  return (
    typeof value === "string" &&
    AGENT_PERMISSION_MODES.some((mode) => mode === value)
  );
}

export interface AgentProviderNativeSetting {
  id: "approvalPolicy" | "approvalsReviewer" | "permissionMode";
  defaultValue: string;
  options: readonly { id: string; description: string | null }[];
  granularFields: readonly { id: string; description: string | null }[];
}

export interface AgentSessionConfig {
  model: string | null;
  reasoningEffort: string | null;
  reasoningSummary: AgentReasoningSummary | null;
  serviceTier: string | null;
  approvalPolicy: CodexApprovalPolicy | null;
  approvalsReviewer: CodexApprovalsReviewer | null;
  permissionMode: CodexSandboxMode | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface AgentTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface AgentPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface AgentModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  modelSpecialty: string | null;
  isDefault: boolean;
  upgrade: string | null;
  upgradeInfo: unknown | null;
  availabilityMessage: string | null;
  reasoningEfforts: Array<{ id: string; description: string }>;
  defaultReasoningEffort: string | null;
  reasoningSummaries: AgentReasoningSummary[];
  defaultReasoningSummary: AgentReasoningSummary | null;
  inputModalities: Array<"text" | "image" | "audio">;
  multiAgentVersion: string | null;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
  availableAccessPrograms: {
    cyber: string[];
    [program: string]: string[];
  } | null;
}

export interface AgentProviderQuotaWindow {
  id: string;
  label: string | null;
  utilization: number | null;
  resetsAt: string | null;
}

export interface AgentProviderExtraUsage {
  enabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface AgentProviderAccountUsage {
  subscriptionType: string | null;
  windows: AgentProviderQuotaWindow[];
  extraUsage: AgentProviderExtraUsage | null;
  updatedAt: string;
}

export interface AgentProviderDetails {
  configRequirements: unknown | null;
  rateLimits: unknown | null;
  accountUsage: AgentProviderAccountUsage | null;
}

export type AgentReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

export interface AgentProviderFeatures {
  nativeReview: boolean;
  steering: boolean;
  [feature: string]: boolean;
}

export interface AgentProviderProbe {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  error: string | null;
  capabilities: {
    namespaceTools: boolean;
    imageGeneration: boolean;
    webSearch: boolean;
    [capability: string]: boolean;
  } | null;
}

export interface AgentProviderStatus extends AgentProviderProbe {
  id: AgentProviderId;
  displayName: string;
  icon: string | null;
  features: AgentProviderFeatures;
  nativeSettings: readonly AgentProviderNativeSetting[];
}

export interface AgentSessionAttention {
  kind: "approval" | "input";
  count: number;
}

export interface AgentSession extends AgentSessionConfig {
  id: string;
  workspaceId: string;
  workspaceName: string;
  provider: AgentProviderId;
  status: AgentSessionStatus;
  attention: AgentSessionAttention | null;
  createdAt: string;
  tokenUsage: AgentTokenUsage | null;
  updatedAt: string;
}

export interface AgentProviderSessionState extends AgentSessionConfig {
  sessionId: string;
  provider: AgentProviderId;
  providerSessionId: string;
  continuityContext: string;
  syncedThroughTurnId: string | null;
  createdAt: string;
  tokenUsage: AgentTokenUsage | null;
  updatedAt: string;
}

export interface AgentError {
  message: string;
  details: string | null;
  providerData: unknown | null;
}

export interface AgentTurn extends AgentSessionConfig {
  id: string;
  sessionId: string;
  providerTurnId: string | null;
  provider: AgentProviderId;
  source: AgentTurnSource;
  status: AgentTurnStatus;
  error: AgentError | null;
  usage: TokenUsageBreakdown | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentAttachment {
  kind: "image" | "audio" | "skill" | "file";
  name: string;
  path: string;
  mimeType: string | null;
}

export interface AgentArtifact {
  kind: "image" | "file";
  name: string;
  path: string;
  mimeType: string | null;
}

export interface AgentFileChange {
  path: string;
  kind: string;
  movePath: string | null;
  diff: string;
}

export interface AgentInteractionOption {
  id: string;
  label: string;
  description: string | null;
}

export interface AgentInputQuestion {
  id: string;
  label: string;
  question: string;
  options: AgentInteractionOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
  secret: boolean;
}

export type AgentInteractionResponse =
  | { type: "approval"; decision: string }
  | { type: "input"; answers: Record<string, string[]> };

export type AgentItem = AgentItemBase &
  (
    | {
        type: "user_message";
        source?: AgentTurnSource;
        text: string;
        attachments: AgentAttachment[];
      }
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
        artifact: AgentArtifact;
      }
    | {
        type: "interaction";
        interaction: {
          kind: "approval" | "input";
          title: string;
          description: string | null;
          questions: AgentInputQuestion[];
          approvalOptions: AgentInteractionOption[];
          response: AgentInteractionResponse | null;
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
      }
  );

export interface AgentItemBase {
  id: string;
  turnId: string;
  providerItemId: string | null;
  sequence: number;
  status: AgentItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHistory {
  session: AgentSession;
  turns: Array<{
    turn: AgentTurn;
    items: AgentItem[];
  }>;
}

export interface AgentHistoryUpdate {
  session: AgentSession;
  turns: AgentTurn[];
  items: AgentItem[];
}

export interface AgentTurnInput {
  outputSchema: unknown | null;
  text: string;
  attachments: AgentAttachment[];
}

export interface CreateAgentSessionInput extends Partial<AgentSessionConfig> {
  workspaceId: string;
  provider: AgentProviderId;
  model: string | null;
}
