<script setup lang="ts">
import { computed, defineAsyncComponent, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { workspaceDownloadUrl } from "../utils/workspace-download.js";
import { filePreviewKind } from "../composables/useWorkspaceFiles.js";
import {
  downloadFile,
  downloadProgress,
  DownloadHttpError,
} from "../utils/download.js";
import { rtcIceRoute, rtcStatus } from "../transport/rtc.js";

const WorkspaceDownloadPreview = defineAsyncComponent(
  () => import("./WorkspaceDownloadPreview.vue"),
);

const locale = useLocale();
const params = new URLSearchParams(window.location.search);
const workspaceId = params.get("workspaceId");
const path = params.get("path");
const url =
  workspaceId && path ? workspaceDownloadUrl(workspaceId, path) : null;
const fileName = path?.split(/[\\/]/).pop() || "";
const busy = shallowRef(false);
const previewOpen = shallowRef(false);
const canPreview = Boolean(path && filePreviewKind(path) !== "unsupported");
const started = shallowRef(false);
const error = shallowRef("");
const transferMode = computed(() => {
  const progress = downloadProgress.value;
  if (!progress || progress.name !== (fileName || "download")) return null;
  if (progress.phase === "transferring" && progress.received === 0) return null;
  return progress.mode;
});
const connectionState = computed(() =>
  transferMode.value === "p2p"
    ? "transferP2p"
    : transferMode.value === "http"
      ? "transferHttp"
      : rtcStatus.value === "connected"
        ? "p2pReady"
        : rtcStatus.value === "connecting"
          ? "p2pConnecting"
          : "httpAvailable",
);
const connectionIcon = computed(() =>
  connectionState.value === "p2pReady" ||
  connectionState.value === "transferP2p"
    ? "$mdiCheckCircleOutline"
    : connectionState.value === "p2pConnecting"
      ? "$mdiProgressClock"
      : "$mdiCloudOutline",
);
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
    await downloadFile(url, fileName || "download", { waitForP2pMs: 4000 });
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
      <div
        v-if="url"
        class="d-flex align-center justify-center ga-2 mt-3 text-body-2"
        :title="rtcIceRoute ?? undefined"
        role="status"
      >
        <v-icon :icon="connectionIcon" size="18" />
        {{ locale.t("$vuetify.chatroom.files." + connectionState) }}
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
          @click="download()"
        >
          {{ locale.t("$vuetify.chatroom.files.download") }}
        </v-btn>
      </template>
    </v-empty-state>
    <WorkspaceDownloadPreview
      v-if="previewOpen && workspaceId && path"
      v-model="previewOpen"
      :workspace-id="workspaceId"
      :path="path"
    />
  </v-main>
</template>
