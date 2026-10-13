import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type WatchSource,
} from "vue";
import {
  ApiError,
  api,
  type ProcessSnapshot,
  type ProcessSummary,
} from "../api.js";
import type { ProcessRefreshHint } from "./useRuntimeEvents.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";
import { createEntityRefreshQueue } from "../utils/entity-refresh-queue.js";

const MAX_VISIBLE_OUTPUT = 512 * 1024;

function appendOutput(current: string, delta: string): string {
  const value = current + delta;
  return value.length <= MAX_VISIBLE_OUTPUT
    ? value
    : "[earlier output truncated]\n" + value.slice(-MAX_VISIBLE_OUTPUT);
}

export function useProcesses(
  revision: WatchSource<number>,
  changes: () => ProcessRefreshHint[] | null,
) {
  const items = shallowRef<ProcessSummary[]>([]);
  const selected = shallowRef<string | null>(null);
  const detail = shallowRef<ProcessSnapshot | null>(null);
  const error = shallowRef("");
  const loading = shallowRef(false);
  const refreshRequests = createRequestGate();
  const detailRequests = createRequestGate();
  let initialStarted = false;
  let initialLoaded = false;
  const retryCounts = new Map<string, number>();
  const stopRequests = new Set<AbortController>();
  let selectionGeneration = 0;
  let outputStream: EventSource | null = null;
  let streamReady = false;
  let disposed = false;
  const refreshQueue = createEntityRefreshQueue<ProcessRefreshHint>({
    keyOf: (change) => change.processId,
    merge: mergeProcessRefresh,
    isReady: () => initialLoaded,
    isLoading: () => loading.value,
    isDisposed: () => disposed,
    refreshAll: loadInitial,
    applyBatch: applyChangesBatch,
  });

  onScopeDispose(() => {
    disposed = true;
    outputStream?.close();
    outputStream = null;
    streamReady = false;
    initialLoaded = false;
    refreshQueue.reset();
    retryCounts.clear();
    refreshRequests.invalidate();
    detailRequests.invalidate();
    for (const request of stopRequests) request.abort();
    stopRequests.clear();
  });

  const processOutput = computed(() => {
    if (!detail.value) return "";
    const stderr = detail.value.stderr
      ? `\n\n[stderr]\n${detail.value.stderr}`
      : "";
    return `${detail.value.stdout}${stderr}`;
  });

  watch(
    revision,
    () => {
      if (!initialStarted) {
        initialStarted = true;
        void loadInitial();
        return;
      }
      refreshQueue.enqueue(changes());
    },
    { immediate: true },
  );
  watch(selected, () => {
    selectionGeneration += 1;
    detailRequests.invalidate();
    outputStream?.close();
    outputStream = null;
    streamReady = false;
    const processId = selected.value;
    if (!processId) return;
    if (typeof EventSource === "undefined")
      void loadDetail(selectionGeneration);
    else connectOutput(processId, selectionGeneration);
  });

  async function loadInitial() {
    if (disposed) return;
    initialLoaded = false;
    const request = refreshRequests.begin();
    loading.value = true;
    error.value = "";
    try {
      const next = await api<ProcessSummary[]>("/processes", {
        signal: request.signal,
      });
      if (disposed || !refreshRequests.isCurrent(request)) return;
      items.value = next;
      initialLoaded = true;
      if (
        selected.value &&
        !next.some((item) => item.processId === selected.value)
      ) {
        clearSelection();
      } else if (selected.value && !outputStream) {
        void loadDetail();
      }
    } catch (cause) {
      if (refreshRequests.isCurrent(request)) error.value = errorMessage(cause);
    } finally {
      if (refreshRequests.isCurrent(request)) {
        loading.value = false;
        if (initialLoaded) void refreshQueue.drain();
      }
    }
  }

  async function applyChangesBatch(nextChanges: ProcessRefreshHint[]) {
    if (disposed || !nextChanges.length) return;

    const request = refreshRequests.begin();
    error.value = "";
    const selectedAtStart = selected.value;
    const selectionAtStart = selectionGeneration;

    const settled = await Promise.allSettled(
      nextChanges.map(async (change): Promise<ProcessPatch> => {
        if (change.deleted)
          return { processId: change.processId, deleted: true };

        try {
          if (change.processId === selectedAtStart && streamReady)
            return {
              processId: change.processId,
              deleted: false,
              summary: null,
              snapshot: null,
            };

          if (change.processId === selectedAtStart) {
            const snapshot = await api<ProcessSnapshot>(
              `/processes/${encodeURIComponent(change.processId)}`,
              { signal: request.signal },
            );
            return {
              processId: change.processId,
              deleted: false,
              summary: summaryOf(snapshot),
              snapshot,
            };
          }

          if (change.output && !change.summary)
            return {
              processId: change.processId,
              deleted: false,
              summary: null,
              snapshot: null,
            };

          const summary = await api<ProcessSummary>(
            `/processes/${encodeURIComponent(change.processId)}/summary`,
            { signal: request.signal },
          );
          return {
            processId: change.processId,
            deleted: false,
            summary,
            snapshot: null,
          };
        } catch (cause) {
          if (isStaleProcessError(cause))
            return { processId: change.processId, deleted: true };
          throw cause;
        }
      }),
    );

    if (disposed || !refreshRequests.isCurrent(request)) return;

    let nextItems = [...items.value];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const change = nextChanges[index]!;
      if (result.status === "rejected") {
        retryProcessChange(change, result.reason);
        continue;
      }

      retryCounts.delete(change.processId);
      const patch = result.value;
      if (patch.deleted) {
        nextItems = nextItems.filter(
          (item) => item.processId !== patch.processId,
        );
        if (selected.value === patch.processId) clearSelection();
        continue;
      }

      if (patch.summary) {
        const itemIndex = nextItems.findIndex(
          (item) => item.processId === patch.processId,
        );
        if (itemIndex >= 0) nextItems[itemIndex] = patch.summary;
        else nextItems.push(patch.summary);
      }

      if (
        patch.snapshot &&
        selected.value === patch.processId &&
        selectedAtStart === patch.processId &&
        selectionGeneration === selectionAtStart &&
        !streamReady
      ) {
        detailRequests.invalidate();
        detail.value = patch.snapshot;
      }
    }

    items.value = nextItems.sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
  }

  function retryProcessChange(change: ProcessRefreshHint, cause: unknown) {
    const attempts = (retryCounts.get(change.processId) ?? 0) + 1;
    if (attempts <= 1 && !disposed) {
      retryCounts.set(change.processId, attempts);
      refreshQueue.enqueue([change]);
      return;
    }
    retryCounts.delete(change.processId);
    error.value = errorMessage(cause);
  }

  /** The selected process receives initial state once, then raw output chunks.
   * The existing runtime events still refresh summaries of other processes.
   */
  function connectOutput(processId: string, generation: number) {
    const source = new EventSource(
      `/api/processes/${encodeURIComponent(processId)}/stream`,
    );
    outputStream = source;
    const decoder = {
      stdout: new TextDecoder(),
      stderr: new TextDecoder(),
    };
    const buffered = { stdout: "", stderr: "" };
    let outputTimer: ReturnType<typeof setTimeout> | null = null;
    const active = () =>
      !disposed &&
      outputStream === source &&
      selected.value === processId &&
      selectionGeneration === generation;
    const discardBuffer = () => {
      if (outputTimer !== null) clearTimeout(outputTimer);
      outputTimer = null;
      buffered.stdout = "";
      buffered.stderr = "";
    };
    const flushOutput = () => {
      if (!active() || !streamReady || !detail.value) {
        discardBuffer();
        return;
      }
      if (!buffered.stdout && !buffered.stderr) return;
      const next = { ...detail.value };
      for (const key of ["stdout", "stderr"] as const) {
        const delta = buffered[key];
        if (!delta) continue;
        next.outputTruncated ||=
          next[key].length + delta.length > MAX_VISIBLE_OUTPUT;
        next[key] = appendOutput(next[key], delta);
      }
      detail.value = next;
      discardBuffer();
    };
    const failStream = () => {
      discardBuffer();
      streamReady = false;
      source.close();
      outputStream = null;
      void loadDetail(generation);
    };
    source.addEventListener("snapshot", (event) => {
      if (!active()) return;
      try {
        const snapshot = JSON.parse(
          (event as MessageEvent).data,
        ) as ProcessSnapshot;
        discardBuffer();
        decoder.stdout = new TextDecoder();
        decoder.stderr = new TextDecoder();
        detailRequests.invalidate();
        detail.value = snapshot;
        streamReady = snapshot.state === "running";
        updateSummary(snapshot);
        if (!streamReady) {
          source.close();
          outputStream = null;
        }
      } catch {
        failStream();
      }
    });
    source.addEventListener("output", (event) => {
      if (!active() || !streamReady || !detail.value) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          stream: "stdout" | "stderr";
          bytes: string;
        };
        if (payload.stream !== "stdout" && payload.stream !== "stderr") return;
        const raw = atob(payload.bytes);
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        const text = decoder[payload.stream].decode(bytes, { stream: true });
        if (!text) return;
        buffered[payload.stream] += text;
        if (buffered[payload.stream].length >= 64 * 1024) flushOutput();
        else if (outputTimer === null)
          outputTimer = setTimeout(flushOutput, 50);
      } catch {
        failStream();
      }
    });
    source.addEventListener("exit", (event) => {
      if (!active()) return;
      try {
        flushOutput();
        const status = JSON.parse((event as MessageEvent).data) as Omit<
          ProcessSnapshot,
          "stdout" | "stderr"
        >;
        detailRequests.invalidate();
        if (detail.value)
          detail.value = {
            ...detail.value,
            ...status,
            outputTruncated:
              detail.value.outputTruncated || status.outputTruncated,
          };
        else void loadDetail(generation);
        const index = items.value.findIndex(
          (item) => item.processId === processId,
        );
        if (index >= 0) {
          const next = [...items.value];
          next[index] = summaryOf(status);
          items.value = next;
        }
      } catch {
        void loadDetail(generation);
      } finally {
        discardBuffer();
        streamReady = false;
        source.close();
        outputStream = null;
      }
    });
    source.onerror = () => {
      if (!active()) return;
      discardBuffer();
      streamReady = false;
      // EventSource automatically reconnects, yielding a fresh snapshot.
    };
  }

  function updateSummary(snapshot: ProcessSnapshot) {
    const index = items.value.findIndex(
      (item) => item.processId === snapshot.processId,
    );
    if (index < 0) return;
    const next = [...items.value];
    next[index] = summaryOf(snapshot);
    items.value = next;
  }

  async function loadDetail(selectionAtStart = selectionGeneration) {
    const request = detailRequests.begin();
    const processId = selected.value;
    if (!processId) {
      detail.value = null;
      return;
    }
    try {
      const next = await api<ProcessSnapshot>(
        `/processes/${encodeURIComponent(processId)}`,
        { signal: request.signal },
      );
      if (
        detailRequests.isCurrent(request) &&
        selected.value === processId &&
        selectionGeneration === selectionAtStart &&
        !streamReady
      )
        detail.value = next;
    } catch (cause) {
      if (!detailRequests.isCurrent(request)) return;
      if (isStaleProcessError(cause)) {
        clearSelection();
        void loadInitial();
        return;
      }
      error.value = errorMessage(cause);
    }
  }

  async function stop(processId: string, force: boolean) {
    if (disposed) return;
    error.value = "";
    const request = new AbortController();
    stopRequests.add(request);
    let deleted = false;
    try {
      await api(
        `/processes/${encodeURIComponent(processId)}/${force ? "kill" : "terminate"}`,
        { method: "POST", signal: request.signal },
      );
    } catch (cause) {
      if (disposed || request.signal.aborted) return;
      if (!isStaleProcessError(cause)) {
        error.value = errorMessage(cause);
        return;
      }
      deleted = cause instanceof ApiError && cause.code === "NOT_FOUND";
    } finally {
      stopRequests.delete(request);
    }
    if (disposed || request.signal.aborted) return;
    // The POST snapshot precedes process exit/output events. Reconcile through
    // the same entity queue as SSE so its delayed response cannot undo them.
    refreshQueue.enqueue([{ processId, summary: true, output: true, deleted }]);
    if (initialLoaded) await refreshQueue.drain();
  }

  function select(processId: string) {
    if (selected.value === processId) return;
    detail.value = null;
    selected.value = processId;
  }

  function clearSelection() {
    outputStream?.close();
    outputStream = null;
    streamReady = false;
    selected.value = null;
    detail.value = null;
    detailRequests.invalidate();
  }

  return {
    items,
    selected,
    detail,
    error,
    loading,
    processOutput,
    loadInitial,
    select,
    clearSelection,
    stop,
  };
}

function mergeProcessRefresh(
  previous: ProcessRefreshHint | undefined,
  next: ProcessRefreshHint,
): ProcessRefreshHint {
  return {
    processId: next.processId,
    output: Boolean(previous?.output || next.output),
    summary: Boolean(previous?.summary || next.summary),
    deleted: Boolean(previous?.deleted || next.deleted),
  };
}

type ProcessPatch =
  | { processId: string; deleted: true }
  | {
      processId: string;
      deleted: false;
      summary: ProcessSummary | null;
      snapshot: ProcessSnapshot | null;
    };

function summaryOf(snapshot: ProcessSummary): ProcessSummary {
  return {
    processId: snapshot.processId,
    command: snapshot.command,
    args: snapshot.args,
    state: snapshot.state,
    startedAt: snapshot.startedAt,
    durationMs: snapshot.durationMs,
  };
}

function isStaleProcessError(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    (cause.code === "NOT_FOUND" || cause.code === "CONFLICT")
  );
}
