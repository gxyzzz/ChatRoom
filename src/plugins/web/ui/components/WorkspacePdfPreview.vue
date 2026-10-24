<script setup lang="ts">
import { shallowRef, watch } from "vue";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import WorkspacePdfPage from "./WorkspacePdfPage.vue";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const props = defineProps<{ url: string; path: string }>();
const document = shallowRef<PDFDocumentProxy | null>(null);
const scrollRoot = shallowRef<HTMLElement | null>(null);
const loading = shallowRef(true);
const error = shallowRef("");

watch(
  () => props.url,
  (url, _previous, onCleanup) => {
    document.value = null;
    loading.value = true;
    error.value = "";
    const task = getDocument({
      url,
      withCredentials: true,
      cMapUrl: `${import.meta.env.BASE_URL}assets/pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${import.meta.env.BASE_URL}assets/pdfjs/standard_fonts/`,
    });
    let disposed = false;
    onCleanup(() => {
      disposed = true;
      void task.destroy();
    });
    void task.promise
      .then((pdf) => {
        if (disposed) {
          return;
        }
        document.value = pdf;
      })
      .catch((cause: unknown) => {
        if (!disposed)
          error.value = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(() => {
        if (!disposed) loading.value = false;
      });
  },
  { immediate: true },
);
</script>

<template>
  <div class="workspace-pdf-viewer" :aria-label="path">
    <v-progress-linear v-if="loading" indeterminate />
    <v-alert v-if="error" type="error" variant="tonal" density="compact">
      {{ error }}
    </v-alert>
    <div ref="scrollRoot" class="workspace-pdf-pages">
      <WorkspacePdfPage
        v-for="page in document?.numPages ?? 0"
        :key="page"
        :document="document!"
        :page-number="page"
        :scroll-root="scrollRoot"
      />
    </div>
  </div>
</template>

<style scoped>
.workspace-pdf-viewer {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  flex-direction: column;
}
.workspace-pdf-pages {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px;
  background: rgb(var(--v-theme-surface-variant), 0.18);
}
@media (max-width: 820px) {
  .workspace-pdf-viewer {
    min-height: 70dvh;
  }
}
</style>
