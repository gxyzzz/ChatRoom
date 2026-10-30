import path from "node:path";
import type { AgentStore } from "./store.js";
import type {
  AgentHistory,
  AgentHistoryUpdate,
  AgentItem,
  AgentProviderSessionState,
  AgentSession,
  AgentTurn,
} from "./types.js";
import type { AppDatabase } from "#infrastructure/database/app-database";

interface SessionRow {
  token_usage_json: string | null;
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  workspace_path: string | null;
  provider: AgentSession["provider"];
  model: string | null;
  reasoning_effort: string | null;
  reasoning_summary: AgentSession["reasoningSummary"];
  service_tier: string | null;
  approval_policy_json: string | null;
  approvals_reviewer: AgentSession["approvalsReviewer"];
  permission_mode: AgentSession["permissionMode"];
  status: AgentSession["status"];
  attention_kind: "approval" | "input" | null;
  attention_count: number;
  created_at: string;
  updated_at: string;
}

interface ProviderStateRow {
  token_usage_json: string | null;
  session_id: string;
  provider: AgentProviderSessionState["provider"];
  provider_session_id: string;
  model: string | null;
  reasoning_effort: string | null;
  reasoning_summary: AgentSession["reasoningSummary"];
  service_tier: string | null;
  approval_policy_json: string | null;
  approvals_reviewer: AgentSession["approvalsReviewer"];
  permission_mode: AgentSession["permissionMode"];
  continuity_context: string;
  synced_through_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  usage_json: string | null;
  id: string;
  session_id: string;
  provider_turn_id: string | null;
  provider: AgentTurn["provider"];
  model: string | null;
  reasoning_effort: string | null;
  reasoning_summary: AgentSession["reasoningSummary"];
  service_tier: string | null;
  approval_policy_json: string | null;
  approvals_reviewer: AgentSession["approvalsReviewer"];
  permission_mode: AgentSession["permissionMode"];
  origin: 0 | 1;
  status: AgentTurn["status"];
  error_json: string;
  started_at: string;
  completed_at: string | null;
}

