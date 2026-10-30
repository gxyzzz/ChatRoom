<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { useLocale } from "vuetify";
import {
  api,
  type AgentAttachment,
  type AgentModel,
  type AgentSession,
  type WorkspaceProjectFiles,
} from "../api.js";
import { createRequestGate } from "../utils/requests.js";
import AgentProjectFilePicker from "./AgentProjectFilePicker.vue";
import { errorMessage } from "../utils/errors.js";
import { agentFileName } from "../utils/agent-display.js";
import {
  buildProjectTree,
  extractMentionedPaths,
  filterProjectFiles,
  imageMimeType,
  indexProjectFiles,
  type IndexedProjectFile,
  type ProjectTreeRow,
} from "../utils/agent-files.js";

const props = defineProps<{
  session: AgentSession;
  model: AgentModel | null;
  steeringSupported: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  error: [message: string];
  busy: [value: boolean];
}>();

const locale = useLocale();
const message = shallowRef("");
const attachmentPaths = ref<string[]>([]);
const localAttachmentNames = ref<Record<string, string>>({});
const localAttachmentMimes = ref<Record<string, string | null>>({});
const projectFilePaths = shallowRef<string[]>([]);
const projectFilesTruncated = shallowRef(false);
const indexedProjectFiles = shallowRef<IndexedProjectFile[]>([]);
const projectTreeIndex = shallowRef<ProjectTreeRow[]>([]);
const expandedDirectories = shallowRef<ReadonlySet<string>>(new Set());
const workspaceMenu = shallowRef(false);
const workspaceSearch = shallowRef("");
const debouncedWorkspaceSearch = shallowRef("");
const mentionOpen = shallowRef(false);
const mentionQuery = shallowRef("");
const debouncedMentionQuery = shallowRef("");
const mentionStart = shallowRef(0);
const mentionEnd = shallowRef(0);
const composerInputHost = useTemplateRef<HTMLElement>("composerInputHost");
const localFileInput = useTemplateRef<HTMLInputElement>("localFileInput");
const sending = shallowRef(false);
const uploadingAttachments = shallowRef(false);

const projectFilesRequests = createRequestGate();
const sendRequests = createRequestGate();
const uploadRequests = createRequestGate();
let workspaceSearchTimer: ReturnType<typeof setTimeout> | null = null;
let mentionSearchTimer: ReturnType<typeof setTimeout> | null = null;

watch(workspaceSearch, (value, _previous, onCleanup) => {
  if (workspaceSearchTimer) clearTimeout(workspaceSearchTimer);
  workspaceSearchTimer = setTimeout(() => {
    debouncedWorkspaceSearch.value = value;
    workspaceSearchTimer = null;
  }, 120);
  onCleanup(() => {
    if (workspaceSearchTimer) clearTimeout(workspaceSearchTimer);
    workspaceSearchTimer = null;
  });
});

watch(mentionQuery, (value, _previous, onCleanup) => {
  if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
  mentionSearchTimer = setTimeout(() => {
    debouncedMentionQuery.value = value;
    mentionSearchTimer = null;
  }, 100);
  onCleanup(() => {
    if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
    mentionSearchTimer = null;
  });
});

