import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type WatchSource,
} from "vue";
import {
  api,
  type GitBranch,
  type GitChange,
  type GitCommit,
  type GitDiff,
  type GitStatus,
} from "../api.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";

export function useWorkspaceGit(workspaceId: WatchSource<string>) {
  const status = shallowRef<GitStatus | null>(null);
  const branches = shallowRef<GitBranch[]>([]);
  const commits = shallowRef<GitCommit[]>([]);
  const selectedPath = shallowRef<string | null>(null);
  const diff = shallowRef<GitDiff | null>(null);
  const loading = shallowRef(false);
  const diffLoading = shallowRef(false);
  const busy = shallowRef<string | null>(null);
  const error = shallowRef("");
  let generation = 0;
  const loadRequests = createRequestGate();
  const diffRequests = createRequestGate();
  const mutationRequests = createRequestGate();
  let disposed = false;

  onScopeDispose(() => {
    disposed = true;
    generation += 1;
    loadRequests.invalidate();
    diffRequests.invalidate();
    mutationRequests.invalidate();
  });

  const currentRoot = () =>
    typeof workspaceId === "function"
      ? workspaceId()
      : String(workspaceId.value ?? "");
  const changes = computed(() => status.value?.changes ?? []);
  const selectedChange = computed(
    () =>
      changes.value.find((change) => change.path === selectedPath.value) ??
      null,
  );
  const stagedPaths = computed(() =>
    changes.value.filter(isStaged).map((change) => change.path),
  );
  const unstagedPaths = computed(() =>
    changes.value.filter(isUnstaged).map((change) => change.path),
  );

  watch(
    workspaceId,
    () => {
      generation += 1;
      loadRequests.invalidate();
      diffRequests.invalidate();
      mutationRequests.invalidate();
      busy.value = null;
      status.value = null;
      branches.value = [];
      commits.value = [];
      selectedPath.value = null;
      diff.value = null;
      void load();
    },
    { immediate: true },
  );
  async function load() {
    if (disposed || busy.value) return;
    const generationAtStart = ++generation;
    const request = loadRequests.begin();
    const targetRoot = currentRoot();
    loading.value = true;
    error.value = "";
    try {
      const next = await api<GitStatus | null>(
        `/git/status?workspaceId=${encodeURIComponent(targetRoot)}`,
        { signal: request.signal },
      );
      if (
        generationAtStart !== generation ||
        !loadRequests.isCurrent(request) ||
        currentRoot() !== targetRoot
      )
        return;
      status.value = next;
      if (!next) {
        branches.value = [];
        commits.value = [];
        selectedPath.value = null;
        diff.value = null;
        return;
      }
      await loadAncillary(generationAtStart, targetRoot, request.signal);
      if (
        generationAtStart !== generation ||
        !loadRequests.isCurrent(request) ||
        currentRoot() !== targetRoot
      )
        return;
      normalizeSelection();
      await loadDiff();
    } catch (cause) {
      if (
        generationAtStart === generation &&
        loadRequests.isCurrent(request) &&
        currentRoot() === targetRoot
      )
        error.value = errorMessage(cause);
    } finally {
      if (
        generationAtStart === generation &&
        loadRequests.isCurrent(request) &&
        currentRoot() === targetRoot
      )
        loading.value = false;
    }
  }

  async function loadAncillary(
    generationAtStart: number,
    targetRoot: string,
    signal?: AbortSignal,
  ) {
    const encoded = encodeURIComponent(targetRoot);
    const options = signal ? { signal } : {};
    const [nextBranches, nextCommits] = await Promise.all([
      api<GitBranch[]>(`/git/branches?workspaceId=${encoded}`, options),
      api<GitCommit[]>(`/git/log?workspaceId=${encoded}&limit=20`, options),
    ]);
    if (generationAtStart !== generation || currentRoot() !== targetRoot)
      return;
    branches.value = nextBranches;
    commits.value = nextCommits;
  }

  function selectPath(path: string | null) {
    if (selectedPath.value === path) return;
    selectedPath.value = path;
    diff.value = null;
    void loadDiff();
  }

  async function loadDiff() {
    const path = selectedPath.value;
    const targetRoot = currentRoot();
    if (!path || !status.value?.head) {
      diffRequests.invalidate();
      diffLoading.value = false;
      diff.value = null;
      return;
    }
    const request = diffRequests.begin();
    diffLoading.value = true;
    try {
      const next = await api<GitDiff>(
        `/git/diff?workspaceId=${encodeURIComponent(targetRoot)}&path=${encodeURIComponent(path)}`,
        { signal: request.signal },
      );
      if (
        diffRequests.isCurrent(request) &&
        currentRoot() === targetRoot &&
        selectedPath.value === path
      )
        diff.value = next;
    } catch (cause) {
      if (diffRequests.isCurrent(request) && currentRoot() === targetRoot) {
        diff.value = null;
        error.value = errorMessage(cause);
      }
    } finally {
      if (diffRequests.isCurrent(request) && currentRoot() === targetRoot)
        diffLoading.value = false;
    }
  }

  async function mutate(
    key: string,
    endpoint: string,
    method: "POST" | "DELETE",
    body: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<boolean> {
    if (disposed || busy.value) return false;
    const targetRoot = currentRoot();
    const generationAtStart = ++generation;
    const mutation = mutationRequests.begin();
    loadRequests.invalidate();
    diffRequests.invalidate();
    loading.value = false;
    diffLoading.value = false;
    busy.value = key;
    error.value = "";
    try {
      const next = await api<GitStatus>(endpoint, {
        method,
        body: JSON.stringify({ workspaceId: targetRoot, ...body }),
        timeoutMs,
        signal: mutation.signal,
      });
      if (
        disposed ||
        generationAtStart !== generation ||
        !mutationRequests.isCurrent(mutation) ||
        currentRoot() !== targetRoot
      )
        return false;
      status.value = next;
      normalizeSelection();
      await loadAncillary(generationAtStart, targetRoot, mutation.signal);
      if (
        disposed ||
        generationAtStart !== generation ||
        !mutationRequests.isCurrent(mutation) ||
        currentRoot() !== targetRoot
      )
        return false;
      await loadDiff();
      return true;
    } catch (cause) {
      if (
        !disposed &&
        generationAtStart === generation &&
        mutationRequests.isCurrent(mutation) &&
        currentRoot() === targetRoot
      )
        error.value = errorMessage(cause);
      return false;
    } finally {
      if (
        !disposed &&
        generationAtStart === generation &&
        mutationRequests.isCurrent(mutation) &&
        currentRoot() === targetRoot
      )
        busy.value = null;
    }
  }

  async function stage(paths: string[]) {
    return paths.length
      ? mutate("stage", "/git/stage", "POST", { paths })
      : false;
  }

  async function unstage(paths: string[]) {
    return paths.length
      ? mutate("unstage", "/git/unstage", "POST", { paths })
      : false;
  }

  function restore(path: string) {
    return mutate("restore", "/git/restore", "POST", { path });
  }

  function commit(message: string) {
    return mutate("commit", "/git/commit", "POST", { message });
  }

  function createBranch(name: string) {
    return mutate("branch", "/git/branches", "POST", { name });
  }

  function switchBranch(name: string) {
    return mutate("branch", "/git/switch", "POST", { name });
  }

  function deleteBranch(name: string) {
    return mutate("branch", "/git/branches", "DELETE", { name });
  }

  function remote(action: "fetch" | "pull" | "push") {
    return mutate(action, `/git/${action}`, "POST", {}, 5 * 60_000);
  }

  function normalizeSelection() {
    if (!changes.value.some((change) => change.path === selectedPath.value))
      selectedPath.value = changes.value[0]?.path ?? null;
  }

  return {
    status,
    branches,
    commits,
    selectedPath,
    selectPath,
    diff,
    loading,
    diffLoading,
    busy,
    error,
    changes,
    selectedChange,
    stagedPaths,
    unstagedPaths,
    load,
    stage,
    unstage,
    restore,
    commit,
    createBranch,
    switchBranch,
    deleteBranch,
    remote,
    isStaged,
    isUnstaged,
    statusCode,
  };
}

export function isStaged(change: GitChange): boolean {
  return change.indexStatus !== " " && change.indexStatus !== "?";
}

export function isUnstaged(change: GitChange): boolean {
  return (
    change.indexStatus === "?" ||
    (change.workingTreeStatus !== " " && change.workingTreeStatus !== "?")
  );
}

export function statusCode(change: GitChange): string {
  return `${change.indexStatus}${change.workingTreeStatus}`.replaceAll(
    " ",
    "·",
  );
}
