<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useLocale, useTheme } from "vuetify";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../api.js";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ sessionId: string; visible: boolean }>();
const emit = defineEmits<{ exit: []; error: [message: string] }>();
const locale = useLocale();
const theme = useTheme();
const host = ref<HTMLElement | null>(null);
const connection = ref<"connecting" | "connected" | "offline" | "exited">(
  "connecting",
);
let terminal: Terminal | null = null;
let fit: FitAddon | null = null;
let source: EventSource | null = null;
let observer: ResizeObserver | null = null;
let frame = 0;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let inputTimer: ReturnType<typeof setTimeout> | null = null;
let pendingInput = "";
let writing = false;
let disposed = false;
let lastSize = "";

function readColor(name: string): string {
  const rgb = getComputedStyle(host.value!).getPropertyValue(name).trim();
  return rgb ? `rgb(${rgb})` : "";
}

function applyTheme(): void {
  if (!host.value || !terminal) return;
  const style = getComputedStyle(host.value);
  terminal.options.theme = {
    background: style.backgroundColor,
    foreground: style.color,
    cursor: readColor("--v-theme-primary") || style.color,
    selectionBackground: readColor("--v-theme-primary") || style.color,
  };
}

function fitTerminal(): void {
  if (!terminal || !fit || !host.value || disposed) return;
  if (!host.value.clientWidth || !host.value.clientHeight) return;
  try {
    fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = terminal;
  if (cols < 2 || rows < 2 || cols > 500 || rows > 500) return;
  const next = `${cols}:${rows}`;
  if (next === lastSize) return;
  lastSize = next;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    void api(`/terminal/sessions/${props.sessionId}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  }, 100);
}

function scheduleFit(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = 0;
    fitTerminal();
  });
}

async function sendInput(): Promise<void> {
  if (writing || disposed) return;
  writing = true;
  try {
    while (pendingInput && !disposed) {
      // Bounded request bodies, ordered input, no concurrent keystroke races.
      let end = Math.min(pendingInput.length, 4000);
      if (end < pendingInput.length) {
        const code = pendingInput.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      const chunk = pendingInput.slice(0, end);
      pendingInput = pendingInput.slice(end);
      await api(`/terminal/sessions/${props.sessionId}/input`, {
        method: "POST",
        body: JSON.stringify({ data: chunk }),
      });
    }
  } catch (cause) {
    pendingInput = "";
    if (!disposed)
      emit("error", cause instanceof Error ? cause.message : String(cause));
  } finally {
    writing = false;
  }
}

function queueInput(data: string): void {
  if (!data || disposed || connection.value === "exited") return;
  if (pendingInput.length + data.length > 64 * 1024) {
    emit("error", "Terminal input queue is full");
    return;
  }
  pendingInput += data;
  if (inputTimer) return;
  inputTimer = setTimeout(() => {
    inputTimer = null;
    void sendInput();
  }, 12);
}

function decodedBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

onMounted(() => {
  const element = host.value;
  if (!element) return;
  const t = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: "monospace",
    fontSize: Math.round(parseFloat(getComputedStyle(element).fontSize)) || 14,
    allowTransparency: false,
  });
  const addon = new FitAddon();
  terminal = t;
  fit = addon;
  t.loadAddon(addon);
  t.open(element);
  applyTheme();
  if (props.visible) t.focus();
  t.onData(queueInput);
  observer = new ResizeObserver(scheduleFit);
  observer.observe(element);
  scheduleFit();

  const stream = new EventSource(
    `/api/terminal/sessions/${props.sessionId}/stream`,
  );
  source = stream;
  stream.addEventListener("snapshot", (e) => {
    if (disposed) return;
    connection.value = "connected";
    t.reset();
    const snapshot = JSON.parse((e as MessageEvent).data) as {
      output: string;
      state: string;
    };
    if (snapshot.output) t.write(decodedBytes(snapshot.output));
    if (snapshot.state !== "running") connection.value = "exited";
    scheduleFit();
  });
  stream.addEventListener("output", (e) => {
    if (!disposed)
      t.write(decodedBytes(JSON.parse((e as MessageEvent).data) as string));
  });
  stream.addEventListener("exit", () => {
    connection.value = "exited";
    stream.close();
    emit("exit");
  });
  stream.onopen = () => {
    if (connection.value !== "exited") connection.value = "connected";
  };
  stream.onerror = () => {
    if (connection.value !== "exited") connection.value = "offline";
  };
});

watch(
  () => theme.global.name.value,
  () => requestAnimationFrame(applyTheme),
);
watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    requestAnimationFrame(() => {
      scheduleFit();
      terminal?.focus();
    });
  },
);

onBeforeUnmount(() => {
  disposed = true;
  source?.close();
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
  if (resizeTimer) clearTimeout(resizeTimer);
  if (inputTimer) clearTimeout(inputTimer);
  terminal?.dispose();
});
</script>

<template>
  <div class="terminal-canvas-shell">
    <div ref="host" class="terminal-canvas" />
    <span
      v-if="connection !== 'connected'"
      class="terminal-connection text-caption text-medium-emphasis"
      >{{ locale.t(`$vuetify.chatroom.terminal.${connection}`) }}</span
    >
  </div>
</template>

<style scoped>
.terminal-canvas-shell {
  display: flex;
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
}
.terminal-canvas {
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  flex: 1;
  min-width: 0;
  min-height: 0;
  font-family: monospace;
  font-size: inherit;
}
.terminal-connection {
  position: absolute;
  inset-block-start: 8px;
  inset-inline-end: 12px;
  pointer-events: none;
}
</style>
