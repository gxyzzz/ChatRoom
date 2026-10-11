<script setup lang="ts">
import { useLocale } from "vuetify";

defineProps<{
  kind: "pdf" | "video" | "audio";
  path: string;
  url: string;
}>();
const locale = useLocale();
</script>

<template>
  <div class="workspace-media-preview">
    <iframe
      v-if="kind === 'pdf'"
      class="workspace-pdf-frame"
      :src="url"
      :title="path"
    />
    <video
      v-else-if="kind === 'video'"
      :key="url"
      class="workspace-video-player"
      :src="url"
      preload="metadata"
      playsinline
      controls
    />
    <audio
      v-else
      :key="url"
      class="workspace-audio-player"
      :src="url"
      preload="metadata"
      controls
    />
    <a :href="url" target="_blank" rel="noopener noreferrer">
      {{ locale.t("$vuetify.chatroom.files.openOriginal") }}
    </a>
  </div>
</template>

<style scoped>
.workspace-media-preview {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.workspace-pdf-frame {
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  border: 0;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
}
.workspace-video-player {
  width: 100%;
  max-height: 100%;
}
.workspace-audio-player {
  width: 100%;
}
.workspace-media-preview a {
  align-self: flex-end;
  font-size: 12px;
}
@media (max-width: 820px) {
  .workspace-pdf-frame {
    min-height: 70dvh;
  }
}
</style>
