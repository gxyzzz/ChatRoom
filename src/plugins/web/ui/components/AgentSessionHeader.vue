<script setup lang="ts">
import { useLocale } from "vuetify";
import type {
  AgentProviderId,
  AgentProviderStatus,
  AgentSession,
} from "../api.js";
import AgentProviderIcon from "./AgentProviderIcon.vue";

defineProps<{
  session: AgentSession;
  providerName: string;
  providerIcon: string | null;
  modelName: string;
  statusText: string;
  usage: string;
  compact: boolean;
  switchTargets: AgentProviderStatus[];
  switching: boolean;
  disabled: boolean;
}>();

defineEmits<{
  back: [];
  switchProvider: [provider: AgentProviderId];
}>();

const locale = useLocale();
</script>

<template>
  <div class="panel-header agent-session-header">
    <v-btn
      v-if="compact"
      icon="$mdiArrowLeft"
      size="small"
      :aria-label="locale.t('$vuetify.chatroom.agents.backToSessions')"
      variant="text"
      @click="$emit('back')"
    />
    <div class="agent-session-header-info min-w-0">
      <div class="panel-title agent-session-provider-title">
        <AgentProviderIcon :icon="providerIcon" :size="16" />
        <span>{{ providerName }}</span>
        <span class="agent-session-model-label">· {{ modelName }}</span>
      </div>
      <div class="panel-subtitle text-truncate">
        {{ session.workspaceName }}
      </div>
      <div v-if="usage" class="agent-session-token-usage">
        {{ usage }}
      </div>
    </div>

    <div class="agent-session-header-status" :data-status="session.status">
      <span
        class="agent-session-status-dot"
        :data-status="session.status"
        :data-attention="session.attention?.kind ?? undefined"
      />
      <span class="agent-session-header-status-text">{{ statusText }}</span>
    </div>

    <v-menu
      v-if="switchTargets.length"
      location="bottom end"
      offset="6"
      content-class="agent-overlay-menu"
    >
      <template #activator="{ props: switchMenuProps }">
        <v-btn
          v-bind="switchMenuProps"
          class="agent-session-header-switch"
          size="small"
          variant="text"
          prepend-icon="$mdiSwapHorizontal"
          append-icon="$mdiChevronDown"
          :loading="switching"
          :disabled="disabled"
          :aria-label="locale.t('$vuetify.chatroom.agents.switchAgent')"
        >
          {{ locale.t("$vuetify.chatroom.agents.switchAgent") }}
        </v-btn>
      </template>
      <v-list class="agent-session-switch-menu" density="compact">
        <v-list-item
          v-for="provider in switchTargets"
          :key="provider.id"
          :title="provider.displayName"
          @click="$emit('switchProvider', provider.id)"
        >
          <template #prepend>
            <span class="agent-session-switch-provider-icon">
              <AgentProviderIcon :icon="provider.icon" :size="15" />
            </span>
          </template>
        </v-list-item>
      </v-list>
    </v-menu>
  </div>
</template>

<style scoped>
.agent-session-header {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
  background: rgb(var(--v-theme-surface));
}

.agent-session-header-info {
  flex: 1 1 auto;
  min-width: 0;
}

.agent-session-provider-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.agent-session-model-label {
  min-width: 0;
  overflow: hidden;
  color: rgba(var(--v-theme-on-surface), 0.62);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-session-header-status {
  flex: 0 0 auto;
  align-self: center;
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border-radius: 8px;
  color: rgba(var(--v-theme-on-surface), 0.74);
  font-size: 0.75rem;
  white-space: nowrap;
}

.agent-session-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.4);
}

.agent-session-status-dot[data-status="idle"] {
  background: rgb(var(--v-theme-success));
}

.agent-session-status-dot[data-status="running"] {
  background: rgb(var(--v-theme-primary));
}

.agent-session-status-dot[data-status="waiting_input"] {
  background: rgb(var(--v-theme-warning));
}

.agent-session-status-dot[data-status="waiting_input"][data-attention="input"] {
  background: rgb(var(--v-theme-info));
}

.agent-session-status-dot[data-status="error"] {
  background: rgb(var(--v-theme-error));
}

.agent-session-header-switch {
  flex: 0 0 auto;
  align-self: center;
  min-width: 0;
  padding-inline: 9px;
  font-size: 0.75rem;
  text-transform: none;
}

.agent-session-header-switch :deep(.v-btn__prepend) {
  margin-inline-end: 4px;
}

.agent-session-header-switch :deep(.v-btn__append) {
  margin-inline-start: 3px;
}

.agent-session-switch-menu {
  padding: 4px;
}

.agent-session-switch-menu :deep(.v-list-item) {
  min-height: 32px;
  padding-inline: 7px;
  border-radius: 7px;
}

.agent-session-switch-menu :deep(.v-list-item__prepend) {
  width: auto;
  margin-inline-end: 7px;
}

.agent-session-switch-provider-icon {
  width: 21px;
  height: 21px;
  display: grid;
  place-items: center;
}

.agent-session-token-usage {
  margin-top: 4px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.72rem;
}

@media (max-width: 1100px) {
  .agent-session-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: start;
    gap: 5px 8px;
    padding-block: 10px;
  }

  .agent-session-header-info {
    grid-column: 2;
  }

  .agent-session-header-status {
    grid-column: 3;
  }

  .agent-session-header-switch {
    grid-column: 4;
    margin-inline-start: 0;
  }

  .agent-session-provider-title {
    flex-wrap: wrap;
  }
}

@media (max-width: 520px) {
  .agent-session-header {
    padding-inline: 10px;
  }

  .agent-session-header-status {
    width: 30px;
    min-width: 30px;
    justify-content: center;
    padding-inline: 0;
  }

  .agent-session-header-status-text {
    display: none;
  }

  .agent-session-header-switch {
    width: 38px;
    min-width: 38px;
    padding-inline: 5px;
  }

  .agent-session-header-switch :deep(.v-btn__content) {
    display: none;
  }

  .agent-session-header-switch :deep(.v-btn__prepend) {
    margin-inline: 0;
  }

  .agent-session-header-switch :deep(.v-btn__append) {
    display: none;
  }
}
</style>
