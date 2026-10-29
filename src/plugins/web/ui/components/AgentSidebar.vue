<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { appIntlLocale } from "../locales.js";
import type {
  AgentModel,
  AgentProviderId,
  AgentProviderStatus,
  AgentSession,
  WorkspaceEntry,
} from "../api.js";
import {
  agentFileName,
  agentModelDisplayName,
  agentProviderIcon,
  agentProviderName,
} from "../utils/agent-display.js";
import AgentCreateSessionPanel from "./AgentCreateSessionPanel.vue";
import AgentProviderIcon from "./AgentProviderIcon.vue";
import AgentProviderStatusPanel from "./AgentProviderStatus.vue";

const props = defineProps<{
  providers: AgentProviderStatus[];
  providerModels: Readonly<Record<AgentProviderId, AgentModel[]>>;
  workspaces: WorkspaceEntry[];
  sessions: AgentSession[];
  selectedId: string | null;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  "update:selectedId": [sessionId: string | null];
  created: [session: AgentSession];
  "bulk-delete": [sessionIds: string[]];
}>();

const locale = useLocale();
const createOpen = shallowRef(false);
const searchQuery = shallowRef("");
const selectionMode = shallowRef(false);
const selectedForDeletion = shallowRef<string[]>([]);
const filteredSessions = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return props.sessions;
  return props.sessions.filter((session) => {
    const haystack = [
      agentProviderName(props.providers, session.provider),
      session.workspaceRoot,
      agentFileName(session.workspaceRoot),
      modelDisplayName(session.provider, session.model),
      session.status,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
});
const deletableSessions = computed(() =>
  filteredSessions.value.filter(
    (session) =>
      session.status !== "running" && session.status !== "waiting_input",
  ),
);
const allDeletableSelected = computed(
  () =>
    deletableSessions.value.length > 0 &&
    deletableSessions.value.every((session) =>
      selectedForDeletion.value.includes(session.id),
    ),
);

watch(
  () => props.sessions,
  (sessions) => {
    const existing = new Set(
      sessions
        .filter(
          (session) =>
            session.status !== "running" && session.status !== "waiting_input",
        )
        .map((session) => session.id),
    );
    selectedForDeletion.value = selectedForDeletion.value.filter((id) =>
      existing.has(id),
    );
    if (
      selectionMode.value &&
      selectedForDeletion.value.length === 0 &&
      sessions.length === 0
    )
      selectionMode.value = false;
  },
);

function toggleSelectionMode() {
  selectionMode.value = !selectionMode.value;
  selectedForDeletion.value = [];
  if (!selectionMode.value) searchQuery.value = "";
}

function toggleSessionSelection(id: string, checked: boolean) {
  selectedForDeletion.value = checked
    ? [...new Set([...selectedForDeletion.value, id])]
    : selectedForDeletion.value.filter((item) => item !== id);
}

function toggleAll(checked: boolean) {
  const visibleIds = new Set(
    deletableSessions.value.map((session) => session.id),
  );
  selectedForDeletion.value = checked
    ? [...new Set([...selectedForDeletion.value, ...visibleIds])]
    : selectedForDeletion.value.filter((id) => !visibleIds.has(id));
}

function requestBulkDelete() {
  if (selectedForDeletion.value.length)
    emit("bulk-delete", [...selectedForDeletion.value]);
}

function handleSessionClick(session: AgentSession) {
  if (selectionMode.value) {
    if (session.status === "running" || session.status === "waiting_input")
      return;
    toggleSessionSelection(
      session.id,
      !selectedForDeletion.value.includes(session.id),
    );
    return;
  }
  emit("update:selectedId", session.id);
}

function handleCreated(session: AgentSession) {
  createOpen.value = false;
  emit("created", session);
}

function modelDisplayName(
  provider: AgentProviderId,
  modelId: string | null,
): string {
  return agentModelDisplayName(
    props.providerModels,
    provider,
    modelId,
    locale.t("$vuetify.chatroom.agents.defaultModel"),
  );
}

function sessionUpdatedLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const sameYear = date.getFullYear() === now.getFullYear();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(
    appIntlLocale(locale.current.value),
    options,
  ).format(date);
}

function sessionStatusText(session: AgentSession): string {
  if (session.status === "waiting_input") {
    if (session.attention?.kind === "approval")
      return locale.t("$vuetify.chatroom.agents.waitingApproval");
    if (session.attention?.kind === "input")
      return locale.t("$vuetify.chatroom.agents.waitingAnswer");
  }
  return locale.t("$vuetify.chatroom.agents.statuses." + session.status);
}
</script>

