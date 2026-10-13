<script setup lang="ts">
import { computed } from "vue";
import { useDisplay, useLocale } from "vuetify";
import type { LogLevel } from "../api.js";
import { useSystemLogs } from "../composables/useSystemLogs.js";
import { useMasterDetailFocus } from "../composables/useMasterDetailFocus.js";
import { appIntlLocale } from "../locales.js";
import { clock, dateTime } from "../utils.js";
import CodeViewer from "./CodeViewer.vue";

const KNOWN_MODULES = [
  "app",
  "http",
  "auth",
  "cloud",
  "plugin",
  "mcp",
] as const;

const locale = useLocale();
const { mdAndDown: compact } = useDisplay();
const { focusDetail, focusMaster } = useMasterDetailFocus(compact);
const logs = useSystemLogs();
const {
  records,
  selected,
  level,
  module,
  nextCursor,
  loading,
  loadingMore,
  error,
  limitReached,
  loadInitial,
  loadMore,
} = logs;

const levelItems = computed(() => [
  { title: locale.t("$vuetify.chatroom.systemLogs.allLevels"), value: "all" },
  { title: "INFO", value: "info" },
  { title: "WARN", value: "warn" },
  { title: "ERROR", value: "error" },
  { title: "DEBUG", value: "debug" },
]);
const moduleItems = computed(() => {
  const values = new Set<string>(KNOWN_MODULES);
  for (const record of records.value) values.add(record.module);
  if (module.value !== "all") values.add(module.value);
  return [
    {
      title: locale.t("$vuetify.chatroom.systemLogs.allModules"),
      value: "all",
    },
    ...[...values]
      .sort((left, right) => left.localeCompare(right))
      .map((value) => ({ title: value, value })),
  ];
});
const detailData = computed(() =>
  selected.value?.data ? JSON.stringify(selected.value.data, null, 2) : "",
);

function levelColor(value: LogLevel): string | undefined {
  if (value === "error") return "error";
  if (value === "warn") return "warning";
  if (value === "info") return "primary";
  return undefined;
}

function selectLog(record: (typeof records.value)[number]) {
  logs.select(record);
  focusDetail();
}

function backToLogs() {
  const recordId = selected.value?.id ?? null;
  logs.clearSelection();
  if (recordId) focusMaster(`[data-log-id="${CSS.escape(recordId)}"]`);
}
</script>

<template>
  <div ref="layout" class="master-detail-layout system-logs-layout">
    <div v-if="!compact || !selected" class="master-pane">
      <v-card class="panel-card">
        <div class="panel-header system-logs-header">
          <div>
            <div class="panel-title">
              {{ locale.t("$vuetify.chatroom.systemLogs.title") }}
            </div>
            <div class="panel-subtitle">
              {{ locale.t("$vuetify.chatroom.systemLogs.subtitle") }}
            </div>
          </div>
          <v-btn
            icon="$mdiRefresh"
            size="small"
            variant="text"
            :loading="loading"
            :aria-label="locale.t('$vuetify.chatroom.systemLogs.refresh')"
            @click="loadInitial"
          />
        </div>
        <div class="system-log-controls">
          <v-btn-toggle
            v-model="level"
            mandatory
            variant="text"
            class="record-filters"
          >
            <v-btn
              v-for="item in levelItems"
              :key="item.value"
              :value="item.value"
              size="small"
            >
              {{ item.title }}
            </v-btn>
          </v-btn-toggle>
          <v-select
            v-model="module"
            :items="moduleItems"
            item-title="title"
            item-value="value"
            :aria-label="locale.t('$vuetify.chatroom.systemLogs.module')"
            density="compact"
            variant="outlined"
            hide-details
            class="system-log-module-filter"
          />
        </div>
        <v-divider />
        <div v-if="error" class="panel-error" role="alert">
          <v-icon icon="$mdiAlertCircleOutline" size="18" />
          <span>{{ error }}</span>
        </div>

        <div v-if="records.length" class="system-log-list">
          <div class="system-log-header" aria-hidden="true">
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.time") }}</span>
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.level") }}</span>
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.module") }}</span>
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.message") }}</span>
          </div>
          <button
            v-for="record in records"
            :key="record.id"
            type="button"
            class="system-log-row"
            :class="{ 'selected-row': selected?.id === record.id }"
            :aria-current="selected?.id === record.id ? 'true' : undefined"
            :data-log-id="record.id"
            @click="selectLog(record)"
          >
            <span class="system-log-time mono" :title="record.timestamp">
              {{ clock(record.timestamp) }}
            </span>
            <span class="system-log-level">
              <v-chip
                size="x-small"
                variant="tonal"
                :color="levelColor(record.level)"
              >
                {{ record.level.toUpperCase() }}
              </v-chip>
            </span>
            <span class="system-log-module mono">
              {{ record.module }}
            </span>
            <span class="system-log-message">
              <strong>{{ record.message }}</strong>
              <small class="mono">{{ record.event }}</small>
            </span>
          </button>
        </div>
        <div v-else-if="!loading" class="empty-inline">
          {{ locale.t("$vuetify.chatroom.systemLogs.empty") }}
        </div>
        <v-alert
          v-if="limitReached"
          type="info"
          variant="tonal"
          density="compact"
          class="system-log-window-limit"
        >
          {{ locale.t("$vuetify.chatroom.systemLogs.windowLimit") }}
        </v-alert>
        <div v-if="nextCursor" class="system-log-load-more">
          <v-btn
            variant="text"
            size="small"
            :loading="loadingMore"
            @click="loadMore"
          >
            {{ locale.t("$vuetify.chatroom.systemLogs.loadMore") }}
          </v-btn>
        </div>
      </v-card>
    </div>

    <div
      v-if="!compact || selected"
      ref="detailPane"
      class="detail-pane"
      tabindex="-1"
    >
      <v-card v-if="selected" class="panel-card">
        <div class="panel-header compact-header">
          <v-btn
            v-if="compact"
            icon="$mdiArrowLeft"
            size="small"
            variant="text"
            :aria-label="locale.t('$vuetify.chatroom.systemLogs.back')"
            @click="backToLogs"
          />
          <div class="min-w-0 detail-header-title">
            <div class="panel-title text-truncate">{{ selected.message }}</div>
            <div class="panel-subtitle mono text-truncate">
              {{ selected.event }}
            </div>
          </div>
        </div>
        <v-divider />
        <div class="detail-facts system-log-facts">
          <div>
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.time") }}</span>
            <strong>{{
              dateTime(selected.timestamp, appIntlLocale(locale.current.value))
            }}</strong>
          </div>
          <div>
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.level") }}</span>
            <strong>{{ selected.level.toUpperCase() }}</strong>
          </div>
          <div>
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.module") }}</span>
            <strong>{{ selected.module }}</strong>
          </div>
          <div>
            <span>{{ locale.t("$vuetify.chatroom.systemLogs.event") }}</span>
            <strong>{{ selected.event }}</strong>
          </div>
        </div>
        <template v-if="detailData">
          <v-divider />
          <div class="system-log-detail-data">
            <div class="detail-section-label">
              {{ locale.t("$vuetify.chatroom.systemLogs.data") }}
            </div>
            <CodeViewer
              :text="detailData"
              filename="log.json"
              language="json"
              :toolbar="false"
            />
          </div>
        </template>
      </v-card>
      <v-card v-else class="panel-card">
        <div class="empty-panel">
          {{ locale.t("$vuetify.chatroom.systemLogs.select") }}
        </div>
      </v-card>
    </div>
  </div>
