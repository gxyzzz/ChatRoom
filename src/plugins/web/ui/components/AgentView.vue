<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { useDisplay, useLocale } from "vuetify";
import {
  api,
  type AgentItem,
  type AgentModel,
  type AgentProviderId,
  type AgentProviderStatus,
  type AgentSession,
  type WorkspaceEntry,
} from "../api.js";
import { appIntlLocale } from "../locales.js";
import {
  agentModelDisplayName,
  agentProviderIcon,
  agentProviderName,
} from "../utils/agent-display.js";
import { errorMessage } from "../utils/errors.js";
import { useAgentHistory } from "../composables/useAgentHistory.js";
import { useAgentInteractions } from "../composables/useAgentInteractions.js";
import { useAgentSessionActions } from "../composables/useAgentSessionActions.js";
import type { AgentRefreshHint } from "../composables/useRuntimeEvents.js";
import AgentComposer from "./AgentComposer.vue";
import AgentDeleteDialog from "./AgentDeleteDialog.vue";
import AgentConversation from "./AgentConversation.vue";
import AgentInteractionCard from "./AgentInteractionCard.vue";
import AgentModelSettingsDialog from "./AgentModelSettingsDialog.vue";
import AgentReviewDialog from "./AgentReviewDialog.vue";
import AgentSessionHeader from "./AgentSessionHeader.vue";
import AgentSidebar from "./AgentSidebar.vue";

const props = defineProps<{
  revision: number;
  changes?: AgentRefreshHint[] | null;
}>();

const locale = useLocale();
const { mdAndDown: compact } = useDisplay();
const layout = useTemplateRef<HTMLElement>("layout");
const providers = shallowRef<AgentProviderStatus[]>([]);
const workspaces = shallowRef<WorkspaceEntry[]>([]);
const providerModels = shallowRef<Record<AgentProviderId, AgentModel[]>>({});
const selectedId = shallowRef<string | null>(null);
const loading = shallowRef(false);
const composerBusy = shallowRef(false);
const error = shallowRef("");
const bulkDeleteDialog = shallowRef(false);
const bulkDeleteIds = shallowRef<string[]>([]);
const bulkDeleting = shallowRef(false);

const {
  sessions,
  history,
  refresh: refreshFromEvent,
  reloadSelected,
  reconcileSession,
  reconcileInteraction,
  removeSession,
  removeSessions,
} = useAgentHistory(selectedId, {
  onError: (cause) => {
    error.value = errorMessage(cause);
  },
});

const selected = computed(
  () => sessions.value.find((item) => item.id === selectedId.value) ?? null,
);
type AgentInteractionItem = Extract<AgentItem, { type: "interaction" }>;
const pendingInteractions = computed<AgentInteractionItem[]>(() => {
  const latestTurn = history.value?.turns.at(-1);
  return (latestTurn?.items ?? []).filter(
    (item): item is AgentInteractionItem =>
      item.type === "interaction" && item.status === "waiting",
  );
});

const {
  modelSettingsOpen,
  settingsModel,
  settingsReasoningEffort,
  settingsReasoningSummary,
  settingsServiceTier,
  settingsApprovalPolicyMode,
  settingsGranularApproval,
  settingsApprovalsReviewer,
  settingsPermissionMode,
  reviewOpen,
  reviewType,
  reviewValue,
  reviewTitle,
  reviewStarting,
  reviewError,
  modelSwitching,
  switchingProvider,
  interrupting,
  deleteDialog,
  deletingSession,
  selectedApprovalPolicySetting,
  selectedApprovalsReviewerSetting,
  selectedPermissionModeSetting,
  selectedProviderModels,
  selectedModelMetadata,
  selectedProviderStatus,
  reviewTypes,
  reviewFieldLabel,
  canStartReview,
  switchTargets,
  loadModels,
  startReview,
  interrupt,
  switchProvider,
  openDeleteDialog,
  deleteSession,
  openModelSettings,
  saveModelSettings,
} = useAgentSessionActions({
  selectedId,
  selected,
  sessions,
  providers,
  providerModels,
  composerBusy,
  error,
  refresh: refreshFromEvent,
  reconcileSession,
  removeSession,
});