<template>
  <v-card class="agent-sidebar panel-card">
    <div class="panel-header">
      <div class="agent-sidebar-heading">
        <div class="panel-title">
          {{ locale.t("$vuetify.chatroom.agents.title") }}
        </div>
        <v-chip size="x-small" variant="tonal" class="agent-session-count">
          {{ sessions.length }}
        </v-chip>
      </div>
      <div class="agent-sidebar-header-actions">
        <v-btn
          v-if="sessions.length"
          :icon="selectionMode ? '$mdiClose' : '$mdiDeleteSweepOutline'"
          size="small"
          variant="tonal"
          :color="selectionMode ? 'primary' : 'default'"
          :aria-label="
            locale.t(
              selectionMode
                ? '$vuetify.chatroom.agents.cancelSelection'
                : '$vuetify.chatroom.agents.selectSessions',
            )
          "
          :title="
            locale.t(
              selectionMode
                ? '$vuetify.chatroom.agents.cancelSelection'
                : '$vuetify.chatroom.agents.selectSessions',
            )
          "
          @click="toggleSelectionMode"
        />
        <v-btn
          icon="$mdiPlus"
          size="small"
          variant="tonal"
          color="primary"
          :aria-label="locale.t('$vuetify.chatroom.agents.newSession')"
          :title="locale.t('$vuetify.chatroom.agents.newSession')"
          @click="createOpen = !createOpen"
        />
      </div>
    </div>

    <v-divider />

    <v-expand-transition>
      <AgentCreateSessionPanel
        v-if="createOpen"
        :providers="providers"
        :provider-models="providerModels"
        :workspaces="workspaces"
        @created="handleCreated"
      />
    </v-expand-transition>

    <div v-if="error" class="agent-error" role="alert">
      <v-icon icon="$mdiAlertCircleOutline" size="18" />
      <span>{{ error }}</span>
    </div>

    <div v-if="sessions.length" class="agent-search-wrap">
      <v-text-field
        v-model="searchQuery"
        class="agent-session-search"
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        clearable
        prepend-inner-icon="$mdiMagnify"
        :placeholder="locale.t('$vuetify.chatroom.agents.searchSessions')"
        :aria-label="locale.t('$vuetify.chatroom.agents.searchSessions')"
      />
    </div>

    <div v-if="selectionMode" class="agent-bulk-toolbar">
      <v-checkbox
        class="agent-bulk-select-all"
        :model-value="allDeletableSelected"
        :indeterminate="selectedForDeletion.length > 0 && !allDeletableSelected"
        :disabled="!deletableSessions.length"
        :label="locale.t('$vuetify.chatroom.agents.selectAll')"
        density="compact"
        hide-details
        @update:model-value="toggleAll(Boolean($event))"
      />
      <span class="agent-bulk-count">{{
        locale.t(
          "$vuetify.chatroom.agents.selectedCount",
          selectedForDeletion.length,
        )
      }}</span>
      <v-spacer />
      <v-btn
        size="small"
        color="error"
        variant="tonal"
        prepend-icon="$mdiDeleteOutline"
        :disabled="!selectedForDeletion.length"
        @click="requestBulkDelete"
        >{{ locale.t("$vuetify.chatroom.agents.deleteSelected") }}</v-btn
      >
    </div>

    <div class="agent-session-list">
      <v-list
        v-if="filteredSessions.length"
        nav
        density="compact"
        class="agent-session-vlist"
      >
        <v-list-item
          v-for="session in filteredSessions"
          :key="session.id"
          :data-agent-session-id="session.id"
          rounded="lg"
          :active="
            selectionMode
              ? selectedForDeletion.includes(session.id)
              : selectedId === session.id
          "
          :disabled="
            selectionMode &&
            (session.status === 'running' || session.status === 'waiting_input')
          "
          @click="handleSessionClick(session)"
        >
          <template #prepend>
            <v-checkbox-btn
              v-if="selectionMode"
              :model-value="selectedForDeletion.includes(session.id)"
              :disabled="
                session.status === 'running' ||
                session.status === 'waiting_input'
              "
              :aria-label="locale.t('$vuetify.chatroom.agents.selectSession')"
              @click.stop
              @update:model-value="
                toggleSessionSelection(session.id, Boolean($event))
              "
            />
            <AgentProviderIcon
              v-else
              class="agent-session-provider-icon"
              :icon="agentProviderIcon(providers, session.provider)"
              :size="15"
            />
          </template>
          <v-list-item-title class="agent-session-title-row">
            <span>{{ agentProviderName(providers, session.provider) }}</span>
            <span class="agent-session-updated" :title="session.updatedAt">{{
              sessionUpdatedLabel(session.updatedAt)
            }}</span>
          </v-list-item-title>
          <v-list-item-subtitle>
            {{ agentFileName(session.workspaceRoot) }}
            <template v-if="session.model">
              · {{ modelDisplayName(session.provider, session.model) }}
            </template>
          </v-list-item-subtitle>
          <template #append>
            <span
              class="agent-status-dot"
              :data-status="session.status"
              :data-attention="session.attention?.kind ?? undefined"
              :title="sessionStatusText(session)"
            />
          </template>
        </v-list-item>
      </v-list>
      <div v-else class="empty-inline agent-empty-state">
        {{
          loading
            ? locale.t("$vuetify.chatroom.agents.loading")
            : sessions.length
              ? locale.t("$vuetify.chatroom.agents.noSearchResults")
              : locale.t("$vuetify.chatroom.agents.noSessions")
        }}
      </div>
    </div>

    <v-divider />
    <AgentProviderStatusPanel :providers="providers" />
  </v-card>