interface ItemRow {
  id: string;
  turn_id: string;
  provider_item_id: string | null;
  type: AgentItem["type"];
  sequence: number;
  status: AgentItem["status"];
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export class AgentRepository implements AgentStore {
  constructor(private readonly database: AppDatabase) {}

  reconcileInterrupted(now: string): void {
    this.database.raw.exec("BEGIN IMMEDIATE");
    try {
      this.database.raw
        .prepare(
          "UPDATE agent_items SET status='interrupted', updated_at=? WHERE status IN ('running','waiting')",
        )
        .run(now);
      this.database.raw
        .prepare(
          "UPDATE agent_turns SET status='interrupted', completed_at=? WHERE status='running'",
        )
        .run(now);
      const interruptedSessions = this.database.raw
        .prepare(
          "SELECT id, updated_at FROM agent_sessions WHERE status IN ('running','waiting_input')",
        )
        .all() as Array<{ id: string; updated_at: string }>;
      const updateSession = this.database.raw.prepare(
        "UPDATE agent_sessions SET status='idle', updated_at=? WHERE id=?",
      );
      for (const session of interruptedSessions)
        updateSession.run(
          monotonicTimestamp(session.updated_at, now),
          session.id,
        );
      this.database.raw.exec("COMMIT");
    } catch (error) {
      this.database.raw.exec("ROLLBACK");
      throw error;
    }
  }

  insertSession(session: AgentSession): void {
    this.database.raw
      .prepare(
        "INSERT INTO agent_sessions(id, workspace_id, provider, status, created_at, updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        session.id,
        session.workspaceId,
        session.provider,
        session.status,
        session.createdAt,
        session.updatedAt,
      );
  }

  updateSession(session: AgentSession): void {
    this.database.raw
      .prepare(
        "UPDATE agent_sessions SET workspace_id=?, provider=?, status=?, created_at=?, updated_at=? WHERE id=?",
      )
      .run(
        session.workspaceId,
        session.provider,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.id,
      );
  }

  getSession(id: string): AgentSession | null {
    const row = this.database.raw
      .prepare(
        "SELECT s.*, w.name_override AS workspace_name, w.path AS workspace_path, p.model AS model, p.reasoning_effort, p.reasoning_summary, p.service_tier, p.approval_policy_json, p.approvals_reviewer, p.permission_mode, p.token_usage_json, CASE WHEN EXISTS (SELECT 1 FROM agent_items ai JOIN agent_turns at ON at.id=ai.turn_id WHERE at.session_id=s.id AND ai.type='interaction' AND ai.status='waiting' AND json_extract(ai.payload_json,'$.interaction.kind')='approval') THEN 'approval' WHEN EXISTS (SELECT 1 FROM agent_items ai JOIN agent_turns at ON at.id=ai.turn_id WHERE at.session_id=s.id AND ai.type='interaction' AND ai.status='waiting') THEN 'input' ELSE NULL END AS attention_kind, (SELECT COUNT(*) FROM agent_items ai JOIN agent_turns at ON at.id=ai.turn_id WHERE at.session_id=s.id AND ai.type='interaction' AND ai.status='waiting') AS attention_count FROM agent_sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id LEFT JOIN agent_session_providers p ON p.session_id=s.id AND p.provider=s.provider WHERE s.id=?",
      )
      .get(id) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  listSessions(): AgentSession[] {
    return (
      this.database.raw
        .prepare(
          "SELECT s.*, w.name_override AS workspace_name, w.path AS workspace_path, p.model AS model, p.reasoning_effort, p.reasoning_summary, p.service_tier, p.approval_policy_json, p.approvals_reviewer, p.permission_mode, p.token_usage_json, CASE WHEN EXISTS (SELECT 1 FROM agent_items ai JOIN agent_turns at ON at.id=ai.turn_id WHERE at.session_id=s.id AND ai.type='interaction' AND ai.status='waiting' AND json_extract(ai.payload_json,'$.interaction.kind')='approval') THEN 'approval' WHEN EXISTS (SELECT 1 FROM agent_items ai JOIN agent_turns at ON at.id=ai.turn_id WHERE at.session_id=s.id AND ai.type='interaction' AND ai.status='waiting') THEN 'input' ELSE NULL END AS attention_kind, (SELECT COUNT(*) FROM agent_items ai JOIN agent_turns at ON at.id=ai.turn_id WHERE at.session_id=s.id AND ai.type='interaction' AND ai.status='waiting') AS attention_count FROM agent_sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id LEFT JOIN agent_session_providers p ON p.session_id=s.id AND p.provider=s.provider ORDER BY s.updated_at DESC",
        )
        .all() as unknown as SessionRow[]
    ).map(sessionFromRow);
  }

  deleteSession(id: string): void {
    this.database.raw.prepare("DELETE FROM agent_sessions WHERE id=?").run(id);
  }

  getProviderState(
    sessionId: string,
    provider: AgentProviderSessionState["provider"],
  ): AgentProviderSessionState | null {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM agent_session_providers WHERE session_id=? AND provider=?",
      )
      .get(sessionId, provider) as ProviderStateRow | undefined;
    return row ? providerStateFromRow(row) : null;
  }

  upsertProviderState(state: AgentProviderSessionState): void {
    this.database.raw
      .prepare(
        "INSERT INTO agent_session_providers(session_id, provider, provider_session_id, model, reasoning_effort, reasoning_summary, service_tier, approval_policy_json, approvals_reviewer, permission_mode, token_usage_json, continuity_context, synced_through_turn_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id, provider) DO UPDATE SET provider_session_id=excluded.provider_session_id, model=excluded.model, reasoning_effort=excluded.reasoning_effort, reasoning_summary=excluded.reasoning_summary, service_tier=excluded.service_tier, approval_policy_json=excluded.approval_policy_json, approvals_reviewer=excluded.approvals_reviewer, permission_mode=excluded.permission_mode, token_usage_json=excluded.token_usage_json, continuity_context=excluded.continuity_context, synced_through_turn_id=excluded.synced_through_turn_id, updated_at=excluded.updated_at",
      )
      .run(
        state.sessionId,
        state.provider,
        state.providerSessionId,
        state.model,
        state.reasoningEffort,
        state.reasoningSummary,
        state.serviceTier,
        state.approvalPolicy === null
          ? null
          : JSON.stringify(state.approvalPolicy),
        state.approvalsReviewer,
        state.permissionMode,
        JSON.stringify(state.tokenUsage),
        state.continuityContext,
        state.syncedThroughTurnId,
        state.createdAt,
        state.updatedAt,
      );
  }

  insertTurn(turn: AgentTurn): void {
    this.database.raw
      .prepare(
        "INSERT INTO agent_turns(id, session_id, provider_turn_id, provider, model, reasoning_effort, reasoning_summary, service_tier, approval_policy_json, approvals_reviewer, permission_mode, usage_json, origin, status, error_json, started_at, completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        turn.id,
        turn.sessionId,
        turn.providerTurnId,
        turn.provider,
        turn.model,
        turn.reasoningEffort,
        turn.reasoningSummary,
        turn.serviceTier,
        turn.approvalPolicy === null
          ? null
          : JSON.stringify(turn.approvalPolicy),
        turn.approvalsReviewer,
        turn.permissionMode,
        JSON.stringify(turn.usage),
        turnOriginCode(turn.source),
        turn.status,
        JSON.stringify(turn.error),
        turn.startedAt,
        turn.completedAt,
      );
  }

  updateTurn(turn: AgentTurn): void {
    this.database.raw
      .prepare(
        "UPDATE agent_turns SET session_id=?, provider_turn_id=?, provider=?, model=?, reasoning_effort=?, reasoning_summary=?, service_tier=?, approval_policy_json=?, approvals_reviewer=?, permission_mode=?, usage_json=?, origin=?, status=?, error_json=?, started_at=?, completed_at=? WHERE id=?",
      )
      .run(
        turn.sessionId,
        turn.providerTurnId,
        turn.provider,
        turn.model,
        turn.reasoningEffort,
        turn.reasoningSummary,
        turn.serviceTier,
        turn.approvalPolicy === null
          ? null
          : JSON.stringify(turn.approvalPolicy),
        turn.approvalsReviewer,
        turn.permissionMode,
        JSON.stringify(turn.usage),
        turnOriginCode(turn.source),
        turn.status,
        JSON.stringify(turn.error),
        turn.startedAt,
        turn.completedAt,
        turn.id,
      );
  }

  insertItem(item: AgentItem): void {
    this.database.raw
      .prepare(
        "INSERT INTO agent_items(id, turn_id, provider_item_id, type, sequence, status, payload_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        item.id,
        item.turnId,
        item.providerItemId,
        item.type,
        item.sequence,
        item.status,
        JSON.stringify(itemPayload(item)),
        item.createdAt,
        item.updatedAt,
      );
  }

  updateItem(item: AgentItem): void {
    this.database.raw
      .prepare(
        "UPDATE agent_items SET turn_id=?, provider_item_id=?, type=?, sequence=?, status=?, payload_json=?, created_at=?, updated_at=? WHERE id=?",
      )
      .run(
        item.turnId,
        item.providerItemId,
        item.type,
        item.sequence,
        item.status,
        JSON.stringify(itemPayload(item)),
        item.createdAt,
        item.updatedAt,
        item.id,
      );
  }

  history(sessionId: string): AgentHistory | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const turns = (
      this.database.raw
        .prepare(
          "SELECT * FROM agent_turns WHERE session_id=? ORDER BY started_at ASC",
        )
        .all(sessionId) as unknown as TurnRow[]
    ).map(turnFromRow);
    const items = this.database.raw
      .prepare(
        "SELECT i.* FROM agent_items i JOIN agent_turns t ON t.id=i.turn_id WHERE t.session_id=? ORDER BY i.sequence ASC",
      )
      .all(sessionId) as unknown as ItemRow[];
    const itemsByTurn = new Map<string, AgentItem[]>();
    for (const row of items) {
      const turnItems = itemsByTurn.get(row.turn_id) ?? [];
      turnItems.push(itemFromRow(row));
      itemsByTurn.set(row.turn_id, turnItems);
    }
    return {
      session,
      turns: turns.map((turn) => ({
        turn,
        items: itemsByTurn.get(turn.id) ?? [],
      })),
    };
  }

