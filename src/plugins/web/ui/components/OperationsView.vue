<script setup lang="ts">
import {
  nextTick,
  onBeforeUnmount,
  useTemplateRef,
  watch,
  shallowRef,
} from "vue";
import { useDisplay, useLocale } from "vuetify";
import type { Operation } from "../api.js";
import { useOperations } from "../composables/useOperations.js";
import { useMasterDetailFocus } from "../composables/useMasterDetailFocus.js";
import type { OperationRefreshBatch } from "../composables/useRuntimeEvents.js";
import OperationDetail from "./OperationDetail.vue";
import OperationTable from "./OperationTable.vue";

const props = defineProps<{
  revision: number;
  changes: OperationRefreshBatch | null;
}>();
const locale = useLocale();
const { mdAndDown: compact } = useDisplay();
const loadSentinel = useTemplateRef<HTMLElement>("loadSentinel");
const listScroller = useTemplateRef<HTMLElement>("listScroller");
const clearDialog = shallowRef(false);
const { focusDetail, focusMaster } = useMasterDetailFocus(compact);
const operations = useOperations(
  () => props.revision,
  () => props.changes,
);
const {
  events,
  selected,
  detail,
  filter,
  loadingMore,
  hasMore,
  clearing,
  error,
  limitReached,
} = operations;

let loadObserver: IntersectionObserver | null = null;

watch(
  loadSentinel,
  (element) => {
    loadObserver?.disconnect();
    loadObserver = null;
    if (!element) return;
    loadObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void operations.loadMore();
      },
      { rootMargin: "240px 0px" },
    );
    loadObserver.observe(element);
  },
  { flush: "post" },
);

watch(
  () => [events.value.length, hasMore.value, loadingMore.value] as const,
  () => void continueLoadingIfVisible(),
  { flush: "post" },
);

onBeforeUnmount(() => loadObserver?.disconnect());

async function continueLoadingIfVisible() {
  await nextTick();
  const element = loadSentinel.value;
  if (!element || loadingMore.value || !hasMore.value) return;
  const scrollBottom =
    listScroller.value?.getBoundingClientRect().bottom ?? window.innerHeight;
  if (
    element.getBoundingClientRect().top <=
    Math.min(scrollBottom, window.innerHeight) + 240
  )
    void operations.loadMore();
}

function select(event: Operation) {
  operations.select(event);
  focusDetail();
}

function backToOperations() {
  const operationId = selected.value;
  operations.clearSelection();
  if (operationId)
    focusMaster(`[data-operation-id="${CSS.escape(operationId)}"]`);
}

async function clearHistory() {
  if (await operations.clearHistory()) clearDialog.value = false;
}
</script>

