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
  type ComputerPermission,
  type ComputerPreviewView,
  type ComputerStatus,
  type Operation,
} from "../api.js";
import type { ComputerRefreshHint } from "./useRuntimeEvents.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";

type ComputerSettingKey = "enabled" | "remoteAccess";

export function useComputer(
  revision: WatchSource<number>,
  changes: () => ComputerRefreshHint | null,
) {
  const status = shallowRef<ComputerStatus | null>(null);
  const preview = shallowRef<ComputerPreviewView | null>(null);
  const operations = shallowRef<Operation[]>([]);
  const error = shallowRef("");
  const remotePreviewBlocked = shallowRef(false);
  const snapshotBusy = shallowRef(false);
  const settingsBusy = shallowRef(false);
  const operationsBusy = shallowRef(false);
  const permissionBusy = shallowRef<ComputerPermission | null>(null);

  const statusRequests = createRequestGate();
  const previewRequests = createRequestGate();
  const operationListRequests = createRequestGate();
  const operationPatchRequests = createRequestGate();

  const pendingOperationIds = new Set<string>();
  const operationRetryCounts = new Map<string, number>();
  let operationsLoaded = false;
  let operationsReloading = false;
  let operationPatchWorker: Promise<void> | null = null;
  let disposed = false;

  window.addEventListener("focus", refreshPermissionStatus);
  void load();

  onScopeDispose(() => {
    window.removeEventListener("focus", refreshPermissionStatus);
    disposed = true;
    operationsLoaded = false;
    pendingOperationIds.clear();
    operationRetryCounts.clear();
    statusRequests.invalidate();
    previewRequests.invalidate();
    operationListRequests.invalidate();
    operationPatchRequests.invalidate();
  });

  const permissionRequestsAllowed = computed(() =>
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      window.location.hostname,
    ),
  );

  watch(revision, () => void applyChanges(changes()));

  async function load(): Promise<void> {
    error.value = "";
    operationsLoaded = false;
    pendingOperationIds.clear();
    operationPatchRequests.invalidate();
    await Promise.all([loadStatus(), loadOperations(), loadPreview()]);
  }

  async function applyChanges(change: ComputerRefreshHint | null) {
    if (change === null) {
      await load();
      return;
    }

    const tasks: Promise<unknown>[] = [];
    if (change.status) tasks.push(loadStatus());
    if (
      change.preview &&
      (!change.previewSnapshotId ||
        preview.value?.snapshotId !== change.previewSnapshotId)
    ) {
      tasks.push(loadPreview());
    }

    if (change.operationsReset) {
      operationsLoaded = false;
      pendingOperationIds.clear();
      operationPatchRequests.invalidate();
      tasks.push(loadOperations());
    } else if (change.operationIds.length) {
      for (const id of change.operationIds) pendingOperationIds.add(id);
      if (operationsLoaded && !operationsReloading)
        tasks.push(drainOperationPatches());
      else if (!operationsReloading) tasks.push(loadOperations());
    }

    await Promise.all(tasks);
  }

  async function loadStatus(): Promise<void> {
    const request = statusRequests.begin();
    try {
      const next = await api<ComputerStatus>("/computer/status", {
        signal: request.signal,
      });
      if (statusRequests.isCurrent(request)) status.value = next;
    } catch (cause) {
      if (statusRequests.isCurrent(request)) captureError(cause);
    }
  }

  async function loadOperations(): Promise<void> {
    const request = operationListRequests.begin();
    operationsReloading = true;
    operationsBusy.value = true;
    try {
      const next = await api<Operation[]>(
        "/operations?pluginId=computer&limit=50",
        { signal: request.signal },
      );
      if (disposed || !operationListRequests.isCurrent(request)) return;
      operations.value = next;
      operationsLoaded = true;
    } catch (cause) {
      if (operationListRequests.isCurrent(request)) captureError(cause);
    } finally {
      if (operationListRequests.isCurrent(request)) {
        operationsReloading = false;
        operationsBusy.value = false;
      }
    }

    if (operationListRequests.isCurrent(request) && pendingOperationIds.size)
      await drainOperationPatches();
  }

  async function patchOperationsBatch(operationIds: readonly string[]) {
    if (disposed || !operationIds.length) return;
    const request = operationPatchRequests.begin();
    const settled = await Promise.allSettled(
      operationIds.map(async (operationId) => {
        try {
          return await api<Operation>(
            "/operations/" + encodeURIComponent(operationId),
            { signal: request.signal },
          );
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 404) return null;
          throw cause;
        }
      }),
    );
    if (disposed || !operationPatchRequests.isCurrent(request)) return;

    const next = [...operations.value];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const operationId = operationIds[index]!;
      if (result.status === "rejected") {
        const attempts = (operationRetryCounts.get(operationId) ?? 0) + 1;
        if (attempts <= 1) {
          operationRetryCounts.set(operationId, attempts);
          pendingOperationIds.add(operationId);
        } else {
          operationRetryCounts.delete(operationId);
          captureError(result.reason);
        }
        continue;
      }

      operationRetryCounts.delete(operationId);
      const patch = result.value;
      if (!patch || patch.pluginId !== "computer") continue;
      const eventIndex = next.findIndex(
        (item) => item.operationId === patch.operationId,
      );
      if (eventIndex >= 0) next[eventIndex] = patch;
      else next.push(patch);
    }
    next.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    operations.value = next.slice(0, 50);
  }

  function drainOperationPatches(): Promise<void> {
    if (operationPatchWorker) return operationPatchWorker;
    operationPatchWorker = Promise.resolve()
      .then(async () => {
        while (
          !disposed &&
          operationsLoaded &&
          !operationsReloading &&
          pendingOperationIds.size
        ) {
          const ids = [...pendingOperationIds];
          pendingOperationIds.clear();
          await patchOperationsBatch(ids);
        }
      })
      .finally(() => {
        operationPatchWorker = null;
        if (
          !disposed &&
          operationsLoaded &&
          !operationsReloading &&
          pendingOperationIds.size
        )
          void drainOperationPatches();
      });
    return operationPatchWorker;
  }

  async function loadPreview(): Promise<void> {
    const request = previewRequests.begin();
    remotePreviewBlocked.value = false;
    try {
      const next = await api<ComputerPreviewView | null>("/computer/preview", {
        signal: request.signal,
      });
      if (previewRequests.isCurrent(request)) preview.value = next;
    } catch (cause) {
      if (!previewRequests.isCurrent(request)) return;
      if (isRemotePreviewBlocked(cause)) {
        preview.value = null;
        remotePreviewBlocked.value = true;
        return;
      }
      captureError(cause);
    }
  }

  async function refreshPermissionStatus(): Promise<void> {
    if (status.value?.unavailableReason === "no_x11_session") {
      await loadStatus();
      return;
    }
    if (
      status.value?.platform !== "macos" ||
      (status.value.permissions.accessibility === "granted" &&
        status.value.permissions.screenRecording === "granted")
    )
      return;
    const request = statusRequests.begin();
    try {
      const next = await api<ComputerStatus>("/computer/status", {
        signal: request.signal,
      });
      if (statusRequests.isCurrent(request)) status.value = next;
    } catch {
      // Focus refresh is opportunistic; keep the last known permission state.
    }
  }

  async function updateSetting(
    key: ComputerSettingKey,
    value: boolean,
  ): Promise<void> {
    if (settingsBusy.value) return;
    settingsBusy.value = true;
    error.value = "";
    try {
      await api("/computer/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      await Promise.all([loadStatus(), loadPreview()]);
    } catch (cause) {
      captureError(cause);
    } finally {
      settingsBusy.value = false;
    }
  }

  async function requestPermission(
    permission: ComputerPermission,
  ): Promise<void> {
    if (!permissionRequestsAllowed.value || permissionBusy.value) return;
    permissionBusy.value = permission;
    error.value = "";
    const endpoint =
      permission === "accessibility"
        ? "/computer/permissions/accessibility/request"
        : "/computer/permissions/screen-recording/request";
    const request = statusRequests.begin();
    try {
      const next = await api<ComputerStatus>(endpoint, {
        method: "POST",
        signal: request.signal,
      });
      if (statusRequests.isCurrent(request)) status.value = next;
    } catch (cause) {
      if (statusRequests.isCurrent(request)) captureError(cause);
    } finally {
      permissionBusy.value = null;
    }
  }

  async function refreshSnapshot(): Promise<void> {
    if (snapshotBusy.value) return;
    const request = previewRequests.begin();
    snapshotBusy.value = true;
    error.value = "";
    try {
      const next = await api<ComputerPreviewView>("/computer/snapshot", {
        method: "POST",
        signal: request.signal,
      });
      if (!previewRequests.isCurrent(request)) return;
      preview.value = next;
      remotePreviewBlocked.value = false;
    } catch (cause) {
      if (previewRequests.isCurrent(request)) captureError(cause);
    } finally {
      snapshotBusy.value = false;
    }
  }

  async function refreshOperations(): Promise<void> {
    error.value = "";
    operationsLoaded = false;
    pendingOperationIds.clear();
    operationPatchRequests.invalidate();
    await loadOperations();
  }

  function captureError(cause: unknown): void {
    if (!error.value) error.value = errorMessage(cause);
  }

  return {
    status,
    preview,
    operations,
    error,
    remotePreviewBlocked,
    snapshotBusy,
    settingsBusy,
    operationsBusy,
    permissionBusy,
    permissionRequestsAllowed,
    load,
    updateSetting,
    requestPermission,
    refreshSnapshot,
    refreshOperations,
  };
}

function isRemotePreviewBlocked(cause: unknown): boolean {
  if (!(cause instanceof ApiError) || cause.code !== "FORBIDDEN") return false;
  if (!cause.details || typeof cause.details !== "object") return false;
  return (
    "reason" in cause.details &&
    (cause.details as { reason?: unknown }).reason ===
      "remote_computer_disabled"
  );
}