const projectFileSet = computed(() => new Set(projectFilePaths.value));
const mentionedPaths = computed(() =>
  extractMentionedPaths(message.value, projectFileSet.value),
);
const effectiveAttachmentPaths = computed(() => [
  ...new Set([...attachmentPaths.value, ...mentionedPaths.value]),
]);
const isSteering = computed(
  () => props.session.status === "running" && props.steeringSupported,
);
const composerAvailable = computed(
  () => props.session.status === "idle" || isSteering.value,
);
const localUploadAccept = computed(() =>
  [
    ".txt",
    ".md",
    ".json",
    ".csv",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".zip",
    ".yaml",
    ".yml",
    ".xml",
    ".html",
    ".css",
    ".js",
    ".ts",
    ".py",
    ".rs",
    ".go",
    ".java",
    ".c",
    ".cpp",
    ".sh",
    ".log",
    ".toml",
    ".sql",
    ...(supportsAttachment("image") ? ["image/*"] : []),
    ...(supportsAttachment("audio") ? ["audio/*"] : []),
  ].join(","),
);
const unsupportedAttachments = computed(() =>
  effectiveAttachmentPaths.value.filter(
    (path) => !supportsAttachment(attachmentKind(path)),
  ),
);
const attachmentError = computed(() =>
  unsupportedAttachments.value.length
    ? locale.t(
        "$vuetify.chatroom.agents.unsupportedAttachment",
        unsupportedAttachments.value.map(attachmentDisplayName).join(", "),
      )
    : "",
);
const mentionSuggestions = computed(() =>
  filterProjectFiles(
    projectFilePaths.value,
    indexedProjectFiles.value,
    debouncedMentionQuery.value,
  ).slice(0, 12),
);
const projectTreeRows = computed<ProjectTreeRow[]>(() => {
  if (debouncedWorkspaceSearch.value.trim())
    return filterProjectFiles(
      projectFilePaths.value,
      indexedProjectFiles.value,
      debouncedWorkspaceSearch.value,
    )
      .slice(0, 80)
      .map((filePath) => ({
        path: filePath,
        name: agentFileName(filePath),
        type: "file",
        depth: 0,
        ancestors: [],
      }));

  return projectTreeIndex.value.filter((row) =>
    row.ancestors.every((parent) => expandedDirectories.value.has(parent)),
  );
});
const canSend = computed(
  () =>
    composerAvailable.value &&
    !props.disabled &&
    !sending.value &&
    !uploadingAttachments.value &&
    !unsupportedAttachments.value.length &&
    Boolean(message.value.trim() || effectiveAttachmentPaths.value.length),
);

watch(
  () => [props.session.id, props.session.workspaceId] as const,
  () => {
    resetSessionState();
    void loadProjectFiles();
  },
  { immediate: true },
);

watch(
  () => sending.value || uploadingAttachments.value,
  (value) => emit("busy", value),
  { immediate: true },
);

onBeforeUnmount(() => {
  if (workspaceSearchTimer) clearTimeout(workspaceSearchTimer);
  if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
  emit("busy", false);
});

async function loadProjectFiles() {
  const request = projectFilesRequests.begin();
  const sessionId = props.session.id;
  const workspaceId = props.session.workspaceId;
  try {
    const next = await api<WorkspaceProjectFiles>(
      "/workspace/project-files?workspaceId=" + encodeURIComponent(workspaceId),
      { timeoutMs: 20_000, signal: request.signal },
    );
    if (
      !projectFilesRequests.isCurrent(request) ||
      props.session.id !== sessionId ||
      props.session.workspaceId !== workspaceId
    )
      return;
    projectFilePaths.value = next.paths;
    projectFilesTruncated.value = next.truncated;
    indexedProjectFiles.value = indexProjectFiles(next.paths);
    projectTreeIndex.value = buildProjectTree(next.paths);
  } catch (cause) {
    if (!projectFilesRequests.isCurrent(request)) return;
    projectFilePaths.value = [];
    projectFilesTruncated.value = false;
    indexedProjectFiles.value = [];
    projectTreeIndex.value = [];
    emit("error", errorMessage(cause));
  }
}

async function sendMessage() {
  if (!canSend.value) return;
  if (unsupportedAttachments.value.length) {
    emit("error", attachmentError.value);
    return;
  }

  const sessionId = props.session.id;
  const steering = isSteering.value;
  const text = message.value;
  const attachments: AgentAttachment[] = effectiveAttachmentPaths.value.map(
    (filePath) => ({
      kind: attachmentKind(filePath),
      name: attachmentDisplayName(filePath),
      path: filePath,
      mimeType: localAttachmentMimes.value[filePath] ?? imageMimeType(filePath),
    }),
  );
  const request = sendRequests.begin();
  sending.value = true;

  try {
    await api(
      "/agents/sessions/" +
        encodeURIComponent(sessionId) +
        "/" +
        (steering ? "steer" : "turns"),
      {
        method: "POST",
        body: JSON.stringify({ text, attachments }),
        timeoutMs: 30_000,
        signal: request.signal,
      },
    );
    if (!sendRequests.isCurrent(request) || props.session.id !== sessionId)
      return;
    message.value = "";
    attachmentPaths.value = [];
    localAttachmentNames.value = {};
    localAttachmentMimes.value = {};
    mentionOpen.value = false;
  } catch (cause) {
    if (sendRequests.isCurrent(request)) emit("error", errorMessage(cause));
  } finally {
    if (sendRequests.isCurrent(request)) sending.value = false;
  }
}

