import { computed, shallowRef, watch, type WatchSource } from "vue";
import {
  api,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceFilePage,
} from "../api.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";

export type WorkspaceFilePreview =
  | {
      kind: "text";
      path: string;
      content: string;
      bytes: number;
      truncated: boolean;
    }
  | { kind: "image"; path: string; url: string }
  | { kind: "pdf" | "video" | "audio"; path: string; url: string }
  | { kind: "unsupported"; path: string };

const PAGE_SIZE = 300;

export function useWorkspaceFiles(workspaceId: WatchSource<string>) {
  const files = shallowRef<WorkspaceFile[]>([]);
  const currentPath = shallowRef(".");
  const file = shallowRef<WorkspaceFilePreview | null>(null);
  const selectedPath = shallowRef<string | null>(null);
  const previewLoading = shallowRef(false);
  const nextOffset = shallowRef<number | null>(null);
  const loading = shallowRef(false);
  const loadingMore = shallowRef(false);
  const error = shallowRef("");
  const directoryRequests = createRequestGate();
  const previewRequests = createRequestGate();

  const currentWorkspaceId = () =>
    typeof workspaceId === "function"
      ? workspaceId()
      : String(workspaceId.value ?? "");

  const entries = computed(() =>
    [...files.value].sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return nameOf(a.path).localeCompare(nameOf(b.path));
    }),
  );

  const breadcrumbs = computed(() => {
    const parts = currentPath.value === "." ? [] : currentPath.value.split("/");
    return [
      { title: "/", path: "." },
      ...parts.map((part, index) => ({
        title: part,
        path: parts.slice(0, index + 1).join("/"),
      })),
    ];
  });

  const parentPath = computed(() => {
    if (currentPath.value === ".") return null;
    const parts = currentPath.value.split("/");
    parts.pop();
    return parts.join("/") || ".";
  });

  watch(
    workspaceId,
    () => {
      directoryRequests.invalidate();
      previewRequests.invalidate();
      currentPath.value = ".";
      file.value = null;
      selectedPath.value = null;
      previewLoading.value = false;
      files.value = [];
      nextOffset.value = null;
      void loadDirectory();
    },
    { immediate: true },
  );

  async function loadDirectory(append = false) {
    if (
      append &&
      (loading.value || loadingMore.value || nextOffset.value === null)
    )
      return;

    const request = directoryRequests.begin();
    const targetWorkspaceId = currentWorkspaceId();
    const path = currentPath.value;
    const offset = append ? (nextOffset.value ?? 0) : 0;
    if (append) loadingMore.value = true;
    else loading.value = true;
    error.value = "";

    try {
      const page = await api<WorkspaceFilePage>(
        "/workspace/files?workspaceId=" +
          encodeURIComponent(targetWorkspaceId) +
          "&path=" +
          encodeURIComponent(path) +
          "&limit=" +
          PAGE_SIZE +
          "&offset=" +
          offset,
        { signal: request.signal },
      );
      if (
        !directoryRequests.isCurrent(request) ||
        currentWorkspaceId() !== targetWorkspaceId ||
        currentPath.value !== path
      )
        return;

      if (append) {
        const known = new Set(files.value.map((entry) => entry.path));
        files.value = [
          ...files.value,
          ...page.items.filter((entry) => !known.has(entry.path)),
        ];
      } else {
        files.value = page.items;
      }
      nextOffset.value = page.nextOffset;
      if (!append && file.value?.kind === "image") {
        const refreshed = page.items.find(
          (entry) => entry.path === file.value?.path && entry.type === "file",
        );
        if (refreshed) {
          file.value = {
            kind: "image",
            path: refreshed.path,
            url: imageUrl(targetWorkspaceId, refreshed),
          };
        } else {
          file.value = null;
        }
      }
    } catch (cause) {
      if (directoryRequests.isCurrent(request))
        error.value = errorMessage(cause);
    } finally {
      if (directoryRequests.isCurrent(request)) {
        loading.value = false;
        loadingMore.value = false;
      }
    }
  }

  async function navigate(path: string) {
    directoryRequests.invalidate();
    previewRequests.invalidate();
    currentPath.value = path || ".";
    file.value = null;
    selectedPath.value = null;
    previewLoading.value = false;
    files.value = [];
    nextOffset.value = null;
    await loadDirectory();
  }

  async function openEntry(entry: WorkspaceFile) {
    const targetWorkspaceId = currentWorkspaceId();
    if (entry.type === "directory") {
      await navigate(entry.path);
      return;
    }
    previewRequests.invalidate();
    selectedPath.value = entry.path;
    previewLoading.value = false;
    file.value = null;
    error.value = "";
    if (entry.type !== "file") {
      file.value = { kind: "unsupported", path: entry.path };
      return;
    }
    const kind = filePreviewKind(entry.path);
    if (kind === "image") {
      file.value = {
        kind,
        path: entry.path,
        url: imageUrl(targetWorkspaceId, entry),
      };
      return;
    }
    if (kind === "pdf" || kind === "video" || kind === "audio") {
      file.value = {
        kind,
        path: entry.path,
        url: previewUrl(targetWorkspaceId, entry),
      };
      return;
    }
    if (kind === "unsupported") {
      file.value = { kind, path: entry.path };
      return;
    }

    const request = previewRequests.begin();
    previewLoading.value = true;
    error.value = "";
    try {
      const result = await api<WorkspaceFileContent>(
        "/workspace/file?workspaceId=" +
          encodeURIComponent(targetWorkspaceId) +
          "&path=" +
          encodeURIComponent(entry.path),
        { signal: request.signal },
      );
      if (
        !previewRequests.isCurrent(request) ||
        currentWorkspaceId() !== targetWorkspaceId ||
        currentPath.value !== parentDirectory(entry.path)
      )
        return;
      file.value = {
        kind: "text",
        path: entry.path,
        content: result.content,
        bytes: result.bytes,
        truncated: result.truncated,
      };
    } catch (cause) {
      if (previewRequests.isCurrent(request)) error.value = errorMessage(cause);
    } finally {
      if (previewRequests.isCurrent(request)) previewLoading.value = false;
    }
  }

  return {
    files,
    entries,
    currentPath,
    file,
    selectedPath,
    previewLoading,
    breadcrumbs,
    parentPath,
    nextOffset,
    loading,
    loadingMore,
    error,
    loadDirectory,
    loadMore: () => loadDirectory(true),
    navigate,
    openEntry,
  };
}

