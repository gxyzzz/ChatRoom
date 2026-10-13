<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { bytes } from "../utils.js";
import {
  isMarkdownFile,
  nameOf,
  useWorkspaceFiles,
} from "../composables/useWorkspaceFiles.js";
import CodeViewer from "./CodeViewer.vue";
import WorkspaceCsvPreview from "./WorkspaceCsvPreview.vue";
import WorkspaceMediaPreview from "./WorkspaceMediaPreview.vue";
import MarkdownContent from "./MarkdownContent.vue";
import { workspaceDownloadUrl } from "../utils/workspace-download.js";
import { downloadFile } from "../utils/download.js";

const props = defineProps<{ root: string }>();
const locale = useLocale();
const markdownMode = shallowRef<"preview" | "source">("preview");
const imageLoading = shallowRef(false);
const imageError = shallowRef(false);
const workspaceFiles = useWorkspaceFiles(() => props.root);
const {
  entries,
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
  loadMore,
  navigate,
  openEntry,
} = workspaceFiles;

watch(
  () => file.value?.path ?? null,
  () => {
    markdownMode.value = "preview";
  },
);

watch(
  () => (file.value?.kind === "image" ? file.value.url : null),
  (url) => {
    imageLoading.value = Boolean(url);
    imageError.value = false;
  },
);

const selectedFile = computed(() =>
  entries.value.find(
    (entry) => entry.path === selectedPath.value && entry.type === "file",
  ),
);

function downloadSelected(): void {
  if (!selectedFile.value) return;
  const path = selectedFile.value.path;
  void downloadFile(workspaceDownloadUrl(props.root, path), nameOf(path)).catch(
    () => {},
  );
}

function typeLabel(type: string): string {
  if (type === "file") return locale.t("$vuetify.chatroom.files.file");
  if (type === "directory")
    return locale.t("$vuetify.chatroom.files.directory");
  if (type === "symlink") return locale.t("$vuetify.chatroom.files.symlink");
  return type;
}
</script>