</template>

<style scoped>
.agent-sidebar {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  color: rgb(var(--v-theme-on-surface));
}

.agent-sidebar-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.agent-session-count {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.agent-sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.agent-search-wrap {
  padding: 10px 12px 8px;
}

.agent-session-search :deep(.v-field) {
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.045);
}

.agent-session-vlist {
  padding: 4px 8px 8px;
}

.agent-session-vlist :deep(.v-list-item) {
  margin: 2px 0;
  min-height: 54px;
  padding-inline: 10px;
  border: 1px solid transparent;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.agent-session-vlist :deep(.v-list-item--active) {
  border-color: rgba(var(--v-theme-primary), 0.2);
  background: rgba(var(--v-theme-primary), 0.09);
}

.agent-session-vlist :deep(.v-list-item-title) {
  font-size: 0.84rem;
  font-weight: 600;
}

.agent-session-vlist :deep(.v-list-item-subtitle) {
  font-size: 0.74rem;
  line-height: 1.35;
  opacity: 0.72;
}

.agent-session-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agent-session-updated {
  flex: 0 0 auto;
  color: rgba(var(--v-theme-on-surface), 0.48);
  font-size: 0.68rem;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.agent-empty-state {
  margin: 8px 12px 16px;
  border: 1px dashed rgba(var(--v-border-color), 0.24);
  border-radius: 10px;
}

.agent-bulk-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.12);
}

.agent-bulk-select-all {
  flex: 0 0 auto;
  margin-inline-end: 2px;
}

.agent-bulk-select-all :deep(.v-label) {
  font-size: 0.75rem;
  opacity: 0.78;
}

.agent-bulk-count {
  color: rgb(var(--v-theme-on-surface), 0.7);
  font-size: 12px;
  white-space: nowrap;
}

.agent-error {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 14px;
  color: rgb(var(--v-theme-error));
  font-size: 0.875rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.agent-session-list {
  min-height: 0;
  overflow-y: auto;
  flex: 1 1 auto;
}

.agent-session-provider-icon {
  margin-inline-end: 10px;
  color: rgba(var(--v-theme-on-surface), 0.72);
}

.agent-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.4);
}

.agent-status-dot[data-status="idle"] {
  background: rgb(var(--v-theme-success));
}

.agent-status-dot[data-status="running"] {
  background: rgb(var(--v-theme-primary));
}

.agent-status-dot[data-status="waiting_input"] {
  background: rgb(var(--v-theme-warning));
}

.agent-status-dot[data-status="waiting_input"][data-attention="input"] {
  background: rgb(var(--v-theme-info));
}

.agent-status-dot[data-status="error"] {
  background: rgb(var(--v-theme-error));
}

@media (max-width: 1100px) {
  .agent-sidebar {
    min-height: 0;
    max-height: calc(
      100dvh - var(--v-layout-top, 0px) - var(--app-content-block-start, 0px) -
        var(--app-content-block-end, 0px)
    );
  }
}
</style>