export function nameOf(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

export function isMarkdownFile(filePath: string): boolean {
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  return base === "readme" || /\.(md|markdown)$/i.test(base);
}

function parentDirectory(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

function imageUrl(workspaceId: string, entry: WorkspaceFile): string {
  const base =
    "/api/workspace/file/image?workspaceId=" +
    encodeURIComponent(workspaceId) +
    "&path=" +
    encodeURIComponent(entry.path);
  return entry.modifiedAt
    ? base + "&v=" + encodeURIComponent(entry.modifiedAt)
    : base;
}

export function filePreviewKind(
  filePath: string,
): WorkspaceFilePreview["kind"] {
  if (isImageFile(filePath)) return "image";
  return mediaKind(filePath) ?? (isTextFile(filePath) ? "text" : "unsupported");
}

function isImageFile(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(filePath);
}

function isTextFile(filePath: string): boolean {
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (
    [
      "dockerfile",
      "makefile",
      "license",
      "readme",
      ".gitignore",
      ".gitattributes",
      ".editorconfig",
      ".env",
    ].includes(base)
  )
    return true;
  return /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|conf|config|xml|html?|css|scss|less|vue|[cm]?[jt]sx?|py|rs|go|java|kt|kts|c|cc|cpp|cxx|h|hpp|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|diff|patch|csv|tsv|log)$/i.test(
    filePath,
  );
}

function mediaKind(path: string): "pdf" | "video" | "audio" | null {
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.(mp4|m4v|webm|ogv|mov)$/i.test(path)) return "video";
  if (/\.(mp3|m4a|aac|wav|flac|oga|opus|ogg)$/i.test(path)) return "audio";
  return null;
}

function previewUrl(workspaceId: string, entry: WorkspaceFile): string {
  const base =
    "/api/workspace/file/preview?workspaceId=" +
    encodeURIComponent(workspaceId) +
    "&path=" +
    encodeURIComponent(entry.path);
  return entry.modifiedAt
    ? base + "&v=" + encodeURIComponent(entry.modifiedAt)
    : base;
}