const {
  respondingInteractions,
  respondApproval,
  submitInput,
  interactionAnswers,
  setInteractionAnswer,
} = useAgentInteractions({
  selectedId,
  selected,
  error,
  reconcileInteraction,
});

const selectedStatusText = computed(() => {
  if (!selected.value) return "";
  if (selected.value.status !== "waiting_input")
    return locale.t(
      "$vuetify.chatroom.agents.statuses." + selected.value.status,
    );
  if (selected.value.attention?.kind === "approval")
    return locale.t("$vuetify.chatroom.agents.waitingApproval");
  if (selected.value.attention?.kind === "input")
    return locale.t("$vuetify.chatroom.agents.waitingAnswer");
  return locale.t("$vuetify.chatroom.agents.statuses.waiting_input");
});

const sessionUsage = computed(() => {
  const usage = selected.value?.tokenUsage;
  return usage ? usageLabel(usage) : "";
});

const providerNames = computed<Readonly<Record<string, string>>>(() =>
  Object.fromEntries(
    providers.value.map((provider) => [provider.id, provider.displayName]),
  ),
);
const providerIcons = computed<Readonly<Record<string, string | null>>>(() =>
  Object.fromEntries(
    providers.value.map((provider) => [provider.id, provider.icon]),
  ),
);

onMounted(() => {
  void loadInitial();
});

watch(
  () => props.revision,
  () => void refreshFromEvent(props.changes),
);

watch(
  selectedId,
  () => {
    composerBusy.value = false;
  },
  { flush: "sync" },
);

watch(
  selectedId,
  (next, previous) => {
    if (!compact.value || !next || next === previous) return;
    void nextTick(() => {
      layout.value?.querySelector<HTMLElement>(".agent-main")?.focus({
        preventScroll: true,
      });
    });
  },
  { flush: "post" },
);

