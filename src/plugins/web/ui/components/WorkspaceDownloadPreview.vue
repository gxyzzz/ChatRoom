<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { api, type WorkspaceFileContent } from "../api.js";
import { errorMessage } from "../utils/errors.js";
import {
  filePreviewKind,
  isMarkdownFile,
  nameOf,
} from "../composables/useWorkspaceFiles.js";
import { workspaceDownloadUrl } from "../utils/workspace-download.js";
import { downloadFile } from "../utils/download.js";
import CodeViewer from "./CodeViewer.vue";
import MarkdownContent from "./MarkdownContent.vue";
import WorkspaceCsvPreview from "./WorkspaceCsvPreview.vue";
import WorkspaceMediaPreview from "./WorkspaceMediaPreview.vue";

const props = defineProps<{ workspaceId: string; path: string }>();
const open = defineModel<boolean>({ required: true });
const locale = useLocale();
const kind = computed(() => filePreviewKind(props.path));
const fileName = computed(() => nameOf(props.path));
const fileUrl = computed(() => {
  const endpoint = kind.value === "image" ? "image" : "preview";
  return `/api/workspace/file/${endpoint}?${new URLSearchParams({
    workspaceId: props.workspaceId,
    path: props.path,
  })}`;
});
function download(): void {
  void downloadFile(
    workspaceDownloadUrl(props.workspaceId, props.path),
    fileName.value,
  ).catch(() => {});
}

const content = shallowRef<WorkspaceFileContent | null>(null);
const loading = shallowRef(false);
const error = shallowRef("");

watch(
  [open, () => props.workspaceId, () => props.path],
  ([visible], _previous, onCleanup) => {
    content.value = null;
    error.value = "";
    loading.value = false;
    if (!visible || kind.value !== "text") return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    loading.value = true;
    void api<WorkspaceFileContent>(
      `/workspace/file?${new URLSearchParams({ workspaceId: props.workspaceId, path: props.path })}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) content.value = result;
      })
      .catch((cause) => {
        if (!controller.signal.aborted) error.value = errorMessage(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) loading.value = false;
      });
  },
  { immediate: true },
);
</script>

<template>
  <v-dialog v-model="open" fullscreen>
    <v-card class="workspace-download-preview">
      <v-toolbar density="comfortable" color="surface">
        <v-toolbar-title class="text-body-1 text-truncate" :title="path">
          {{ fileName }}
        </v-toolbar-title>
        <v-btn
          variant="text"
          prepend-icon="$mdiDownloadOutline"
          @click="download"
        >
          {{ locale.t("$vuetify.chatroom.files.download") }}
        </v-btn>
        <v-btn
          icon="$mdiClose"
          variant="text"
          :aria-label="locale.t('$vuetify.chatroom.common.close')"
          @click="open = false"
        />
      </v-toolbar>
      <v-divider />
      <div class="workspace-download-preview-body">
        <v-progress-linear v-if="loading" indeterminate />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">
          {{ error }}
        </v-alert>
        <WorkspaceMediaPreview
          v-else-if="kind === 'pdf' || kind === 'video' || kind === 'audio'"
          :kind="kind"
          :path="path"
          :url="fileUrl"
        />
        <img
          v-else-if="kind === 'image'"
          class="workspace-download-preview-image"
          :src="fileUrl"
          :alt="fileName"
        />
        <template v-else-if="kind === 'text' && content">
          <v-alert
            v-if="content.truncated"
            type="warning"
            variant="tonal"
            density="compact"
          >
            {{ locale.t("$vuetify.chatroom.files.previewTruncated") }}
          </v-alert>
          <WorkspaceCsvPreview
            v-if="/\.(csv|tsv)$/i.test(path)"
            :content="content.content"
            :path="path"
            :truncated="content.truncated"
          />
          <MarkdownContent
            v-else-if="isMarkdownFile(path)"
            :text="content.content"
          />
          <CodeViewer
            v-else
            :text="content.content"
            :filename="path"
            :show-download="false"
          />
        </template>
        <v-empty-state
          v-else-if="kind === 'unsupported'"
          icon="$mdiFileQuestionOutline"
          :title="locale.t('$vuetify.chatroom.files.previewUnavailable')"
        />
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.workspace-download-preview {
  display: flex;
  flex-direction: column;
}
.workspace-download-preview-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: 12px;
}
.workspace-download-preview-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  margin: auto;
  object-fit: contain;
}
</style>
