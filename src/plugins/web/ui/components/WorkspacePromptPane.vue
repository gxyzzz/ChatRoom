<script setup lang="ts">
import { computed, watch, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { api, type WorkspaceInfo } from "../api.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";

const SUMMARY_PATH = ".chatroom/summary.md";
const PROMPT_PATH = ".chatroom/prompt.md";

const props = defineProps<{ workspaceId: string }>();
const summary = shallowRef("");
const prompt = shallowRef("");
const originalSummary = shallowRef("");
const originalPrompt = shallowRef("");
const loading = shallowRef(false);
const saving = shallowRef(false);
const saved = shallowRef(false);
const error = shallowRef("");
const loadedWorkspaceId = shallowRef<string | null>(null);
const locale = useLocale();
const loadRequests = createRequestGate();
const saveRequests = createRequestGate();

const dirty = computed(
  () =>
    loadedWorkspaceId.value === props.workspaceId &&
    (summary.value !== originalSummary.value ||
      prompt.value !== originalPrompt.value),
);

watch(
  () => props.workspaceId,
  () => {
    loadRequests.invalidate();
    saveRequests.invalidate();
    summary.value = "";
    prompt.value = "";
    originalSummary.value = "";
    originalPrompt.value = "";
    loadedWorkspaceId.value = null;
    saving.value = false;
    saved.value = false;
    error.value = "";
    void load();
  },
  { immediate: true },
);

async function load() {
  const request = loadRequests.begin();
  const workspaceId = props.workspaceId;
  loading.value = true;
  error.value = "";
  saved.value = false;
  try {
    const info = await api<WorkspaceInfo>(
      `/workspace?workspaceId=${encodeURIComponent(workspaceId)}`,
      { signal: request.signal },
    );
    if (!loadRequests.isCurrent(request) || props.workspaceId !== workspaceId)
      return;
    summary.value = info.summary ?? "";
    prompt.value = info.presetPrompt ?? "";
    originalSummary.value = summary.value;
    originalPrompt.value = prompt.value;
    loadedWorkspaceId.value = workspaceId;
  } catch (cause) {
    if (loadRequests.isCurrent(request)) error.value = errorMessage(cause);
  } finally {
    if (loadRequests.isCurrent(request)) loading.value = false;
  }
}

async function writeFile(
  workspaceId: string,
  path: string,
  content: string,
  signal: AbortSignal,
) {
  await api("/workspace/file", {
    method: "PUT",
    body: JSON.stringify({ workspaceId, path, content }),
    signal,
  });
}

async function save() {
  if (
    !dirty.value ||
    saving.value ||
    loadedWorkspaceId.value !== props.workspaceId
  )
    return;
  const request = saveRequests.begin();
  const workspaceId = props.workspaceId;
  const nextSummary = summary.value;
  const nextPrompt = prompt.value;
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    const writes: Promise<void>[] = [];
    if (nextSummary !== originalSummary.value)
      writes.push(
        writeFile(workspaceId, SUMMARY_PATH, nextSummary, request.signal),
      );
    if (nextPrompt !== originalPrompt.value)
      writes.push(
        writeFile(workspaceId, PROMPT_PATH, nextPrompt, request.signal),
      );
    await Promise.all(writes);
    if (!saveRequests.isCurrent(request) || props.workspaceId !== workspaceId)
      return;
    originalSummary.value = nextSummary;
    originalPrompt.value = nextPrompt;
    saved.value = true;
  } catch (cause) {
    if (saveRequests.isCurrent(request) && props.workspaceId === workspaceId)
      error.value = errorMessage(cause);
  } finally {
    if (saveRequests.isCurrent(request) && props.workspaceId === workspaceId)
      saving.value = false;
  }
}
</script>

<template>
  <div class="workspace-prompt-pane">
    <v-progress-linear v-if="loading" indeterminate />
    <div class="workspace-prompt-form">
      <v-textarea
        v-model="summary"
        :label="locale.t('$vuetify.chatroom.workspaces.summary')"
        rows="3"
        auto-grow
        maxlength="2048"
        counter
        :disabled="loading"
      />
      <v-textarea
        v-model="prompt"
        :label="locale.t('$vuetify.chatroom.workspaces.presetPrompt')"
        rows="10"
        auto-grow
        maxlength="16384"
        counter
        :disabled="loading"
      />
      <v-alert v-if="error" type="error" variant="tonal" density="compact">
        {{ error }}
      </v-alert>
      <v-alert
        v-else-if="saved"
        type="success"
        variant="tonal"
        density="compact"
      >
        {{ locale.t("$vuetify.chatroom.workspaces.saved") }}
      </v-alert>
      <div class="workspace-prompt-actions">
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          :disabled="loading || !dirty"
          @click="save"
        >
          {{ locale.t("$vuetify.chatroom.workspaces.save") }}
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-prompt-pane {
  min-width: 0;
}

.workspace-prompt-form {
  display: grid;
  gap: 18px;
  padding: 18px;
}

.workspace-prompt-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