<template>
  <div ref="layout" class="master-detail-layout operations-layout">
    <div v-if="!compact || !selected" class="master-pane">
      <v-card class="panel-card">
        <div class="panel-header operations-header">
          <div>
            <div class="panel-title">
              {{ locale.t("$vuetify.chatroom.operations.title") }}
            </div>
            <div class="panel-subtitle">
              {{ locale.t("$vuetify.chatroom.operations.subtitle") }}
            </div>
          </div>
          <div class="operations-controls">
            <v-btn-toggle
              v-model="filter"
              mandatory
              variant="text"
              class="record-filters"
            >
              <v-btn value="all" size="small">{{
                locale.t("$vuetify.chatroom.operations.all")
              }}</v-btn>
              <v-btn value="running" size="small">{{
                locale.t("$vuetify.chatroom.operations.running")
              }}</v-btn>
              <v-btn value="error" size="small">{{
                locale.t("$vuetify.chatroom.operations.errors")
              }}</v-btn>
              <v-btn value="success" size="small">{{
                locale.t("$vuetify.chatroom.operations.success")
              }}</v-btn>
            </v-btn-toggle>
            <v-btn
              prepend-icon="$mdiDeleteSweepOutline"
              variant="text"
              size="small"
              class="operations-clear"
              :disabled="!events.length"
              @click="clearDialog = true"
            >
              {{ locale.t("$vuetify.chatroom.operations.clear") }}
            </v-btn>
          </div>
        </div>
        <v-divider />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">
          {{ error }}
        </v-alert>
        <div ref="listScroller" class="operation-scroll-area">
          <OperationTable
            :events="events"
            :selected="selected"
            @select="select"
          />
          <v-alert
            v-if="limitReached"
            type="info"
            variant="tonal"
            density="compact"
            class="operation-window-limit"
          >
            {{ locale.t("$vuetify.chatroom.operations.windowLimit") }}
          </v-alert>
          <div
            v-if="hasMore || loadingMore"
            ref="loadSentinel"
            class="operation-load-sentinel"
            aria-hidden="true"
          >
            <v-progress-circular
              v-if="loadingMore"
              indeterminate
              size="20"
              width="2"
            />
          </div>
        </div>
      </v-card>
    </div>
    <div
      v-if="!compact || selected"
      ref="detailPane"
      class="detail-pane"
      tabindex="-1"
    >
      <v-alert
        v-if="compact && selected && error"
        type="error"
        variant="tonal"
        density="compact"
      >
        {{ error }}
      </v-alert>
      <OperationDetail
        :event="detail"
        :show-back="compact"
        @back="backToOperations"
      />
    </div>
  </div>

  <v-dialog v-model="clearDialog" width="auto" max-width="32rem">
    <v-card>
      <v-card-item prepend-icon="$mdiAlertCircleOutline" class="text-error">
        <v-card-title>{{
          locale.t("$vuetify.chatroom.operations.clearTitle")
        }}</v-card-title>
      </v-card-item>
      <v-card-text>{{
        locale.t("$vuetify.chatroom.operations.clearDescription")
      }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="clearDialog = false">
          {{ locale.t("$vuetify.chatroom.common.cancel") }}
        </v-btn>
        <v-btn
          color="error"
          variant="flat"
          :loading="clearing"
          @click="clearHistory"
        >
          {{ locale.t("$vuetify.chatroom.operations.clearConfirm") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
<style>
.operations-header {
  align-items: stretch;
  flex-direction: column;
  gap: 10px;
}

.operations-controls {
  display: flex;
  width: 100%;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.operations-clear {
  flex: 0 0 auto;
}

.operations-clear.v-btn--disabled {
  opacity: 0.46;
}

.responsive-record-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content max-content;
  container-type: inline-size;
}

.operation-load-sentinel {
  display: grid;
  min-height: 42px;
  place-items: center;
  border-top: 1px solid rgb(var(--v-theme-outline), 0.06);
  color: rgb(var(--v-theme-on-surface), 0.48);
}

.responsive-record-row {
  display: grid;
  content-visibility: auto;
  contain-intrinsic-size: 48px;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  grid-template-areas: "main meta side";
  width: 100%;
  min-width: 0;
  min-height: 48px;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  border: 0;
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.08);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.responsive-record-row:last-child {
  border-bottom: 0;
}

.responsive-record-row:hover,
.responsive-record-row.selected-row {
  background: rgb(var(--v-theme-primary), 0.045);
}

.responsive-record-main {
  grid-area: main;
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.responsive-record-title,
.responsive-record-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.responsive-record-title {
  flex: 0 0 auto;
  max-width: 42%;
  font-weight: 650;
}

.responsive-record-subtitle {
  flex: 1 1 auto;
  min-width: 0;
  margin-top: 0;
  color: rgb(var(--v-theme-on-surface), 0.52);
  font-size: 12px;
}

.responsive-record-meta {
  grid-area: meta;
  display: flex;
  min-width: 0;
  flex-wrap: nowrap;
  gap: 8px;
  color: rgb(var(--v-theme-on-surface), 0.52);
  font-size: 12px;
  white-space: nowrap;
}

.responsive-record-side {
  grid-area: side;
  display: flex;
  width: 100%;
  min-width: 0;
  justify-self: stretch;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
@container (max-width: 980px) {
  .responsive-record-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .responsive-record-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "main side"
      "meta side";
    min-height: 0;
    gap: 4px 8px;
    padding: 8px 10px;
  }

  .responsive-record-meta {
    overflow: hidden;
  }
}
@container (max-width: 620px) {
  .responsive-record-row {
    gap: 3px 6px;
    padding: 7px 9px;
  }

  .responsive-record-title {
    max-width: 36%;
  }

  .responsive-record-meta {
    gap: 6px;
    font-size: 11px;
  }
}

.operations-layout {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (max-width: 640px) {
  .operations-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .operations-clear.v-btn {
    min-height: 34px;
    padding-inline: 8px;
  }
}
@media (max-width: 430px) {
  .operations-controls {
    gap: 5px;
  }

  .operations-clear.v-btn {
    min-height: 32px;
    padding-inline: 6px;
    font-size: 11px;
  }
}

@media (max-width: 1100px) {
  .operations-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.detail-tabs {
  padding: 0 10px;
}

.detail-tabs .v-slide-group__container {
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scrollbar-width: none;
  touch-action: pan-x pan-y;
}

.detail-tabs .v-slide-group__container::-webkit-scrollbar {
  display: none;
}

.detail-tabs .v-tab {
  min-width: 0;
  padding-inline: 12px;
}

@media (max-width: 1100px) {
  .operations-layout .detail-pane {
    position: static;
  }
}

@media (max-width: 640px) {
  .detail-tabs {
    padding-inline: 4px;
  }

  .detail-tabs .v-tab {
    padding-inline: 10px;
  }
}
</style>
