<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from "vue";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

const props = defineProps<{
  document: PDFDocumentProxy;
  pageNumber: number;
  scrollRoot: HTMLElement | null;
}>();

const host = shallowRef<HTMLElement | null>(null);
const canvas = shallowRef<HTMLCanvasElement | null>(null);
const ready = shallowRef(false);
const aspectRatio = shallowRef("210 / 297");
const error = shallowRef("");
let observer: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let renderTask: RenderTask | null = null;
let visible = false;
let generation = 0;
let lastWidth = 0;

function clearPage() {
  generation += 1;
  renderTask?.cancel();
  renderTask = null;
  ready.value = false;
  lastWidth = 0;
  const element = canvas.value;
  if (element) {
    element.width = 0;
    element.height = 0;
  }
}

async function renderPage() {
  const width = host.value?.clientWidth ?? 0;
  if (!visible || width <= 0 || !canvas.value) return;
  lastWidth = width;
  const current = ++generation;
  const previousTask = renderTask;
  previousTask?.cancel();
  renderTask = null;
  ready.value = false;
  error.value = "";
  try {
    if (previousTask) await previousTask.promise.catch(() => undefined);
    if (current !== generation) return;
    const page = await props.document.getPage(props.pageNumber);
    if (current !== generation) return;
    const base = page.getViewport({ scale: 1 });
    aspectRatio.value = `${base.width} / ${base.height}`;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({
      scale: (width / base.width) * pixelRatio,
    });
    const element = canvas.value;
    if (!element) return;
    const context = element.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D context is unavailable");
    element.width = Math.ceil(viewport.width);
    element.height = Math.ceil(viewport.height);
    renderTask = page.render({
      canvas: element,
      canvasContext: context,
      viewport,
    });
    await renderTask.promise;
    if (current === generation) ready.value = true;
  } catch (cause) {
    if (
      current === generation &&
      !(cause instanceof Error && cause.name === "RenderingCancelledException")
    )
      error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

onMounted(() => {
  if (!host.value) return;
  observer = new IntersectionObserver(
    ([entry]) => {
      const next = entry?.isIntersecting ?? false;
      if (visible === next) return;
      visible = next;
      if (visible) void renderPage();
      else clearPage();
    },
    { root: props.scrollRoot, rootMargin: "400px 0px" },
  );
  observer.observe(host.value);
  resizeObserver = new ResizeObserver(() => {
    const width = host.value?.clientWidth ?? 0;
    if (visible && width > 0 && width !== lastWidth) void renderPage();
  });
  resizeObserver.observe(host.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  resizeObserver?.disconnect();
  clearPage();
});
</script>

<template>
  <div ref="host" class="workspace-pdf-page">
    <div class="workspace-pdf-paper" :style="{ aspectRatio }">
      <canvas v-show="ready" ref="canvas" />
      <v-alert v-if="error" type="error" variant="tonal" density="compact">
        {{ error }}
      </v-alert>
    </div>
    <span class="workspace-pdf-page-number"
      >{{ pageNumber }} / {{ document.numPages }}</span
    >
  </div>
</template>

<style scoped>
.workspace-pdf-page {
  width: 100%;
  max-width: 60rem;
}
.workspace-pdf-paper {
  overflow: hidden;
  background: white;
  box-shadow: 0 1px 6px rgb(0 0 0 / 12%);
}
.workspace-pdf-paper canvas {
  display: block;
  width: 100%;
  height: auto;
}
.workspace-pdf-page-number {
  display: block;
  padding-top: 6px;
  text-align: center;
  font-size: 12px;
  color: rgb(var(--v-theme-on-surface), 0.6);
}
</style>
