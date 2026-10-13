<script setup lang="ts">
import { ref, shallowRef } from "vue";
import { useLocale } from "vuetify";
import type { AgentItem } from "../api.js";
import { downloadFile } from "../utils/download.js";

type ImageArtifactItem = Extract<AgentItem, { type: "artifact" }>;

const props = defineProps<{
  items: ImageArtifactItem[];
  workspaceRoot: string;
}>();

const locale = useLocale();
const loaded = ref<Record<string, boolean>>({});
const errors = ref<Record<string, string>>({});
const retries = ref<Record<string, string>>({});
const preview = shallowRef<ImageArtifactItem | null>(null);

function stateKey(item: ImageArtifactItem): string {
  return `${props.workspaceRoot}:${item.artifact.path}:${item.id}:${item.updatedAt}:${retries.value[item.id] ?? ""}`;
}

function endpoint(item: ImageArtifactItem): string {
  const version = `${item.id}:${item.updatedAt}`;
  return (
    "/api/workspace/file/image?root=" +
    encodeURIComponent(props.workspaceRoot) +
    "&path=" +
    encodeURIComponent(item.artifact.path) +
    "&v=" +
    encodeURIComponent(version) +
    (retries.value[item.id]
      ? "&retry=" + encodeURIComponent(retries.value[item.id]!)
      : "")
  );
}

function isLoaded(item: ImageArtifactItem): boolean {
  return Boolean(loaded.value[stateKey(item)]);
}

function errorFor(item: ImageArtifactItem): string {
  return errors.value[stateKey(item)] ?? "";
}

function imageLoaded(item: ImageArtifactItem) {
  const key = stateKey(item);
  loaded.value[key] = true;
  delete errors.value[key];
}

function imageDecodeFailed(item: ImageArtifactItem) {
  const key = stateKey(item);
  loaded.value[key] = false;
  errors.value[key] = locale.t("$vuetify.chatroom.agents.imageDecodeFailed");
}

function retry(item: ImageArtifactItem) {
  retries.value[item.id] = crypto.randomUUID();
}

function openPreview(item: ImageArtifactItem) {
  if (isLoaded(item)) preview.value = item;
}

function download(item: ImageArtifactItem) {
  if (!isLoaded(item)) return;
  void downloadFile(endpoint(item), item.artifact.name).catch(() => {});
}
</script>

<template>
  <div class="agent-artifact-group">
    <div class="agent-artifact-group-heading">
      <v-icon icon="$mdiFileEyeOutline" size="17" />
      <span>
        {{
          items.length === 1
            ? locale.t("$vuetify.chatroom.agents.generatedImage")
            : locale.t("$vuetify.chatroom.agents.generatedImages", items.length)
        }}
      </span>
    </div>

    <div class="agent-artifact-grid" :data-count="items.length">
      <div v-for="item in items" :key="item.id" class="agent-artifact-tile">
        <div class="agent-artifact-media">
          <button
            v-if="item.status === 'completed'"
            type="button"
            class="agent-artifact-image-button"
            :aria-label="item.artifact.name"
            :disabled="!isLoaded(item)"
            @click="openPreview(item)"
          >
            <img
              :key="stateKey(item)"
              class="agent-artifact-image"
              :src="endpoint(item)"
              :alt="item.artifact.name"
              loading="lazy"
              decoding="async"
              @load="imageLoaded(item)"
              @error="imageDecodeFailed(item)"
            />
          </button>

          <div
            v-if="
              item.status === 'running' ||
              item.status === 'waiting' ||
              (item.status === 'completed' &&
                !isLoaded(item) &&
                !errorFor(item))
            "
            class="agent-artifact-placeholder agent-artifact-overlay"
          >
            <v-progress-circular indeterminate size="24" width="2" />
            <span>{{ locale.t("$vuetify.chatroom.agents.imageLoading") }}</span>
          </div>

          <div
            v-else-if="
              item.status === 'failed' ||
              item.status === 'interrupted' ||
              errorFor(item)
            "
            class="agent-artifact-placeholder agent-artifact-overlay error"
          >
            <v-icon icon="$mdiAlertCircleOutline" size="22" />
            <span>{{
              locale.t("$vuetify.chatroom.agents.imageLoadFailed")
            }}</span>
            <span v-if="errorFor(item)" class="agent-artifact-error-detail">
              {{ errorFor(item) }}
            </span>
            <v-btn
              v-if="item.status === 'completed'"
              size="small"
              variant="tonal"
              @click="retry(item)"
            >
              {{ locale.t("$vuetify.chatroom.agents.retry") }}
            </v-btn>
          </div>
        </div>

        <div class="agent-artifact-footer">
          <span class="agent-artifact-name" :title="item.artifact.path">
            {{ item.artifact.name }}
          </span>
          <v-btn
            icon="$mdiDownloadOutline"
            size="x-small"
            variant="text"
            :disabled="!isLoaded(item)"
            :aria-label="locale.t('$vuetify.chatroom.code.download')"
            @click="download(item)"
          />
        </div>
      </div>
    </div>

    <v-dialog
      :model-value="Boolean(preview)"
      max-width="90vw"
      @update:model-value="preview = $event ? preview : null"
    >
      <v-card v-if="preview" class="agent-artifact-preview-dialog">
        <div class="agent-artifact-preview-header">
          <span class="text-truncate">{{ preview.artifact.name }}</span>
          <v-btn
            icon="$mdiClose"
            size="small"
            variant="text"
            :aria-label="locale.t('$vuetify.chatroom.common.close')"
            @click="preview = null"
          />
        </div>
        <div class="agent-artifact-preview-body">
          <img
            :src="endpoint(preview)"
            :alt="preview.artifact.name"
            decoding="async"
          />
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.agent-artifact-group {
  min-width: 0;
  align-self: stretch;
}

