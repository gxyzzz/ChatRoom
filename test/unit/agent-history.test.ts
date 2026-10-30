import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, ref } from "vue";
import {
  patchAgentHistory,
  useAgentHistory,
} from "../../src/plugins/web/ui/composables/useAgentHistory.js";
import { ApiError } from "../../src/plugins/web/ui/api.js";
import type {
  api,
  AgentHistory,
  AgentHistoryUpdate,
  AgentItem,
  AgentSession,
} from "../../src/plugins/web/ui/api.js";

const session: AgentSession = {
  id: "a",
  workspaceId: "workspace-id",
  workspaceName: "Workspace",
  provider: "codex",
  status: "running",
  attention: null,
  model: null,
  reasoningEffort: null,
  reasoningSummary: null,
  serviceTier: null,
  approvalPolicy: null,
  approvalsReviewer: null,
  permissionMode: null,
  tokenUsage: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const snapshot: AgentHistory = {
  session,
  turns: [
    {
      turn: {
        ...session,
        id: "turn",
        sessionId: "a",
        providerTurnId: null,
        source: "human",
        status: "running",
        error: null,
        usage: null,
        startedAt: "2026-01-01",
        completedAt: null,
      },
      items: [],
    },
  ],
};
function harness() {
  const requests: Array<{
    path: string;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  const scope = effectScope();
  const selectedId = ref<string | null>(null);
  const errors: unknown[] = [];
  const request = ((path: string, init: { signal: AbortSignal }) =>
    new Promise<unknown>((resolve, reject) => {
      requests.push({ path, signal: init.signal, resolve, reject });
    })) as typeof api;
  const state = scope.run(() =>
    useAgentHistory(selectedId, {
      request,
      onError: (error) => errors.push(error),
      onSessionsChanged: () => {},
    }),
  )!;
  return { ...state, requests, selectedId, errors, stop: () => scope.stop() };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const hint = { sessionId: "a", turnIds: ["turn"], itemIds: [], deleted: false };

test("Agent initial list and selected snapshot serialize with SSE patches and preserve untouched items", async () => {
  const state = harness();
  try {
    const loading = state.refresh(null);
    await flush();
    void state.refresh([hint]);
    assert.equal(state.requests.length, 1);
    state.requests[0]!.resolve([session]);
    await flush();
    assert.match(state.requests[1]!.path, /\/update/);
    state.requests[1]!.resolve({ session, turns: [], items: [] });
    await loading;
    state.selectedId.value = "a";
    await flush();
    assert.match(state.requests[2]!.path, /\/history$/);
    void state.refresh([hint]);
    assert.equal(state.requests.length, 3);
    const old: AgentItem = {
      id: "old",
      turnId: "turn",
      providerItemId: null,
      sequence: 0,
      status: "completed",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      type: "assistant_message",
      text: "old",
      phase: null,
    };
    state.requests[2]!.resolve({
      ...snapshot,
      turns: [{ ...snapshot.turns[0]!, items: [old] }],
    });
    await flush();
    const update: AgentHistoryUpdate = {
      session: {
        ...session,
        status: "idle",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      turns: [{ ...snapshot.turns[0]!.turn, status: "completed" }],
      items: [{ ...old, id: "new", sequence: 1, text: "latest" }],
    };
    state.requests[3]!.resolve(update);
    await state.refresh([]);
    assert.equal(state.history.value!.session.status, "idle");
    assert.equal(state.history.value!.turns[0]!.items[0], old);
    assert.equal(state.history.value!.turns[0]!.items.length, 2);
    assert.equal(
      state.requests.filter((request) => request.path.endsWith("/history"))
        .length,
      1,
    );
    assert.deepEqual(state.errors, []);
  } finally {
    state.stop();
  }
});

test("Agent selection and optimistic interaction cancel stale reads without dropping invalidations", async () => {
  const state = harness();
  try {
    state.reconcileSession(session);
    state.selectedId.value = "a";
    await flush();
    state.selectedId.value = "b";
    state.selectedId.value = "a";
    assert.equal(state.requests[0]!.signal.aborted, true);
    state.requests[0]!.resolve({
      ...snapshot,
      session: { ...session, model: "stale" },
    });
    await flush();
    const item: AgentItem = {
      id: "approval",
      turnId: "turn",
      providerItemId: null,
      sequence: 0,
      status: "waiting",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      type: "interaction",
      interaction: {
        kind: "approval",
        title: "Allow?",
        description: null,
        questions: [],
        approvalOptions: [],
        response: null,
      },
    };
    const waiting = {
      ...session,
      status: "waiting_input" as const,
      attention: { kind: "approval" as const, count: 1 },
    };
    state.requests[1]!.resolve({
      ...snapshot,
      session: waiting,
      turns: [{ ...snapshot.turns[0]!, items: [item] }],
    });
    await state.refresh([]);
    assert.equal(state.history.value!.session.model, null);
    const refreshing = state.refresh([{ ...hint, itemIds: [item.id] }]);
    await flush();
    const resolved: AgentItem = {
      ...item,
      status: "completed",
      interaction: {
        ...item.interaction,
        response: { type: "approval", decision: "yes" },
      },
    };
    state.reconcileInteraction("a", resolved);
    assert.equal(state.requests[2]!.signal.aborted, true);
    assert.equal(state.history.value!.session.attention, null);
    assert.equal(state.sessions.value[0]!.status, "running");
    state.requests[2]!.resolve({
      session: waiting,
      turns: snapshot.turns.map((entry) => entry.turn),
      items: [item],
    });
    await flush();
    assert.equal(state.history.value!.turns[0]!.items[0]!.status, "completed");
    assert.match(state.requests[3]!.path, /itemIds=approval/);
    state.requests[3]!.resolve({
      session,
      turns: snapshot.turns.map((entry) => entry.turn),
      items: [resolved],
    });
    await refreshing;
    assert.equal(state.history.value!.turns[0]!.items[0]!.status, "completed");
    assert.equal(
      state.requests.filter((request) => request.path.endsWith("/history"))
        .length,
      2,
    );
    assert.deepEqual(state.errors, []);
  } finally {
    state.stop();
  }
});

test("Agent transient delta failures retry once instead of dropping the update", async () => {
  const state = harness();
  try {
    state.reconcileSession(session);
    state.selectedId.value = "a";
    await flush();
    state.requests[0]!.resolve(snapshot);
    await state.refresh([]);

    const latest: AgentItem = {
      id: "latest",
      turnId: "turn",
      providerItemId: null,
      sequence: 0,
      status: "completed",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
      type: "assistant_message",
      text: "latest",
      phase: null,
    };

    const refreshing = state.refresh([{ ...hint, itemIds: [latest.id] }]);
    await flush();
    assert.match(state.requests[1]!.path, /\/update/);
    state.requests[1]!.reject(
      new ApiError(503, "SERVER_ERROR", "temporary", null),
    );
    await flush();

    assert.match(state.requests[2]!.path, /itemIds=latest/);
    state.requests[2]!.resolve({
      session: {
        ...session,
        status: "idle",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      turns: [snapshot.turns[0]!.turn],
      items: [latest],
    });
    await refreshing;

    assert.equal(state.history.value!.session.status, "idle");
    const item = state.history.value!.turns[0]!.items[0]!;
    assert.equal(item.type, "assistant_message");
    if (item.type === "assistant_message") assert.equal(item.text, "latest");
    assert.deepEqual(state.errors, []);
  } finally {
    state.stop();
  }
});

test("Agent history rejects older session snapshots", () => {
  const newer = {
    ...session,
    model: "new",
    status: "running" as const,
    updatedAt: "2026-01-02",
  };
  const older = {
    ...session,
    model: "old",
    status: "idle" as const,
    updatedAt: "2026-01-01",
  };
  const patched = patchAgentHistory(
    { ...snapshot, session: newer },
    { session: older, turns: [], items: [] },
  );
  assert.equal(patched.session.model, "new");
  assert.equal(patched.session.status, "running");
});

test("Agent history keeps the already accepted session when timestamps tie", () => {
  const accepted = {
    ...session,
    model: "new",
    status: "running" as const,
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  const late = {
    ...session,
    model: "old",
    status: "idle" as const,
    updatedAt: accepted.updatedAt,
  };
  const patched = patchAgentHistory(
    { ...snapshot, session: accepted },
    { session: late, turns: [], items: [] },
  );
  assert.equal(patched.session.model, "new");
  assert.equal(patched.session.status, "running");
});
