<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { useLocale } from "vuetify";

const WorkspacePdfPreview = defineAsyncComponent(
  () => import("./WorkspacePdfPreview.vue"),
);

defineProps<{
  kind: "pdf" | "video" | "audio";
  path: string;
  url: string;
}>();
const locale = useLocale();
</script>

<template>
  <div class="workspace-media-preview">
    <WorkspacePdfPreview v-if="kind === 'pdf'" :url="url" :path="path" />
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
</style>
