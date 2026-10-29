import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import {
  api,
  ApiError,
  type AgentHistory,
  type AgentHistoryUpdate,
  type AgentItem,
  type AgentSession,
} from "../api.js";
import { createRequestGate } from "../utils/requests.js";
import type { AgentRefreshHint } from "./useRuntimeEvents.js";

/** Serialize snapshots and patches so a slower snapshot cannot erase a delta. */
export function useAgentHistory(
  selectedId: Ref<string | null>,
  options: {
    onError: (error: unknown) => void;
    onSessionsChanged?: (
      previous: Map<string, AgentSession>,
      next: AgentSession[],
    ) => void;
    request?: typeof api;
  },
) {
  const request = options.request ?? api;
  const sessions = shallowRef<AgentSession[]>([]);
  const history = shallowRef<AgentHistory | null>(null);
  const requests = createRequestGate();
  const pending = new Map<string, AgentRefreshHint>();
  const retryCounts = new Map<string, number>();
  let globalRefresh = false;
  let selectedLoad: string | null = null;
  let worker: Promise<void> | null = null;
  let disposed = false;

  onScopeDispose(() => {
    disposed = true;
    requests.invalidate();
    pending.clear();
    retryCounts.clear();
  });
  watch(
    selectedId,
    (id) => {
      requests.invalidate();
      history.value = null;
      selectedLoad = id;
      void drain();
    },
    { flush: "sync" },
  );

  function merge(change: AgentRefreshHint) {
    const before = pending.get(change.sessionId);
    pending.set(change.sessionId, {
      sessionId: change.sessionId,
      turnIds: [...new Set([...(before?.turnIds ?? []), ...change.turnIds])],
      itemIds: [...new Set([...(before?.itemIds ?? []), ...change.itemIds])],
      deleted: Boolean(before?.deleted || change.deleted),
    });
  }

  function replaceSessions(next: AgentSession[]) {
    const previous = new Map(
      sessions.value.map((session) => [session.id, session]),
    );
    sessions.value = next
      .map((session) => fresherSession(previous.get(session.id), session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    options.onSessionsChanged?.(previous, sessions.value);
    if (
      selectedId.value &&
      !next.some((session) => session.id === selectedId.value)
    )
      selectedId.value = next[0]?.id ?? null;
  }

  function upsert(session: AgentSession): AgentSession {
    const next = new Map(sessions.value.map((entry) => [entry.id, entry]));
    const accepted = fresherSession(next.get(session.id), session);
    next.set(session.id, accepted);
    replaceSessions([...next.values()]);
    return accepted;
  }

  function refresh(changes: AgentRefreshHint[] | null | undefined) {
    if (changes === undefined) return Promise.resolve();
    if (changes === null) globalRefresh = true;
    else changes.forEach(merge);
    return drain();
  }

  function drain(): Promise<void> {
    if (worker) return worker;
    if (disposed) return Promise.resolve();
    worker = Promise.resolve()
      .then(async () => {
        while (!disposed && (globalRefresh || selectedLoad || pending.size)) {
          const full = globalRefresh;
          globalRefresh = false;
          const sessionId = selectedLoad;
          selectedLoad = null;
          const changes = full || sessionId ? [] : [...pending.values()];
          if (!full && !sessionId) pending.clear();
          const token = requests.begin();
          try {
            if (full) {
              const next = await request<AgentSession[]>("/agents/sessions", {
                signal: token.signal,
              });
              if (!requests.isCurrent(token)) continue;
              replaceSessions(next);
              // Only global refresh/reconnect and selection fetch full history.
              selectedLoad = selectedId.value;
            } else if (sessionId) {
              const next = await request<AgentHistory>(
                `/agents/sessions/${encodeURIComponent(sessionId)}/history`,
                { signal: token.signal },
              );
              if (!requests.isCurrent(token) || selectedId.value !== sessionId)
                continue;
              history.value = next;
              upsert(next.session);
            } else {
              for (const change of changes) {
                if (!requests.isCurrent(token)) break;
                if (change.deleted) {
                  replaceSessions(
                    sessions.value.filter(
                      (session) => session.id !== change.sessionId,
                    ),
                  );
                  continue;
                }
                // Bound GET URLs and the endpoint's ID limit for large completions.
                const count = Math.max(
                  1,
                  Math.ceil(change.turnIds.length / 64),
                  Math.ceil(change.itemIds.length / 64),
                );
                let completed = true;
                for (let batch = 0; batch < count; batch++) {
                  const query = new URLSearchParams();
                  query.set(
                    "turnIds",
                    change.turnIds
                      .slice(batch * 64, (batch + 1) * 64)
                      .join(","),
                  );
                  query.set(
                    "itemIds",
                    change.itemIds
                      .slice(batch * 64, (batch + 1) * 64)
                      .join(","),
                  );
                  try {
                    const update = await request<AgentHistoryUpdate>(
                      `/agents/sessions/${encodeURIComponent(change.sessionId)}/update?${query}`,
                      { signal: token.signal },
                    );
                    if (!requests.isCurrent(token)) break;
                    upsert(update.session);
                    if (history.value?.session.id === update.session.id)
                      history.value = patchAgentHistory(history.value, update);
                  } catch (error) {
                    if (!requests.isCurrent(token)) break;
                    if (error instanceof ApiError && error.status === 404) {
                      retryCounts.delete(change.sessionId);
                      replaceSessions(
                        sessions.value.filter(
                          (session) => session.id !== change.sessionId,
                        ),
                      );
                    } else {
                      const attempts =
                        (retryCounts.get(change.sessionId) ?? 0) + 1;
                      if (attempts <= 1) {
                        retryCounts.set(change.sessionId, attempts);
                        merge(change);
                      } else {
                        retryCounts.delete(change.sessionId);
                        options.onError(error);
                      }
                    }
                    completed = false;
                    break;
                  }
                }
                if (completed) retryCounts.delete(change.sessionId);
              }
            }
          } catch (error) {
            if (requests.isCurrent(token)) {
              if (
                error instanceof ApiError &&
                error.status === 404 &&
                sessionId
              )
                replaceSessions(
                  sessions.value.filter((session) => session.id !== sessionId),
                );
              else options.onError(error);
            }
          } finally {
            // Selection or a successful local mutation cancels reads and requeues
            // their invalidations; cancellation must never discard an event.
            if (!disposed && !requests.isCurrent(token)) {
              if (full) globalRefresh = true;
              else if (sessionId && selectedId.value === sessionId)
                selectedLoad = sessionId;
              changes.forEach(merge);
            }
          }
        }
      })
      .finally(() => {
        worker = null;
        if (!disposed && (globalRefresh || selectedLoad || pending.size))
          void drain();
      });
    return worker;
  }

  function reloadSelected() {
    const id = selectedId.value;
    if (!id) return Promise.resolve();
    selectedLoad = id;
    return drain();
  }

  function reconcileSession(session: AgentSession) {
    requests.invalidate();
    const accepted = upsert(session);
    if (history.value?.session.id === session.id)
      history.value = {
        ...history.value,
        session: fresherSession(history.value.session, accepted),
      };
  }

  function removeSession(id: string) {
    removeSessions([id]);
  }

  function removeSessions(ids: readonly string[]) {
    const removed = new Set(ids);
    if (!removed.size) return;
    requests.invalidate();
    replaceSessions(
      sessions.value.filter((session) => !removed.has(session.id)),
    );
    for (const id of removed)
      merge({ sessionId: id, turnIds: [], itemIds: [], deleted: true });
    void drain();
  }

  function reconcileInteraction(sessionId: string, item: AgentItem) {
    requests.invalidate();
    const current = history.value;
    if (!current || current.session.id !== sessionId) return;
    const next = patchAgentHistory(current, {
      session: current.session,
      turns: [],
      items: [item],
    });
    const waiting = next.turns
      .flatMap((entry) => entry.items)
      .filter(
        (entry): entry is Extract<AgentItem, { type: "interaction" }> =>
          entry.type === "interaction" && entry.status === "waiting",
      );
    const session: AgentSession = {
      ...next.session,
      status:
        next.session.status === "waiting_input"
          ? waiting.length
            ? "waiting_input"
            : "running"
          : next.session.status,
      attention: waiting.length
        ? {
            kind: waiting.some((entry) => entry.interaction.kind === "approval")
              ? "approval"
              : "input",
            count: waiting.length,
          }
        : null,
    };
    history.value = { ...next, session };
    upsert(session);
  }

  return {
    sessions,
    history,
    refresh,
    reloadSelected,
    reconcileSession,
    reconcileInteraction,
    removeSession,
    removeSessions,
  };
}

export function patchAgentHistory(
  current: AgentHistory,
  update: AgentHistoryUpdate,
): AgentHistory {
  const turns = new Map(current.turns.map((entry) => [entry.turn.id, entry]));
  for (const turn of update.turns) {
    const entry = turns.get(turn.id);
    turns.set(turn.id, { turn, items: entry?.items ?? [] });
  }
  const itemsByTurn = new Map<string, AgentItem[]>();
  for (const item of update.items) {
    const items = itemsByTurn.get(item.turnId) ?? [];
    items.push(item);
    itemsByTurn.set(item.turnId, items);
  }
  for (const [turnId, updates] of itemsByTurn) {
    const entry = turns.get(turnId);
    if (!entry) throw new Error("Agent update is missing the item's turn");
    const items = new Map(entry.items.map((item) => [item.id, item]));
    for (const item of updates) items.set(item.id, item);
    turns.set(turnId, {
      ...entry,
      items: [...items.values()].sort((a, b) => a.sequence - b.sequence),
    });
  }
  return {
    session: fresherSession(current.session, update.session),
    turns: [...turns.values()].sort((a, b) =>
      a.turn.startedAt.localeCompare(b.turn.startedAt),
    ),
  };
}

function fresherSession(
  current: AgentSession | undefined,
  incoming: AgentSession,
): AgentSession {
  if (!current) return incoming;
  return current.updatedAt.localeCompare(incoming.updatedAt) >= 0
    ? current
    : incoming;
}