function chooseLocalFiles() {
  localFileInput.value?.click();
}

async function uploadLocalFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;

  const sessionId = props.session.id;
  const workspaceId = props.session.workspaceId;
  const request = uploadRequests.begin();
  uploadingAttachments.value = true;

  try {
    for (const file of files) {
      if (!uploadRequests.isCurrent(request) || props.session.id !== sessionId)
        return;
      if (file.size === 0) {
        emit(
          "error",
          locale.t("$vuetify.chatroom.agents.emptyAttachment", file.name),
        );
        continue;
      }

      const kind = file.type.startsWith("audio/")
        ? "audio"
        : file.type.startsWith("image/") || isImage(file.name)
          ? "image"
          : "file";
      if (!supportsAttachment(kind)) {
        emit(
          "error",
          locale.t("$vuetify.chatroom.agents.unsupportedAttachment", file.name),
        );
        continue;
      }

      // A File-backed FetchEvent can expose an empty request body in Safari.
      // Materialize bytes before fetch so the P2P service worker sees a plain
      // binary request, not a browser-dependent File stream.
      const payload = await file.arrayBuffer();
      if (payload.byteLength !== file.size)
        throw new Error(
          locale.t("$vuetify.chatroom.agents.incompleteAttachment", file.name),
        );
      const uploaded = await api<{
        path: string;
        name: string;
        size: number;
        mimeType: string | null;
      }>(
        "/workspace/attachment?workspaceId=" +
          encodeURIComponent(workspaceId) +
          "&sessionId=" +
          encodeURIComponent(sessionId) +
          "&name=" +
          encodeURIComponent(file.name),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-ChatRoom-Mime-Type": file.type || "application/octet-stream",
            "X-ChatRoom-Upload-Size": String(file.size),
          },
          body: payload,
          timeoutMs: 60_000,
          signal: request.signal,
        },
      );

      if (!uploadRequests.isCurrent(request) || props.session.id !== sessionId)
        return;
      if (uploaded.size !== file.size) {
        emit(
          "error",
          locale.t("$vuetify.chatroom.agents.incompleteAttachment", file.name),
        );
        continue;
      }
      if (!attachmentPaths.value.includes(uploaded.path))
        attachmentPaths.value.push(uploaded.path);
      localAttachmentNames.value[uploaded.path] = uploaded.name;
      localAttachmentMimes.value[uploaded.path] =
        uploaded.mimeType && uploaded.mimeType !== "application/octet-stream"
          ? uploaded.mimeType
          : file.type || imageMimeType(file.name);
    }
  } catch (cause) {
    if (uploadRequests.isCurrent(request)) emit("error", errorMessage(cause));
  } finally {
    if (uploadRequests.isCurrent(request)) uploadingAttachments.value = false;
  }
}

function toggleDirectory(directoryPath: string) {
  const next = new Set(expandedDirectories.value);
  if (next.has(directoryPath)) next.delete(directoryPath);
  else next.add(directoryPath);
  expandedDirectories.value = next;
}

function toggleAttachment(filePath: string) {
  const index = attachmentPaths.value.indexOf(filePath);
  if (index >= 0) attachmentPaths.value.splice(index, 1);
  else attachmentPaths.value.push(filePath);
}

function removeAttachment(filePath: string) {
  attachmentPaths.value = attachmentPaths.value.filter(
    (candidate) => candidate !== filePath,
  );
  delete localAttachmentNames.value[filePath];
  delete localAttachmentMimes.value[filePath];
}

function attachmentDisplayName(filePath: string): string {
  return localAttachmentNames.value[filePath] ?? agentFileName(filePath);
}

