<script setup lang="ts">
import { computed, defineAsyncComponent, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { workspaceDownloadUrl } from "../utils/workspace-download.js";
import { filePreviewKind } from "../composables/useWorkspaceFiles.js";
import { downloadFile, DownloadHttpError } from "../utils/download.js";

const WorkspaceDownloadPreview = defineAsyncComponent(
  () => import("./WorkspaceDownloadPreview.vue"),
);

const locale = useLocale();
const params = new URLSearchParams(window.location.search);
const workspace = params.get("workspace");
const path = params.get("path");
const url = workspace && path ? workspaceDownloadUrl(workspace, path) : null;
const fileName = path?.split(/[\\/]/).pop() || "";
const busy = shallowRef(false);
const previewOpen = shallowRef(false);
const canPreview = Boolean(path && filePreviewKind(path) !== "unsupported");
const started = shallowRef(false);
const error = shallowRef("");
const pageTitle = computed(() => {
  const key = !url
    ? "invalidDownload"
    : error.value
      ? "downloadFailed"
      : started.value
        ? "downloadRequested"
        : "download";
  return locale.t(`$vuetify.chatroom.files.${key}`);
});
const pageMessage = computed(() =>
  !url
    ? ""
    : error.value ||
      (started.value
        ? locale.t("$vuetify.chatroom.files.downloadStarted")
        : busy.value
          ? locale.t("$vuetify.chatroom.files.preparingDownload")
          : ""),
);
const pageIcon = computed(() =>
  !url || error.value
    ? "$mdiAlertCircleOutline"
    : started.value
      ? "$mdiCheckCircleOutline"
      : "$mdiDownloadOutline",
);

async function download() {
  if (!url || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await downloadFile(url, fileName || "download");
    started.value = true;
  } catch (cause) {
    if (cause instanceof DownloadHttpError && cause.status === 401) {
      window.location.reload();
      return;
    }
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-main class="login-page">
    <v-empty-state
      :icon="pageIcon"
      :color="!url || error ? 'error' : started ? 'success' : 'primary'"
      :title="pageTitle"
      :text="pageMessage"
      size="64"
    >
      <div v-if="url" class="text-body-2 text-medium-emphasis text-break">
        {{ fileName }}
      </div>
      <template #actions>
        <v-btn href="/" color="secondary" variant="text">
          {{ locale.t("$vuetify.chatroom.files.backToWorkspace") }}
        </v-btn>
        <v-btn
          v-if="url && canPreview"
          variant="tonal"
          prepend-icon="$mdiFileEyeOutline"
          @click="previewOpen = true"
        >
          {{ locale.t("$vuetify.chatroom.files.preview") }}
        </v-btn>
        <v-btn
          v-if="url"
          color="primary"
          variant="flat"
          :loading="busy"
          @click="download"
        >
          {{ locale.t("$vuetify.chatroom.files.download") }}
        </v-btn>
      </template>
    </v-empty-state>
    <WorkspaceDownloadPreview
      v-if="previewOpen && workspace && path"
      v-model="previewOpen"
      :workspace="workspace"
      :path="path"
    />
  </v-main>
</template>