  historyUpdate(
    sessionId: string,
    turnIds: readonly string[],
    itemIds: readonly string[],
  ): AgentHistoryUpdate | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const items = selectByIds<ItemRow>(
      this.database,
      "SELECT i.* FROM agent_items i JOIN agent_turns t ON t.id=i.turn_id WHERE t.session_id=? AND i.id IN",
      sessionId,
      itemIds,
    ).map(itemFromRow);
    const turns = selectByIds<TurnRow>(
      this.database,
      "SELECT * FROM agent_turns WHERE session_id=? AND id IN",
      sessionId,
      [...turnIds, ...items.map((item) => item.turnId)],
    ).map(turnFromRow);
    return { session, turns, items };
  }
}

function selectByIds<Row>(
  database: AppDatabase,
  prefix: string,
  sessionId: string,
  ids: readonly string[],
): Row[] {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  return database.raw
    .prepare(prefix + " (" + placeholders + ")")
    .all(sessionId, ...unique) as unknown as Row[];
}

function sessionFromRow(row: SessionRow): AgentSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName:
      row.workspace_name ??
      (row.workspace_path ? path.basename(row.workspace_path) : ""),
    tokenUsage: parseJson(row.token_usage_json) as AgentSession["tokenUsage"],
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    reasoningSummary: row.reasoning_summary,
    serviceTier: row.service_tier,
    approvalPolicy: parseJson(
      row.approval_policy_json,
    ) as AgentSession["approvalPolicy"],
    approvalsReviewer: row.approvals_reviewer,
    permissionMode: row.permission_mode,
    status: row.status,
    attention:
      row.attention_kind && row.attention_count > 0
        ? { kind: row.attention_kind, count: row.attention_count }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerStateFromRow(
  row: ProviderStateRow,
): AgentProviderSessionState {
  return {
    sessionId: row.session_id,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    tokenUsage: parseJson(
      row.token_usage_json,
    ) as AgentProviderSessionState["tokenUsage"],
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    reasoningSummary: row.reasoning_summary,
    serviceTier: row.service_tier,
    approvalPolicy: parseJson(
      row.approval_policy_json,
    ) as AgentProviderSessionState["approvalPolicy"],
    approvalsReviewer: row.approvals_reviewer,
    permissionMode: row.permission_mode,
    continuityContext: row.continuity_context,
    syncedThroughTurnId: row.synced_through_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function turnFromRow(row: TurnRow): AgentTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    providerTurnId: row.provider_turn_id,
    usage: parseJson(row.usage_json) as AgentTurn["usage"],
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    reasoningSummary: row.reasoning_summary,
    serviceTier: row.service_tier,
    approvalPolicy: parseJson(
      row.approval_policy_json,
    ) as AgentTurn["approvalPolicy"],
    approvalsReviewer: row.approvals_reviewer,
    permissionMode: row.permission_mode,
    source: turnSourceFromCode(row.origin),
    status: row.status,
    error: parseJson(row.error_json) as AgentTurn["error"],
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function itemPayload(item: AgentItem): Record<string, unknown> {
  const {
    id: _id,
    turnId: _turnId,
    providerItemId: _providerItemId,
    type: _type,
    sequence: _sequence,
    status: _status,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...payload
  } = item;
  return payload;
}

function itemFromRow(row: ItemRow): AgentItem {
  const payload = parseJson(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Invalid agent item payload: " + row.id);
  return {
    id: row.id,
    turnId: row.turn_id,
    providerItemId: row.provider_item_id,
    type: row.type,
    sequence: row.sequence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...payload,
  } as AgentItem;
}

function turnOriginCode(source: AgentTurn["source"]): 0 | 1 {
  return source === "mcp" ? 1 : 0;
}

function turnSourceFromCode(origin: 0 | 1): AgentTurn["source"] {
  return origin === 1 ? "mcp" : "human";
}

function parseJson(value: string | null): unknown {
  return value === null ? null : (JSON.parse(value) as unknown);
}

function monotonicTimestamp(current: string, candidate: string): string {
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  const nextMs = Math.max(
    Number.isFinite(candidateMs) ? candidateMs : Date.now(),
    Number.isFinite(currentMs) ? currentMs + 1 : 0,
  );
  return new Date(nextMs).toISOString();
}