<template>
  <div class="workspace-files-pane">
    <v-alert v-if="error" type="error" variant="tonal" density="compact">
      {{ error }}
    </v-alert>
    <div class="workspace-files-layout">
      <div class="workspace-file-browser">
        <div class="workspace-file-breadcrumbs">
          <v-btn
            icon="$mdiArrowUp"
            size="x-small"
            variant="text"
            :disabled="parentPath === null"
            :aria-label="locale.t('$vuetify.chatroom.files.parentDirectory')"
            @click="parentPath && navigate(parentPath)"
          />
          <div class="workspace-breadcrumb-items">
            <template v-for="(item, index) in breadcrumbs" :key="item.path">
              <span v-if="index" class="workspace-breadcrumb-separator">/</span>
              <button
                type="button"
                class="workspace-breadcrumb"
                :class="{ active: index === breadcrumbs.length - 1 }"
                @click="navigate(item.path)"
              >
                {{ item.title }}
              </button>
            </template>
          </div>
          <v-btn
            icon="$mdiRefresh"
            size="x-small"
            variant="text"
            :loading="loading"
            :aria-label="locale.t('$vuetify.chatroom.files.refresh')"
            @click="loadDirectory()"
          />
        </div>

        <v-list
          density="compact"
          border
          rounded="lg"
          class="workspace-file-list"
        >
          <v-list-item
            v-for="entry in entries"
            :key="entry.path"
            :active="selectedPath === entry.path"
            :title="nameOf(entry.path)"
            :subtitle="
              entry.type === 'file'
                ? `${typeLabel(entry.type)} · ${bytes(entry.size)}`
                : typeLabel(entry.type)
            "
            :prepend-icon="
              entry.type === 'directory'
                ? '$mdiFolderOutline'
                : entry.type === 'symlink'
                  ? '$mdiLinkVariant'
                  : '$mdiFileOutline'
            "
            :append-icon="
              entry.type === 'directory' ? '$mdiChevronRight' : undefined
            "
            @click="openEntry(entry)"
          />
        </v-list>
        <div v-if="nextOffset !== null" class="workspace-file-load-more">
          <v-btn
            size="small"
            variant="text"
            :loading="loadingMore"
            :disabled="loading"
            @click="loadMore"
          >
            {{ locale.t("$vuetify.chatroom.files.loadMore") }}
          </v-btn>
        </div>
      </div>

      <div
        class="workspace-file-preview"
        :aria-busy="previewLoading || imageLoading"
      >
        <div v-if="selectedFile" class="workspace-preview-toolbar">
          <span
            class="workspace-preview-filename mono"
            :title="selectedFile.path"
          >
            {{ selectedFile.path }}
          </span>
          <v-btn
            size="small"
            variant="tonal"
            prepend-icon="$mdiDownloadOutline"
            @click="downloadSelected"
          >
            {{ locale.t("$vuetify.chatroom.files.download") }}
          </v-btn>
        </div>
        <div class="workspace-preview-content">
          <v-progress-linear v-if="previewLoading" indeterminate />
          <v-alert
            v-if="file?.kind === 'text' && file.truncated"
            type="warning"
            variant="tonal"
            density="compact"
            class="workspace-preview-truncated"
          >
            {{ locale.t("$vuetify.chatroom.files.previewTruncated") }}
          </v-alert>
          <WorkspaceMediaPreview
            v-if="
              file &&
              (file.kind === 'pdf' ||
                file.kind === 'video' ||
                file.kind === 'audio')
            "
            :key="file.url"
            :kind="file.kind"
            :path="file.path"
            :url="file.url"
          />
          <WorkspaceCsvPreview
            v-else-if="file?.kind === 'text' && /\.(csv|tsv)$/i.test(file.path)"
            :content="file.content"
            :path="file.path"
            :truncated="file.truncated"
          />
          <v-sheet
            v-else-if="file?.kind === 'text' && isMarkdownFile(file.path)"
            border
            rounded="lg"
            class="workspace-markdown-preview"
          >
            <div class="workspace-markdown-header">
              <v-btn-toggle
                v-model="markdownMode"
                mandatory
                density="compact"
                variant="text"
                divided
                class="workspace-markdown-mode"
              >
                <v-btn value="preview" size="small">
                  {{ locale.t("$vuetify.chatroom.files.preview") }}
                </v-btn>
                <v-btn value="source" size="small">
                  {{ locale.t("$vuetify.chatroom.files.source") }}
                </v-btn>
              </v-btn-toggle>
            </div>
            <v-divider />
            <div
              v-if="markdownMode === 'preview'"
              class="workspace-markdown-body"
            >
              <MarkdownContent :text="file.content" />
            </div>
            <div v-else class="workspace-markdown-source">
              <CodeViewer
                :text="file.content"
                :filename="file.path"
                :toolbar="false"
              />
            </div>
          </v-sheet>
          <CodeViewer
            v-else-if="file?.kind === 'text'"
            :text="file.content"
            :filename="file.path"
            :show-download="false"
          />
          <v-sheet
            v-else-if="file?.kind === 'image'"
            border
            rounded="lg"
            class="workspace-image-preview"
          >
            <div class="workspace-image-stage">
              <v-progress-linear v-if="imageLoading" indeterminate />
              <v-empty-state
                v-if="imageError"
                icon="$mdiAlertCircleOutline"
                :title="locale.t('$vuetify.chatroom.common.imageLoadFailed')"
              />
              <img
                v-else
                :key="file.url"
                :src="file.url"
                :alt="file.path"
                decoding="async"
                @load="imageLoading = false"
                @error="
                  imageLoading = false;
                  imageError = true;
                "
              />
            </div>
          </v-sheet>
          <v-empty-state
            v-else-if="file?.kind === 'unsupported'"
            icon="$mdiFileQuestionOutline"
            :title="locale.t('$vuetify.chatroom.files.previewUnavailable')"
            :text="file.path"
          />
          <v-empty-state
            v-else-if="!previewLoading"
            icon="$mdiFileEyeOutline"
            :title="locale.t('$vuetify.chatroom.files.select')"
            :text="locale.t('$vuetify.chatroom.files.readOnly')"
          />
        </div>
      </div>
    </div>
  </div>
</template>