function updateMention() {
  nextTick(() => {
    const textarea = composerTextarea();
    if (!textarea) {
      mentionOpen.value = false;
      return;
    }
    const cursor = textarea.selectionStart ?? message.value.length;
    const prefix = message.value.slice(0, cursor);
    const match = prefix.match(/(?:^|\s)@([^\s"@]*)$/);
    if (!match) {
      mentionOpen.value = false;
      return;
    }
    const query = match[1] ?? "";
    mentionQuery.value = query;
    mentionStart.value = cursor - query.length - 1;
    mentionEnd.value = cursor;
    mentionOpen.value = true;
  });
}

function selectMention(filePath: string) {
  const token = /\s/.test(filePath) ? '@"' + filePath + '"' : "@" + filePath;
  const before = message.value.slice(0, mentionStart.value);
  const after = message.value.slice(mentionEnd.value);
  message.value = before + token + " " + after;
  if (!attachmentPaths.value.includes(filePath))
    attachmentPaths.value.push(filePath);
  mentionOpen.value = false;
  nextTick(() => {
    const textarea = composerTextarea();
    if (!textarea) return;
    const cursor = before.length + token.length + 1;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
  });
}

function composerTextarea(): HTMLTextAreaElement | null {
  return composerInputHost.value?.querySelector("textarea") ?? null;
}

function resetSessionState() {
  projectFilesRequests.invalidate();
  sendRequests.invalidate();
  uploadRequests.invalidate();
  sending.value = false;
  uploadingAttachments.value = false;
  message.value = "";
  attachmentPaths.value = [];
  localAttachmentNames.value = {};
  localAttachmentMimes.value = {};
  projectFilePaths.value = [];
  projectFilesTruncated.value = false;
  indexedProjectFiles.value = [];
  projectTreeIndex.value = [];
  expandedDirectories.value = new Set();
  workspaceMenu.value = false;
  workspaceSearch.value = "";
  debouncedWorkspaceSearch.value = "";
  mentionQuery.value = "";
  debouncedMentionQuery.value = "";
  mentionOpen.value = false;
}

function attachmentKind(path: string): AgentAttachment["kind"] {
  if (
    /(?:^|\/)(?:\.agents|\.claude|\.chatroom)\/skills\/(?:.*\/)?SKILL\.md$/.test(
      path.replaceAll("\\", "/"),
    )
  )
    return "skill";
  if (!(path in localAttachmentNames.value)) return "file";
  const mime = localAttachmentMimes.value[path];
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.startsWith("image/") || isImage(attachmentDisplayName(path)))
    return "image";
  return "file";
}

function supportsAttachment(kind: AgentAttachment["kind"]): boolean {
  return (
    (kind !== "image" && kind !== "audio") ||
    Boolean(props.model?.inputModalities?.includes(kind))
  );
}

function isImage(filePath: string): boolean {
  return imageMimeType(filePath) !== null;
}
</script>

<template>
  <div
    class="agent-composer"
    :class="{ 'agent-composer--waiting': session.status === 'waiting_input' }"
  >
    <div v-if="isSteering" class="agent-composer-caption">
      {{ locale.t("$vuetify.chatroom.agents.steerHint") }}
    </div>

    <div
      v-if="attachmentError"
      class="agent-inline-error agent-attachment-error"
      role="alert"
    >
      {{ attachmentError }}
    </div>

    <input
      ref="localFileInput"
      class="agent-hidden-file-input"
      type="file"
      multiple
      :accept="localUploadAccept"
      @change="uploadLocalFiles"
    />

    <div v-if="attachmentPaths.length" class="agent-selected-attachments">
      <v-chip
        v-for="filePath in attachmentPaths"
        :key="filePath"
        size="small"
        closable
        variant="tonal"
        :title="filePath"
        @click:close="removeAttachment(filePath)"
      >
        {{ attachmentDisplayName(filePath) }}
      </v-chip>
    </div>

    <div class="agent-compose-row">
      <div
        v-if="session.status !== 'waiting_input'"
        class="agent-compose-tools"
      >
        <v-btn
          icon="$mdiPaperclip"
          size="x-small"
          density="comfortable"
          variant="text"
          class="agent-compose-tool-button agent-attachment-button"
          :loading="uploadingAttachments"
          :disabled="!composerAvailable || disabled || sending"
          :aria-label="locale.t('$vuetify.chatroom.agents.attachFile')"
          @click="chooseLocalFiles"
        />

        <AgentProjectFilePicker
          v-model:open="workspaceMenu"
          v-model:search="workspaceSearch"
          :rows="projectTreeRows"
          :truncated="projectFilesTruncated"
          :selected-paths="attachmentPaths"
          :expanded-directories="expandedDirectories"
          :disabled="!composerAvailable || disabled || sending"
          @toggle-directory="toggleDirectory"
          @toggle-file="toggleAttachment"
        />
      </div>

      <div
        v-if="session.status !== 'waiting_input'"
        ref="composerInputHost"
        class="agent-compose-input-wrap"
      >
        <div
          v-if="mentionOpen && mentionSuggestions.length"
          class="agent-mention-popup"
        >
          <button
            v-for="filePath in mentionSuggestions"
            :key="filePath"
            type="button"
            class="agent-file-suggestion"
            @mousedown.prevent="selectMention(filePath)"
            @click="selectMention(filePath)"
          >
            <span class="agent-file-suggestion-name">
              {{ agentFileName(filePath) }}
            </span>
            <span class="agent-file-suggestion-path">
              {{ filePath }}
            </span>
          </button>
        </div>

        <v-textarea
          v-model="message"
          :placeholder="
            locale.t(
              isSteering
                ? '$vuetify.chatroom.agents.steerPlaceholder'
                : '$vuetify.chatroom.agents.messagePlaceholder',
            )
          "
          :aria-label="
            locale.t(
              isSteering
                ? '$vuetify.chatroom.agents.steerPlaceholder'
                : '$vuetify.chatroom.agents.messagePlaceholder',
            )
          "
          auto-grow
          rows="2"
          max-rows="8"
          hide-details
          :disabled="!composerAvailable || disabled || sending"
          @input="updateMention"
          @keyup="updateMention"
          @click="updateMention"
          @keydown.escape="mentionOpen = false"
          @keydown.ctrl.enter.prevent="sendMessage"
          @keydown.meta.enter.prevent="sendMessage"
        />
      </div>

      <div class="agent-compose-actions">
        <slot name="controls" :busy="sending || uploadingAttachments" />

        <v-btn
          v-if="session.status !== 'waiting_input'"
          icon="$mdiArrowUp"
          color="primary"
          size="small"
          variant="tonal"
          :loading="sending"
          :disabled="!canSend"
          :aria-label="
            locale.t(
              isSteering
                ? '$vuetify.chatroom.agents.steer'
                : '$vuetify.chatroom.agents.send',
            )
          "
          @click="sendMessage"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-composer {
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 8px;
  padding: 12px;
}

.agent-composer-caption,
.agent-file-suggestion-path {
  color: rgba(var(--v-theme-on-surface), 0.62);
}

.agent-composer-caption {
  font-size: 0.75rem;
}

.agent-inline-error {
  color: rgb(var(--v-theme-error));
}

.agent-attachment-error {
  padding: 0;
  font-size: 0.8rem;
}

.agent-selected-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  overflow: auto;
}

.agent-compose-row {
  justify-content: flex-end;
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.agent-compose-tools {
  flex: 0 0 auto;
  align-self: flex-end;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 2px;
}
.agent-compose-tool-button {
  padding: 0;
  color: rgba(var(--v-theme-on-surface), 0.72);
}
.agent-attachment-button :deep(.v-icon) {
  font-size: 18px;
}

.agent-compose-input-wrap {
  position: relative;
  min-width: 0;
  flex: 1 1 auto;
}

.agent-compose-input-wrap :deep(.v-textarea) {
  min-width: 0;
}

.agent-compose-actions {
  flex: 0 0 auto;
  align-self: flex-end;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-bottom: 1px;
}

.agent-compose-actions > :deep(.v-btn) {
  flex: 0 0 auto;
}

.agent-hidden-file-input {
  display: none;
}

.agent-mention-popup {
  position: absolute;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 20;
  max-height: 40dvh;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.agent-file-suggestion {
  width: 100%;
  display: grid;
  gap: 1px;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  text-align: left;
  cursor: pointer;
}

.agent-file-suggestion:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

.agent-file-suggestion-name {
  overflow: hidden;
  font-size: 0.82rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-file-suggestion-path {
  overflow: hidden;
  font-family: var(--font-mono, monospace);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-composer > * {
  flex-shrink: 0;
}

.agent-composer--waiting .agent-compose-actions {
  flex-direction: row;
}
</style>