async function loadInitial() {
  loading.value = true;
  error.value = "";
  try {
    const [nextProviders, , nextWorkspaces] = await Promise.all([
      api<AgentProviderStatus[]>("/agents/providers", { timeoutMs: 15_000 }),
      refreshFromEvent(null),
      api<WorkspaceEntry[]>("/workspaces"),
    ]);
    providers.value = nextProviders;
    workspaces.value = nextWorkspaces;
    if (!compact.value && !selectedId.value && sessions.value[0])
      selectedId.value = sessions.value[0].id;
    await Promise.all(
      nextProviders
        .filter((provider) => provider.installed && provider.authenticated)
        .map((provider) => loadModels(provider.id)),
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

function handleSessionCreated(session: AgentSession) {
  reconcileSession(session);
  selectedId.value = session.id;
}

function openBulkDelete(sessionIds: string[]) {
  bulkDeleteIds.value = [...new Set(sessionIds)];
  bulkDeleteDialog.value = bulkDeleteIds.value.length > 0;
}

async function deleteSelectedSessions() {
  if (bulkDeleting.value || !bulkDeleteIds.value.length) return;
  const ids = [...bulkDeleteIds.value];
  bulkDeleting.value = true;
  error.value = "";
  try {
    await api("/agents/sessions/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ sessionIds: ids }),
    });
    removeSessions(ids);
    bulkDeleteDialog.value = false;
    bulkDeleteIds.value = [];
    await refreshFromEvent(null);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    bulkDeleting.value = false;
  }
}

function usageLabel(usage: NonNullable<AgentSession["tokenUsage"]>): string {
  const format = (value: number) =>
    new Intl.NumberFormat(appIntlLocale(locale.current.value), {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  const total = locale.t(
    "$vuetify.chatroom.agents.tokenUsage",
    format(usage.total.totalTokens),
  );
  const window = usage.modelContextWindow;
  if (!window || window <= 0) return total;
  const context = usage.last.totalTokens;
  return (
    total +
    " · " +
    locale.t(
      "$vuetify.chatroom.agents.contextUsage",
      format(context),
      format(window),
      String(Math.round((context / window) * 100)),
    )
  );
}

function modelDisplayName(
  provider: AgentProviderId,
  modelId: string | null,
): string {
  return agentModelDisplayName(
    providerModels.value,
    provider,
    modelId,
    locale.t("$vuetify.chatroom.agents.defaultModel"),
  );
}

function backToSessions() {
  const sessionId = selectedId.value;
  selectedId.value = null;
  history.value = null;
  if (!compact.value || !sessionId) return;
  void nextTick(() => {
    layout.value
      ?.querySelector<HTMLElement>(
        `[data-agent-session-id="${CSS.escape(sessionId)}"]`,
      )
      ?.focus({ preventScroll: true });
  });
}

function providerName(provider: AgentProviderId): string {
  return agentProviderName(providers.value, provider);
}

function providerIcon(provider: AgentProviderId): string | null {
  return agentProviderIcon(providers.value, provider);
}
</script>

<template>
  <div ref="layout" class="agent-layout">
    <AgentSidebar
      v-if="!compact || !selected"
      v-model:selected-id="selectedId"
      :providers="providers"
      :provider-models="providerModels"
      :workspaces="workspaces"
      :sessions="sessions"
      :loading="loading"
      :error="!selected || compact ? error : ''"
      @created="handleSessionCreated"
      @bulk-delete="openBulkDelete"
    />

    <v-card v-if="selected" class="agent-main panel-card" tabindex="-1">
      <AgentSessionHeader
        :session="selected"
        :provider-name="providerName(selected.provider)"
        :provider-icon="providerIcon(selected.provider)"
        :model-name="modelDisplayName(selected.provider, selected.model)"
        :status-text="selectedStatusText"
        :usage="sessionUsage"
        :compact="compact"
        :switch-targets="switchTargets"
        :switching="switchingProvider"
        :disabled="selected.status !== 'idle' || modelSwitching"
        @back="backToSessions"
        @switch-provider="switchProvider"
      />
      <v-divider />
      <div v-if="error" class="agent-error agent-main-error" role="alert">
        <v-icon icon="$mdiAlertCircleOutline" size="18" />
        <span>{{ error }}</span>
      </div>

      <AgentConversation
        :history="history"
        :provider-names="providerNames"
        :provider-icons="providerIcons"
      />

      <div
        v-if="pendingInteractions.length"
        class="agent-pending-interactions"
        role="region"
        :aria-label="selectedStatusText"
      >
        <AgentInteractionCard
          v-for="item in pendingInteractions"
          :key="'pending:' + item.id"
          :item="item"
          :answers="interactionAnswers(item)"
          :responding="respondingInteractions.has(item.id)"
          pinned
          @approve="respondApproval(item, $event)"
          @submit="submitInput(item)"
          @update-answer="
            (questionId, values) =>
              setInteractionAnswer(item, questionId, values)
          "
        />
      </div>

      <v-divider />
      <AgentComposer
        :key="selected.id"
        :session="selected"
        :model="selectedModelMetadata"
        :steering-supported="Boolean(selectedProviderStatus?.features.steering)"
        :disabled="reviewStarting || modelSwitching || switchingProvider"
        @error="error = $event"
        @busy="composerBusy = $event"
      >
        <template #controls="{ busy }">
          <v-menu
            location="top end"
            offset="8"
            content-class="agent-overlay-menu"
          >
            <template #activator="{ props: controlsMenuProps }">
              <v-btn
                v-bind="controlsMenuProps"
                icon="$mdiDotsHorizontal"
                size="small"
                variant="text"
                class="agent-session-controls-button"
                :color="
                  selected.status === 'error'
                    ? 'error'
                    : selected.status === 'idle'
                      ? undefined
                      : 'warning'
                "
                :aria-label="
                  locale.t('$vuetify.chatroom.agents.sessionControls')
                "
                :title="locale.t('$vuetify.chatroom.agents.sessionControls')"
              />
            </template>
            <v-list class="agent-session-controls-menu" density="compact">
              <v-list-item
                :title="locale.t('$vuetify.chatroom.agents.model')"
                :subtitle="modelDisplayName(selected.provider, selected.model)"
                prepend-icon="$mdiTuneVariant"
                :disabled="
                  selected.status !== 'idle' ||
                  modelSwitching ||
                  switchingProvider
                "
                @click="openModelSettings"
              />
              <v-list-item
                v-if="
                  selected.status === 'running' ||
                  selected.status === 'waiting_input'
                "
                :title="locale.t('$vuetify.chatroom.agents.stop')"
                prepend-icon="$mdiStop"
                base-color="warning"
                :disabled="interrupting"
                @click="interrupt"
              />
              <v-divider />
              <v-list-item
                v-if="
                  selected.status === 'idle' &&
                  selectedProviderStatus?.features.nativeReview
                "
                :title="locale.t('$vuetify.chatroom.agents.review')"
                prepend-icon="$mdiFileCompare"
                :disabled="
                  busy || modelSwitching || switchingProvider || reviewStarting
                "
                @click="
                  reviewError = '';
                  reviewOpen = true;
                "
              />
              <v-list-item
                :title="locale.t('$vuetify.chatroom.agents.refresh')"
                prepend-icon="$mdiRefresh"
                @click="reloadSelected"
              />
              <v-list-item
                :title="locale.t('$vuetify.chatroom.agents.delete')"
                prepend-icon="$mdiDeleteOutline"
                @click="openDeleteDialog"
              />
            </v-list>
          </v-menu>
        </template>
      </AgentComposer>
    </v-card>
    <v-card v-else-if="!compact" class="agent-main panel-card">
      <div class="empty-panel">
        {{ locale.t("$vuetify.chatroom.agents.selectSession") }}
      </div>
    </v-card>

    <AgentModelSettingsDialog
      v-model="modelSettingsOpen"
      v-model:model-id="settingsModel"
      v-model:reasoning-effort="settingsReasoningEffort"
      v-model:reasoning-summary="settingsReasoningSummary"
      v-model:service-tier="settingsServiceTier"
      v-model:approval-mode="settingsApprovalPolicyMode"
      v-model:granular="settingsGranularApproval"
      v-model:reviewer="settingsApprovalsReviewer"
      v-model:permission-mode="settingsPermissionMode"
      :models="selectedProviderModels"
      :approval-setting="selectedApprovalPolicySetting"
      :reviewer-setting="selectedApprovalsReviewerSetting"
      :permission-setting="selectedPermissionModeSetting"
      :busy="modelSwitching"
      @save="saveModelSettings"
    />

    <AgentReviewDialog
      v-model="reviewOpen"
      v-model:review-type="reviewType"
      v-model:review-value="reviewValue"
      v-model:review-title="reviewTitle"
      :types="reviewTypes"
      :field-label="reviewFieldLabel"
      :busy="reviewStarting"
      :error="reviewError"
      :can-start="canStartReview"
      @start="startReview"
    />

    <AgentDeleteDialog
      v-model="deleteDialog"
      :busy="deletingSession"
      @confirm="deleteSession"
    />
    <AgentDeleteDialog
      v-model="bulkDeleteDialog"
      :busy="bulkDeleting"
      :count="bulkDeleteIds.length"
      @confirm="deleteSelectedSessions"
    />
  </div>
</template>

<style scoped>
.agent-layout {
  display: grid;
  grid-template-columns: minmax(0, 0.34fr) minmax(0, 1fr);
  gap: 16px;
  grid-template-rows: minmax(0, 1fr);
  flex: 1 1 0;
  min-block-size: 0;
  min-inline-size: 0;
  color: rgb(var(--v-theme-on-surface));
}

.agent-main {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  color: rgb(var(--v-theme-on-surface));
}

.agent-session-controls-button {
  flex: 0 0 auto;
}

.agent-session-controls-menu {
  max-width: 90vw;
}

.agent-pending-interactions {
  padding-inline: 12px;
  display: flex;
  flex-direction: column;
  min-block-size: min-content;
  gap: 8px;
  flex: 1 1 0;
  overflow: auto;
  overscroll-behavior: contain;
}

@media (max-width: 1100px) {
  .agent-layout {
    grid-template-columns: 1fr;
    min-height: 0;
  }
}

.agent-error {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.agent-main-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  margin: 8px 20px 0;
  padding: 0;
}

.agent-main-error > :deep(.v-icon) {
  flex: 0 0 auto;
  margin-top: 2px;
}

.agent-main-error > span {
  min-width: 0;
  flex: 1 1 auto;
}
</style>