.agent-artifact-group-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.76rem;
  font-weight: 600;
}

.agent-artifact-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: 10px;
}

.agent-artifact-grid[data-count="1"] {
  grid-template-columns: minmax(0, 1fr);
}

.agent-artifact-tile {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), 0.2);
  border-radius: 10px;
  background: rgba(var(--v-theme-surface-variant), 0.06);
}

.agent-artifact-media {
  position: relative;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: rgba(var(--v-theme-on-surface), 0.025);
}

.agent-artifact-image-button {
  width: 100%;
  height: 100%;
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}

.agent-artifact-image-button:disabled {
  cursor: default;
}

.agent-artifact-image {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  background:
    linear-gradient(
      45deg,
      rgba(var(--v-theme-on-surface), 0.025) 25%,
      transparent 25%,
      transparent 75%,
      rgba(var(--v-theme-on-surface), 0.025) 75%
    ),
    linear-gradient(
      45deg,
      rgba(var(--v-theme-on-surface), 0.025) 25%,
      transparent 25%,
      transparent 75%,
      rgba(var(--v-theme-on-surface), 0.025) 75%
    );
  background-position:
    0 0,
    8px 8px;
  background-size: 16px 16px;
}

.agent-artifact-placeholder {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  padding: 20px;
  color: rgba(var(--v-theme-on-surface), 0.56);
  text-align: center;
  font-size: 0.78rem;
}

.agent-artifact-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: rgb(var(--v-theme-surface));
}

.agent-artifact-overlay.error {
  pointer-events: auto;
}

.agent-artifact-placeholder.error {
  color: rgb(var(--v-theme-error));
}

.agent-artifact-error-detail {
  max-width: 100%;
  overflow: hidden;
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-family: var(--font-mono, monospace);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-artifact-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border-top: 1px solid rgba(var(--v-border-color), 0.15);
}

.agent-artifact-name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-family: var(--font-mono, monospace);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-artifact-preview-dialog {
  overflow: hidden;
}

.agent-artifact-preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 7px 5px 14px;
  font-size: 0.82rem;
}

.agent-artifact-preview-header > :first-child {
  min-width: 0;
  flex: 1 1 auto;
}

.agent-artifact-preview-body {
  display: grid;
  place-items: center;
  max-height: 75dvh;
  overflow: auto;
  background: rgba(var(--v-theme-on-surface), 0.025);
}

.agent-artifact-preview-body img {
  max-width: 100%;
  max-height: 75dvh;
  object-fit: contain;
}

@media (max-width: 960px) {
  .agent-artifact-grid {
    grid-template-columns: 1fr;
  }
}
</style>