</template>
<style>
.system-logs-layout {
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 0.85fr);
}

.system-log-controls {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
}

.system-log-controls .record-filters {
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.system-log-controls .record-filters::-webkit-scrollbar {
  display: none;
}

.system-log-module-filter {
  min-width: 0;
  max-width: 45%;
  flex: 1 1 auto;
}

.system-log-list {
  container-type: inline-size;
}

.system-log-header,
.system-log-row {
  display: grid;
  grid-template-columns:
    minmax(0, 0.7fr)
    minmax(0, 0.5fr)
    minmax(0, 0.65fr)
    minmax(0, 3.15fr);
  column-gap: 12px;
  align-items: center;
}

.system-log-header {
  padding: 6px 12px;
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.08);
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface), 0.46);
  font-size: 11px;
  font-weight: 600;
}

.system-log-header > span:nth-child(2),
.system-log-header > span:nth-child(3) {
  justify-self: center;
  text-align: center;
}

.system-log-row {
  width: 100%;
  content-visibility: auto;
  contain-intrinsic-size: 40px;
  min-width: 0;
  padding: 5px 12px;
  border: 0;
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.08);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.system-log-row:hover,
.system-log-row.selected-row {
  background: rgb(var(--v-theme-primary), 0.045);
}

.system-log-time,
.system-log-module {
  color: rgb(var(--v-theme-on-surface), 0.56);
  font-size: 11px;
  white-space: nowrap;
}

.system-log-module {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.system-log-level,
.system-log-module {
  width: 100%;
  justify-self: stretch;
  text-align: center;
}

.system-log-message {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.system-log-message strong,
.system-log-message small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-log-message strong {
  font-size: 12px;
  font-weight: 600;
}

.system-log-message small {
  color: rgb(var(--v-theme-on-surface), 0.48);
  font-size: 10.5px;
}

.system-log-load-more {
  display: flex;
  justify-content: center;
  padding: 8px 12px;
}

.system-log-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.system-log-facts strong {
  overflow-wrap: anywhere;
}

.system-log-detail-data {
  padding: 12px 18px 18px;
}
@container (max-width: 620px) {
  .system-log-header {
    display: none;
  }

  .system-log-row {
    grid-template-columns: max-content max-content minmax(0, 1fr);
    grid-template-areas:
      "time level module"
      "message message message";
    gap: 4px 8px;
  }

  .system-log-time {
    grid-area: time;
  }

  .system-log-level {
    grid-area: level;
  }

  .system-log-module {
    grid-area: module;
    min-width: 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
  }

  .system-log-message {
    grid-area: message;
  }
}

@media (max-width: 1100px) {
  .system-logs-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .system-logs-layout .detail-pane {
    position: static;
  }
}
</style>
