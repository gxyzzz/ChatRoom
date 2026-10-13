<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { api } from "../api.js";
import TerminalCanvas from "./TerminalCanvas.vue";

interface Session {
  id: string;
  processId: string;
  shell: string;
  createdAt: string;
  state: string;
}

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ hide: [] }>();
const locale = useLocale();
const sessions = shallowRef<Session[]>([]);
const selected = ref<string | null>(null);
const busy = ref(false);
const error = ref("");
const current = computed(() =>
  sessions.value.find((s) => s.id === selected.value),
);
const label = (session: Session) =>
  session.shell.split(/[\\/]/).filter(Boolean).at(-1) ?? session.shell;

async function refresh(): Promise<void> {
  try {
    const all = await api<Session[]>("/terminal/sessions");
    sessions.value = all;
    if (!selected.value || !all.some((s) => s.id === selected.value))
      selected.value = all[0]?.id ?? null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function create(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const session = await api<Session>("/terminal/sessions", {
      method: "POST",
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    sessions.value = [session, ...sessions.value];
    selected.value = session.id;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function close(session: Session): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/terminal/sessions/${session.id}`, { method: "DELETE" });
    sessions.value = sessions.value.filter((s) => s.id !== session.id);
    if (selected.value === session.id)
      selected.value = sessions.value[0]?.id ?? null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

function markExited(sessionId: string): void {
  sessions.value = sessions.value.map((s) =>
    s.id === sessionId ? { ...s, state: "exited" } : s,
  );
}

onMounted(async () => {
  await refresh();
  if (!sessions.value.length) void create();
});
</script>

<template>
  <section
    class="terminal-panel-view"
    :aria-label="locale.t('$vuetify.chatroom.terminal.title')"
  >
    <header class="terminal-panel-toolbar">
      <span class="text-body-2 font-weight-medium terminal-panel-title">
        {{ locale.t("$vuetify.chatroom.terminal.title") }}
      </span>
      <div class="terminal-tabs" role="tablist">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="terminal-tab"
          :class="{ 'terminal-tab--selected': session.id === selected }"
        >
          <button
            class="terminal-tab-label"
            type="button"
            role="tab"
            :aria-selected="session.id === selected"
            @click="selected = session.id"
          >
            <v-icon icon="$mdiConsoleLine" size="small" />
            <span class="text-truncate">{{ label(session) }}</span>
            <v-icon
              v-if="session.state !== 'running'"
              icon="$mdiCircleOutline"
              size="x-small"
            />
          </button>
          <v-btn
            icon="$mdiClose"
            size="x-small"
            variant="text"
            density="compact"
            :disabled="busy"
            :aria-label="locale.t('$vuetify.chatroom.terminal.close')"
            @click="close(session)"
          />
        </div>
      </div>
      <div class="terminal-panel-actions">
        <v-btn
          icon="$mdiPlus"
          size="small"
          variant="text"
          :disabled="busy"
          :loading="busy"
          :aria-label="locale.t('$vuetify.chatroom.terminal.new')"
          @click="create"
        />
        <v-btn
          icon="$mdiClose"
          size="small"
          variant="text"
          :aria-label="locale.t('$vuetify.chatroom.terminal.hide')"
          @click="emit('hide')"
        />
      </div>
    </header>
    <div v-if="error" class="terminal-panel-error text-caption" role="alert">
      <v-icon icon="$mdiAlertCircleOutline" size="small" color="error" />
      <span class="text-truncate" :title="error">{{ error }}</span>
      <v-btn
        icon="$mdiClose"
        size="x-small"
        density="compact"
        variant="text"
        :aria-label="locale.t('$vuetify.chatroom.common.close')"
        @click="error = ''"
      />
    </div>
    <TerminalCanvas
      v-if="current"
      :key="current.id"
      :session-id="current.id"
      :visible="props.visible"
      @error="error = $event"
      @exit="markExited(current.id)"
    />
    <div v-else class="terminal-placeholder text-medium-emphasis">
      <span>{{ locale.t("$vuetify.chatroom.terminal.empty") }}</span>
      <v-btn
        color="primary"
        variant="tonal"
        :disabled="busy"
        :loading="busy"
        @click="create"
      >
        {{ locale.t("$vuetify.chatroom.terminal.new") }}
      </v-btn>
    </div>
  </section>
</template>

<style scoped>
.terminal-panel-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: rgb(var(--v-theme-surface));
}
.terminal-panel-toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 4px 10px;
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.1);
}
.terminal-panel-title {
  flex: 0 0 auto;
}
.terminal-tabs {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}
.terminal-tab {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  max-width: min(220px, 55vw);
  border-right: 1px solid rgb(var(--v-theme-outline), 0.1);
}
.terminal-tab--selected {
  background: rgb(var(--v-theme-primary), 0.07);
  box-shadow: inset 0 -2px rgb(var(--v-theme-primary));
}
.terminal-tab-label {
  border: 0;
  border-radius: 0;
  background: transparent;
  appearance: none;
  font: inherit;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 5px 8px;
  color: inherit;
  cursor: pointer;
}
.terminal-panel-actions {
  display: flex;
  flex: 0 0 auto;
}
.terminal-panel-error {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-width: 0;
  padding: 3px 10px;
  color: rgb(var(--v-theme-error));
  background: rgb(var(--v-theme-error), 0.08);
}
.terminal-panel-error > span {
  flex: 1;
  min-width: 0;
}
.terminal-placeholder {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 12px;
  min-height: 0;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
</style>
