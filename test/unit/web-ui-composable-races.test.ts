import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type {
  ComputerPreviewView,
  ComputerStatus,
  GitStatus,
  Operation,
  ProcessSnapshot,
  ProcessSummary,
} from "../../src/plugins/web/ui/api.js";
import { useComputer } from "../../src/plugins/web/ui/composables/useComputer.js";
import { useOperations } from "../../src/plugins/web/ui/composables/useOperations.js";
import { useProcesses } from "../../src/plugins/web/ui/composables/useProcesses.js";
import { useWorkspaceGit } from "../../src/plugins/web/ui/composables/useWorkspaceGit.js";
import { useWorkspaceFiles } from "../../src/plugins/web/ui/composables/useWorkspaceFiles.js";
import { createRequestGate } from "../../src/plugins/web/ui/utils/requests.js";

interface PendingRequest {
  url: string;
  signal: AbortSignal | null;
  resolve(body: unknown, status?: number): void;
  reject(error: unknown): void;
}

const flush = async () => {
  await nextTick();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function installHttpHarness() {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const requests: PendingRequest[] = [];

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      location: { hostname: "localhost" },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return await new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      const request: PendingRequest = {
        url,
        signal,
        resolve(body, status = 200) {
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
          );
        },
        reject,
      };
      requests.push(request);
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;

  return {
    requests,
    restore() {
      globalThis.fetch = previousFetch;
      if (previousWindow === undefined)
        Reflect.deleteProperty(globalThis, "window");
      else
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: previousWindow,
        });
    },
  };
}

function processSummary(processId: string): ProcessSummary {
  return {
    processId,
    command: processId,
    args: [],
    state: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 0,
  };
}

function processSnapshot(processId: string, stdout: string): ProcessSnapshot {
  return {
    ...processSummary(processId),
    cwd: "/workspace",
    pid: 1,
    stdout,
    stderr: "",
    outputTruncated: false,
    timedOut: false,
    operationId: "op-" + processId,
    exitCode: null,
    signal: null,
    finishedAt: null,
  };
}

function operation(
  operationId: string,
  status: Operation["status"] = "running",
  startedAt = "2026-01-01T00:00:00.000Z",
): Operation {
  return {
    operationId,
    pluginId: "workspace",
    action: "test",
    source: "gui",
    status,
    startedAt,
    processId: null,
    input: null,
    output: null,
    error: null,
    inputTruncated: false,
    outputTruncated: false,
    finishedAt: status === "running" ? null : startedAt,
    durationMs: status === "running" ? null : 0,
  };
}

test("Process realtime patch wins over stale detail and disposal stops queued patch requests", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref<Array<{
    processId: string;
    output: boolean;
    summary: boolean;
    deleted: boolean;
  }> | null>([]);
  const scope = effectScope();
  const state = scope.run(() =>
    useProcesses(
      () => revision.value,
      () => changes.value,
    ),
  )!;

  try {
    await flush();
    assert.equal(http.requests[0]?.url, "/api/processes");
    http.requests[0]!.resolve([processSummary("a"), processSummary("b")]);
    await flush();

    state.select("a");
    await flush();
    const staleDetail = http.requests.at(-1)!;
    assert.equal(staleDetail.url, "/api/processes/a");

    changes.value = [
      { processId: "a", output: true, summary: false, deleted: false },
    ];
    revision.value += 1;
    await flush();
    const patch = http.requests.at(-1)!;
    assert.equal(patch.url, "/api/processes/a");
    patch.resolve(processSnapshot("a", "new"));
    await flush();
    assert.equal(state.detail.value?.stdout, "new");
    assert.equal(staleDetail.signal?.aborted, true);

    staleDetail.resolve(processSnapshot("a", "old"));
    await flush();
    assert.equal(state.detail.value?.stdout, "new");

    changes.value = [
      { processId: "a", output: true, summary: false, deleted: false },
    ];
    revision.value += 1;
    await flush();
    const stalePatchAfterReselect = http.requests.at(-1)!;
    state.select("b");
    await flush();
    state.select("a");
    await flush();
    const freshDetail = http.requests.at(-1)!;
    freshDetail.resolve(processSnapshot("a", "fresh"));
    await flush();
    stalePatchAfterReselect.resolve(processSnapshot("a", "stale-patch"));
    await flush();
    assert.equal(state.detail.value?.stdout, "fresh");

    changes.value = [
      { processId: "a", output: false, summary: true, deleted: false },
    ];
    revision.value += 1;
    await flush();
    const inFlight = http.requests.at(-1)!;
    changes.value = [
      { processId: "b", output: false, summary: true, deleted: false },
    ];
    revision.value += 1;
    await flush();
    const beforeStop = http.requests.length;
    scope.stop();
    inFlight.resolve(processSummary("a"));
    await flush();
    assert.equal(http.requests.length, beforeStop);
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Process stream merges output without repeated snapshots and resynchronizes", async () => {
  const previous = globalThis.EventSource;
  const streams: FakeProcessStream[] = [];
  class FakeProcessStream {
    readonly listeners = new Map<string, EventListener>();
    closed = false;
    onerror: ((event: Event) => void) | null = null;

    constructor(readonly url: string) {
      streams.push(this);
    }

    addEventListener(type: string, listener: EventListener): void {
      this.listeners.set(type, listener);
    }

    emit(type: string, payload: unknown): void {
      this.listeners.get(type)?.({
        data: JSON.stringify(payload),
      } as MessageEvent);
    }

    close(): void {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeProcessStream as unknown as typeof EventSource;
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref([
    { processId: "a", output: true, summary: false, deleted: false },
  ]);
  const scope = effectScope();
  const state = scope.run(() => useProcesses(revision, () => changes.value))!;

  try {
    await flush();
    http.requests[0]!.resolve([processSummary("a")]);
    await flush();
    state.select("a");
    await flush();
    assert.equal(streams[0]?.url, "/api/processes/a/stream");
    assert.equal(http.requests.length, 1);

    const stream = streams[0]!;
    stream.emit("snapshot", processSnapshot("a", "start"));
    const chinese = Buffer.from("中");
    stream.emit("output", {
      stream: "stdout",
      bytes: chinese.subarray(0, 2).toString("base64"),
    });
    stream.emit("output", {
      stream: "stdout",
      bytes: chinese.subarray(2).toString("base64"),
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    await flush();
    assert.equal(state.detail.value?.stdout, "start中");

    revision.value += 1;
    await flush();
    assert.equal(
      http.requests.length,
      1,
      "Output events should not fetch full process snapshots",
    );

    stream.onerror?.(new Event("error"));
    stream.emit("snapshot", processSnapshot("a", "recovered"));
    stream.emit("output", {
      stream: "stdout",
      bytes: Buffer.from("-next").toString("base64"),
    });
    const final = {
      ...processSnapshot("a", "ignored"),
      state: "exited" as const,
    };
    const { stdout: _stdout, stderr: _stderr, ...status } = final;
    stream.emit("exit", status);
    await flush();
    assert.equal(state.detail.value?.stdout, "recovered-next");
    assert.equal(state.detail.value?.state, "exited");
    assert.equal(state.items.value[0]?.state, "exited");
    assert.equal(stream.closed, true);
    assert.equal(http.requests.length, 1);
  } finally {
    scope.stop();
    http.restore();
    if (previous === undefined)
      Reflect.deleteProperty(globalThis, "EventSource");
    else globalThis.EventSource = previous;
  }
});

test("Operation realtime patch keeps server paging offset stable and wins over stale detail", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref<{
    changes: Array<{ operationId: string; pluginId: string }>;
    clearAll: boolean;
  } | null>({
    changes: [],
    clearAll: false,
  });
  const scope = effectScope();
  const state = scope.run(() =>
    useOperations(
      () => revision.value,
      () => changes.value,
    ),
  )!;

  try {
    await flush();
    const initial = Array.from({ length: 50 }, (_, index) =>
      operation(
        String(index + 1),
        "running",
        new Date(Date.UTC(2026, 0, 1, 0, 0, 50 - index)).toISOString(),
      ),
    );
    http.requests[0]!.resolve(initial);
    await flush();

    state.select(initial[0]!);
    await flush();
    const staleDetail = http.requests.at(-1)!;

    changes.value = {
      changes: [
        { operationId: initial[0]!.operationId, pluginId: "workspace" },
      ],
      clearAll: false,
    };
    revision.value += 1;
    await flush();
    const patch = http.requests.at(-1)!;
    patch.resolve({ ...initial[0]!, status: "success" });
    await flush();
    assert.equal(state.detail.value?.status, "success");
    assert.equal(staleDetail.signal?.aborted, true);

    staleDetail.resolve(initial[0]!);
    await flush();
    assert.equal(state.detail.value?.status, "success");

    changes.value = {
      changes: [
        { operationId: initial[0]!.operationId, pluginId: "workspace" },
      ],
      clearAll: false,
    };
    revision.value += 1;
    await flush();
    const stalePatchAfterReselect = http.requests.at(-1)!;
    state.select(initial[1]!);
    await flush();
    state.select(initial[0]!);
    await flush();
    const freshDetail = http.requests.at(-1)!;
    freshDetail.resolve({ ...initial[0]!, status: "success" });
    await flush();
    stalePatchAfterReselect.resolve(initial[0]!);
    await flush();
    assert.equal(state.detail.value?.status, "success");

    changes.value = {
      changes: [{ operationId: "old-extra", pluginId: "workspace" }],
      clearAll: false,
    };
    revision.value += 1;
    await flush();
    http.requests
      .at(-1)!
      .resolve(operation("old-extra", "success", "2025-01-01T00:00:00.000Z"));
    await flush();

    const loadingMore = state.loadMore();
    await flush();
    const pageUrl = new URL(http.requests.at(-1)!.url, "http://chatroom.local");
    assert.equal(pageUrl.searchParams.has("offset"), false);
    assert.equal(
      pageUrl.searchParams.get("beforeStartedAt"),
      initial.at(-1)!.startedAt,
    );
    assert.equal(
      pageUrl.searchParams.get("beforeOperationId"),
      initial.at(-1)!.operationId,
    );
    http.requests.at(-1)!.resolve([]);
    await loadingMore;
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Process realtime batch commits successful patches and retries only failed entities", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref<Array<{
    processId: string;
    output: boolean;
    summary: boolean;
    deleted: boolean;
  }> | null>([]);
  const scope = effectScope();
  const state = scope.run(() =>
    useProcesses(
      () => revision.value,
      () => changes.value,
    ),
  )!;

  try {
    await flush();
    http.requests[0]!.resolve([processSummary("a"), processSummary("b")]);
    await flush();

    const before = http.requests.length;
    changes.value = [
      { processId: "a", output: false, summary: true, deleted: false },
      { processId: "b", output: false, summary: true, deleted: false },
    ];
    revision.value += 1;
    await flush();

    const batch = http.requests.slice(before);
    assert.equal(batch.length, 2);
    batch
      .find((request) => request.url.endsWith("/a/summary"))!
      .resolve({
        ...processSummary("a"),
        state: "exited",
      });
    batch
      .find((request) => request.url.endsWith("/b/summary"))!
      .resolve({ code: "INTERNAL", message: "temporary" }, 500);
    await flush();
    await flush();

    assert.equal(
      state.items.value.find((item) => item.processId === "a")?.state,
      "exited",
    );
    const retry = http.requests.at(-1)!;
    assert.equal(retry.url, "/api/processes/b/summary");
    retry.resolve({ ...processSummary("b"), state: "killed" });
    await flush();
    assert.equal(
      state.items.value.find((item) => item.processId === "b")?.state,
      "killed",
    );
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Operation realtime batch commits successes, retries failures, and clear-all drops selected detail", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref<{
    changes: Array<{ operationId: string; pluginId: string }>;
    clearAll: boolean;
  } | null>({ changes: [], clearAll: false });
  const scope = effectScope();
  const state = scope.run(() =>
    useOperations(
      () => revision.value,
      () => changes.value,
    ),
  )!;

  try {
    await flush();
    const first = operation("a");
    const second = operation("b");
    http.requests[0]!.resolve([first, second]);
    await flush();

    const before = http.requests.length;
    changes.value = {
      changes: [
        { operationId: "a", pluginId: "workspace" },
        { operationId: "b", pluginId: "workspace" },
      ],
      clearAll: false,
    };
    revision.value += 1;
    await flush();

    const batch = http.requests.slice(before);
    assert.equal(batch.length, 2);
    batch
      .find((request) => request.url.endsWith("/a"))!
      .resolve({ ...first, status: "success" });
    batch
      .find((request) => request.url.endsWith("/b"))!
      .resolve({ code: "INTERNAL", message: "temporary" }, 500);
    await flush();
    await flush();

    assert.equal(
      state.events.value.find((item) => item.operationId === "a")?.status,
      "success",
    );
    const retry = http.requests.at(-1)!;
    assert.equal(retry.url, "/api/operations/b");
    retry.resolve({ ...second, status: "cancelled" });
    await flush();

    state.select(first);
    changes.value = { changes: [], clearAll: true };
    revision.value += 1;
    await flush();
    assert.equal(state.selected.value, null);
    assert.equal(state.detail.value, null);
    assert.equal(state.events.value.length, 0);

    const reload = http.requests.at(-1)!;
    assert.match(reload.url, /^\/api\/operations\?/);
    reload.resolve([]);
    await flush();
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Operation clear-all aborts an in-flight realtime patch", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref<{
    changes: Array<{ operationId: string; pluginId: string }>;
    clearAll: boolean;
  } | null>({ changes: [], clearAll: false });
  const scope = effectScope();
  const state = scope.run(() =>
    useOperations(
      () => revision.value,
      () => changes.value,
    ),
  )!;

  try {
    await flush();
    const first = operation("a");
    http.requests[0]!.resolve([first]);
    await flush();

    changes.value = {
      changes: [{ operationId: "a", pluginId: "workspace" }],
      clearAll: false,
    };
    revision.value += 1;
    await flush();
    const patch = http.requests.at(-1)!;
    assert.equal(patch.url, "/api/operations/a");

    changes.value = { changes: [], clearAll: true };
    revision.value += 1;
    await flush();
    assert.equal(patch.signal?.aborted, true);
    assert.equal(state.events.value.length, 0);

    const reload = http.requests.at(-1)!;
    assert.match(reload.url, /^\/api\/operations\?/);
    reload.resolve([]);
    await flush();
    assert.equal(state.events.value.length, 0);
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Operation global reconciliation clears a selected entity that disappeared", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref<{
    changes: Array<{ operationId: string; pluginId: string }>;
    clearAll: boolean;
  } | null>({ changes: [], clearAll: false });
  const scope = effectScope();
  const state = scope.run(() =>
    useOperations(
      () => revision.value,
      () => changes.value,
    ),
  )!;

  try {
    await flush();
    const first = operation("a");
    http.requests[0]!.resolve([first]);
    await flush();

    state.select(first);
    await flush();
    const initialDetail = http.requests.at(-1)!;
    initialDetail.resolve(first);
    await flush();

    changes.value = null;
    revision.value += 1;
    await flush();

    const reload = http.requests.at(-1)!;
    assert.match(reload.url, /^\/api\/operations\?/);
    reload.resolve([]);
    await flush();

    const revalidate = http.requests.at(-1)!;
    assert.equal(revalidate.url, "/api/operations/a");
    revalidate.resolve(
      { error: { code: "NOT_FOUND", message: "Operation not found" } },
      404,
    );
    await flush();

    assert.equal(state.selected.value, null);
    assert.equal(state.detail.value, null);
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Computer newer status and preview responses win over older action responses", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref({
    status: false,
    preview: false,
    previewSnapshotId: null as string | null,
    operationsReset: false,
    operationIds: [] as string[],
  });
  const scope = effectScope();
  const state = scope.run(() =>
    useComputer(
      () => revision.value,
      () => changes.value,
    ),
  )!;

  try {
    await flush();
    http.requests
      .find((request) => request.url === "/api/computer/status")!
      .resolve(computerStatus("unknown"));
    http.requests
      .find((request) => request.url.startsWith("/api/operations?"))!
      .resolve([]);
    http.requests
      .find((request) => request.url === "/api/computer/preview")!
      .resolve(null);
    await flush();

    const permission = state.requestPermission("accessibility");
    await flush();
    const permissionRequest = http.requests.at(-1)!;
    assert.equal(
      permissionRequest.url,
      "/api/computer/permissions/accessibility/request",
    );

    changes.value = {
      status: true,
      preview: false,
      previewSnapshotId: null,
      operationsReset: false,
      operationIds: [],
    };
    revision.value += 1;
    await flush();
    assert.equal(permissionRequest.signal?.aborted, true);
    const statusRequest = http.requests.at(-1)!;
    assert.equal(statusRequest.url, "/api/computer/status");
    statusRequest.resolve(computerStatus("granted"));
    await permission;
    await flush();
    assert.equal(state.status.value?.permissions.accessibility, "granted");

    const snapshot = state.refreshSnapshot();
    await flush();
    const snapshotRequest = http.requests.at(-1)!;
    assert.equal(snapshotRequest.url, "/api/computer/snapshot");

    changes.value = {
      status: false,
      preview: true,
      previewSnapshotId: "newer",
      operationsReset: false,
      operationIds: [],
    };
    revision.value += 1;
    await flush();
    assert.equal(snapshotRequest.signal?.aborted, true);
    const previewRequest = http.requests.at(-1)!;
    assert.equal(previewRequest.url, "/api/computer/preview");
    previewRequest.resolve(computerPreview("newer", 2));
    await snapshot;
    await flush();
    assert.equal(state.preview.value?.snapshotId, "newer");
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Process stop reconciles its entity without overwriting newer SSE state and cancels on disposal", async () => {
  const http = installHttpHarness();
  const revision = ref(0);
  const changes = ref([
    { processId: "a", output: true, summary: true, deleted: false },
  ]);
  const scope = effectScope();
  const state = scope.run(() => useProcesses(revision, () => changes.value))!;

  try {
    http.requests[0]!.resolve([processSummary("a")]);
    await flush();
    state.select("a");
    await flush();
    http.requests.at(-1)!.resolve(processSnapshot("a", "initial"));
    await flush();

    const stopping = state.stop("a", false);
    const stalePost = http.requests.at(-1)!;
    assert.equal(stalePost.url, "/api/processes/a/terminate");
    revision.value += 1;
    await flush();
    const completed: ProcessSnapshot = {
      ...processSnapshot("a", "finished"),
      state: "exited",
    };
    http.requests.at(-1)!.resolve(completed);
    await flush();

    stalePost.resolve(processSnapshot("a", "old"));
    await flush();
    assert.equal(state.items.value[0]?.state, "exited");
    assert.equal(state.detail.value?.stdout, "finished");
    assert.equal(http.requests.at(-1)?.url, "/api/processes/a");
    http.requests.at(-1)!.resolve(completed);
    await stopping;
    assert.equal(state.detail.value?.state, "exited");

    const pendingStop = state.stop("a", true);
    const pendingPost = http.requests.at(-1)!;
    const count = http.requests.length;
    scope.stop();
    await pendingStop;
    assert.equal(pendingPost.signal?.aborted, true);
    assert.equal(http.requests.length, count);
    await state.stop("a", true);
    assert.equal(http.requests.length, count);
  } finally {
    scope.stop();
    http.restore();
  }
});

test("Workspace Git blocks refresh during mutations and cancels old-root and disposed actions", async () => {
  const http = installHttpHarness();
  const root = ref("A");
  const scope = effectScope();
  const state = scope.run(() => useWorkspaceGit(root))!;
  const status: GitStatus = {
    branch: "main",
    head: "head",
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
  };
  const resolveAncillary = async () => {
    assert.match(http.requests.at(-2)!.url, /\/git\/branches\?/);
    assert.match(http.requests.at(-1)!.url, /\/git\/log\?/);
    http.requests.at(-2)!.resolve([]);
    http.requests.at(-1)!.resolve([]);
    await flush();
  };

  try {
    http.requests[0]!.resolve(status);
    await flush();
    await resolveAncillary();

    const staging = state.stage(["a.txt"]);
    const post = http.requests.at(-1)!;
    const count = http.requests.length;
    await state.load();
    assert.equal(http.requests.length, count);
    assert.equal(state.busy.value, "stage");
    post.resolve(status);
    await flush();
    await resolveAncillary();
    assert.equal(await staging, true);
    assert.equal(state.busy.value, null);

    const oldAction = state.stage(["a.txt"]);
    const oldPost = http.requests.at(-1)!;
    root.value = "B";
    await flush();
    assert.equal(oldPost.signal?.aborted, true);
    assert.equal(await oldAction, false);
    assert.equal(state.busy.value, null);
    assert.equal(state.status.value, null);
    assert.equal(http.requests.at(-1)?.url, "/api/git/status?root=B");
    http.requests.at(-1)!.resolve(status);
    await flush();
    await resolveAncillary();

    const pendingAction = state.stage(["b.txt"]);
    const pendingPost = http.requests.at(-1)!;
    const beforeDispose = http.requests.length;
    scope.stop();
    assert.equal(await pendingAction, false);
    assert.equal(pendingPost.signal?.aborted, true);
    await state.load();
    assert.equal(await state.stage(["b.txt"]), false);
    assert.equal(http.requests.length, beforeDispose);
  } finally {
    scope.stop();
    http.restore();
  }
});

for (const feature of ["process", "operations", "computer"] as const) {
  test(`${feature} retries a failed initial list on the next entity event`, async () => {
    const http = installHttpHarness();
    const revision = ref(0);
    const scope = effectScope();
    const result = scope.run(() => {
      if (feature === "process") {
        const state = useProcesses(revision, () => [
          { processId: "a", output: false, summary: true, deleted: false },
        ]);
        return {
          listUrl: "/api/processes",
          entityUrl: "/api/processes/a/summary",
          item: processSummary("a"),
          ids: () => state.items.value.map((item) => item.processId),
        };
      }
      if (feature === "operations") {
        const state = useOperations(revision, () => ({
          changes: [{ operationId: "a", pluginId: "workspace" }],
          clearAll: false,
        }));
        return {
          listUrl: "/api/operations?limit=50",
          entityUrl: "/api/operations/a",
          item: operation("a"),
          ids: () => state.events.value.map((item) => item.operationId),
        };
      }
      const state = useComputer(revision, () => ({
        status: false,
        preview: false,
        previewSnapshotId: null,
        operationsReset: false,
        operationIds: ["a"],
      }));
      return {
        listUrl: "/api/operations?pluginId=computer&limit=50",
        entityUrl: "/api/operations/a",
        item: { ...operation("a"), pluginId: "computer" },
        ids: () => state.operations.value.map((item) => item.operationId),
      };
    })!;

    try {
      for (const request of http.requests) {
        if (request.url === result.listUrl)
          request.resolve(
            { error: { code: "UNAVAILABLE", message: "retry" } },
            503,
          );
        else if (request.url.endsWith("/status"))
          request.resolve(computerStatus("granted"));
        else request.resolve(null);
      }
      await flush();
      revision.value += 1;
      await flush();
      assert.equal(http.requests.at(-1)?.url, result.listUrl);
      assert.equal(
        http.requests.filter((item) => item.url === result.listUrl).length,
        2,
      );
      http.requests.at(-1)!.resolve([result.item]);
      await flush();
      assert.equal(http.requests.at(-1)?.url, result.entityUrl);
      http.requests.at(-1)!.resolve(result.item);
      await flush();
      assert.deepEqual(result.ids(), ["a"]);
    } finally {
      scope.stop();
      http.restore();
    }
  });
}

test("Workspace Files pagination cannot interrupt a refresh or leave an image at its old version", async () => {
  const http = installHttpHarness();
  const scope = effectScope();
  const state = scope.run(() => useWorkspaceFiles(ref("A")))!;
  const image = {
    path: "image.png",
    type: "file",
    size: 10,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  } as const;

  try {
    http.requests[0]!.resolve({ items: [image], nextOffset: 300 });
    await flush();
    await state.openEntry(image);
    const original = state.file.value;
    assert.equal(original?.kind, "image");

    const refresh = state.loadDirectory();
    const request = http.requests.at(-1)!;
    const count = http.requests.length;
    await state.loadMore();
    assert.equal(http.requests.length, count);
    assert.equal(request.signal?.aborted, false);
    request.resolve({
      items: [{ ...image, modifiedAt: "2026-01-02T00:00:00.000Z" }],
      nextOffset: 300,
    });
    await refresh;
    assert.equal(state.file.value?.kind, "image");
    if (state.file.value?.kind === "image" && original?.kind === "image") {
      assert.notEqual(state.file.value.url, original.url);
      assert.match(state.file.value.url, /v=2026-01-02/);
    }

    const more = state.loadMore();
    assert.match(http.requests.at(-1)!.url, /offset=300$/);
    http.requests.at(-1)!.resolve({ items: [], nextOffset: null });
    await more;
    assert.equal(state.nextOffset.value, null);
  } finally {
    scope.stop();
    http.restore();
  }
});

test("RequestGate cannot create a current request after its Vue scope is disposed", () => {
  const scope = effectScope();
  const gate = scope.run(() => createRequestGate())!;
  const active = gate.begin();
  assert.equal(gate.isCurrent(active), true);
  scope.stop();
  assert.equal(active.signal.aborted, true);

  const afterDispose = gate.begin();
  assert.equal(afterDispose.signal.aborted, true);
  assert.equal(gate.isCurrent(afterDispose), false);
});

function computerStatus(
  accessibility: ComputerStatus["permissions"]["accessibility"],
): ComputerStatus {
  return {
    platform: "macos",
    helper: "running",
    permissions: {
      accessibility,
      screenRecording: "granted",
    },
    displays: [],
    settings: {
      enabled: true,
      remoteAccess: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function computerPreview(
  snapshotId: string,
  revision: number,
): ComputerPreviewView {
  return {
    snapshotId,
    revision,
    capturedAt: "2026-01-01T00:00:00.000Z",
    display: null,
    activeApp: null,
    activeWindow: null,
    cursor: null,
    elementCount: 0,
    screenshot: { mimeType: "image/png" },
  };
}
