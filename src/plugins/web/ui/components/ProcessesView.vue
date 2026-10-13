<script setup lang="ts">
import { useDisplay } from "vuetify";
import type { ProcessRefreshHint } from "../composables/useRuntimeEvents.js";
import { useProcesses } from "../composables/useProcesses.js";
import { useMasterDetailFocus } from "../composables/useMasterDetailFocus.js";
import ProcessDetail from "./ProcessDetail.vue";
import ProcessList from "./ProcessList.vue";

const props = defineProps<{
  revision: number;
  changes: ProcessRefreshHint[] | null;
}>();

const { mdAndDown: compact } = useDisplay();
const { focusDetail, focusMaster } = useMasterDetailFocus(compact);
const processes = useProcesses(
  () => props.revision,
  () => props.changes,
);
const { items, selected, detail, error, processOutput } = processes;

function selectProcess(processId: string) {
  processes.select(processId);
  focusDetail();
}

function backToProcesses() {
  const processId = selected.value;
  processes.clearSelection();
  if (processId) focusMaster(`[data-process-id="${CSS.escape(processId)}"]`);
}

function stop(processId: string, force: boolean) {
  void processes.stop(processId, force);
}
</script>

<template>
  <div ref="layout" class="master-detail-layout processes-layout">
    <div v-if="!compact || !selected" class="master-pane">
      <ProcessList
        :items="items"
        :selected="selected"
        :error="error"
        @select="selectProcess"
        @stop="stop"
      />
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
      <ProcessDetail
        :detail="detail"
        :output="processOutput"
        :compact="compact"
        @back="backToProcesses"
        @stop="stop"
      />
    </div>
  </div>
</template>

<style>
.process-record-list {
  display: grid;
  grid-template-columns:
    fit-content(25%)
    minmax(0, 1fr)
    max-content
    max-content
    max-content;
  column-gap: 12px;
  align-content: start;
  grid-auto-rows: max-content;
  container-type: inline-size;
}

.process-record-header,
.process-record-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  column-gap: inherit;
  align-items: center;
}

.process-record-header {
  min-height: 32px;
  padding: 6px 14px;
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.08);
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface), 0.46);
  font-size: 11px;
  font-weight: 600;
}

.process-record-header > span {
  justify-self: start;
  text-align: left;
}

.process-record-header > :nth-child(n + 3) {
  justify-self: center;
  text-align: center;
}

.process-record-row {
  width: 100%;
  min-width: 0;
  padding: 9px 14px;
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.08);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.process-record-row:last-child {
  border-bottom: 0;
}

.process-record-row:hover,
.process-record-row.selected-row {
  background: rgb(var(--v-theme-primary), 0.045);
}

.process-record-main,
.process-record-meta {
  display: contents;
}

.process-record-command,
.process-record-args,
.process-record-started,
.process-record-duration {
  min-width: 0;
}

.process-record-command,
.process-record-args {
  justify-self: stretch;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.process-record-command {
  font-size: 12px;
  font-weight: 650;
}

.process-record-args {
  color: rgb(var(--v-theme-on-surface), 0.5);
  font-size: 11px;
}

.process-record-started,
.process-record-duration {
  justify-self: center;
  color: rgb(var(--v-theme-on-surface), 0.52);
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.process-record-side {
  display: flex;
  width: 100%;
  min-width: 0;
  justify-self: stretch;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.process-record-side .process-actions {
  gap: 2px;
}
@container (min-width: 761px) {
  .process-record-command,
  .process-record-header > :first-child {
    padding-inline-end: 4px;
  }

  .process-record-duration {
    padding-inline: 12px;
  }
}
@container (max-width: 520px) {
  .process-record-header {
    display: none;
  }

  .process-record-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "main side"
      "meta side";
    min-height: 66px;
    gap: 4px 12px;
    padding: 9px 12px;
  }

  .process-record-main {
    grid-area: main;
    display: flex;
    min-width: 0;
    align-items: baseline;
    justify-content: start;
    gap: 8px;
  }

  .process-record-command {
    flex: 0 1 auto;
    max-inline-size: 45%;
  }
  .process-record-args {
    flex: 1 1 0;
  }

  .process-record-meta {
    grid-area: meta;
    display: grid;
    grid-template-columns: max-content max-content;
    min-width: 0;
    align-items: center;
    justify-content: start;
    gap: 10px;
  }

  .process-record-side {
    grid-area: side;
    min-width: max-content;
    justify-self: center;
    align-self: center;
    justify-content: center;
    text-align: center;
  }
}
@container (max-width: 420px) {
  .process-record-row {
    grid-template-columns: minmax(0, 1fr) max-content;
    gap: 3px 8px;
    padding: 8px 9px;
  }

  .process-record-main {
    gap: 6px;
  }

  .process-record-args {
    font-size: 10.5px;
  }

  .process-record-meta {
    grid-template-columns: max-content max-content;
    gap: 6px;
  }

  .process-record-started,
  .process-record-duration {
    font-size: 11px;
  }
}

.process-output {
  padding: 12px;
}

.process-actions,
.process-detail-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.process-detail-actions .detail-action-btn.v-btn {
  --v-btn-size: 0.75rem;
  min-width: 0;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 0.75rem;
  letter-spacing: 0;
}

.process-detail-actions .detail-action-btn .v-btn__content {
  font-size: inherit;
}

.process-detail-actions .detail-action-btn .v-btn__prepend {
  margin-inline-start: -5px;
  margin-inline-end: 5px;
}

.process-detail-actions .detail-action-btn .v-icon {
  font-size: 10.3px;
}

.process-detail-header {
  flex-wrap: wrap;
}

.process-full-command {
  padding: 12px 18px;
}

.processes-layout {
  grid-template-columns: minmax(0, 1.75fr) minmax(0, 0.8fr);
}
@media (min-width: 1101px) {
  .processes-layout {
    flex: 1 1 0;
    min-inline-size: 0;
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    align-items: stretch;
    overflow: hidden;
  }

  .processes-layout .master-pane,
  .processes-layout .detail-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .processes-layout .detail-pane {
    position: static;
  }

  .processes-layout .master-pane > .panel-card,
  .processes-layout .detail-pane > .panel-card {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .processes-layout .process-record-list {
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .processes-layout .process-record-header {
    position: sticky;
    z-index: 1;
    top: 0;
  }

  .process-detail-card {
    display: flex;
    flex-direction: column;
  }

  .process-detail-card .process-output {
    display: flex;
    min-height: 0;
    flex: 1 1 0;
    overflow: hidden;
  }

  .process-detail-card .process-output > .code-viewer {
    display: flex;
    width: 100%;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }

  .process-detail-card .process-output .code-block {
    min-height: 0;
    max-height: none;
    flex: 1 1 auto;
  }

  .process-detail-card .process-full-command {
    display: flex;
    min-height: 0;
    max-height: 30%;
    flex: 0 1 auto;
    flex-direction: column;
    overflow: hidden;
  }

  .process-detail-card .process-full-command .code-viewer {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
  }

  .process-detail-card .process-full-command .code-block {
    min-height: 0;
    max-height: none;
    flex: 1 1 auto;
    overflow: auto;
  }

  .process-detail-card .detail-facts,
  .process-detail-card .process-detail-header {
    flex: 0 0 auto;
  }

  .processes-layout .empty-panel {
    flex: 1;
  }
}

@media (max-width: 1280px) {
  .processes-layout {
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 0.8fr);
  }
}
@media (max-width: 1100px) {
  .processes-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .processes-layout .process-detail-header {
    gap: 6px;
  }

  .processes-layout .process-output {
    padding: 10px;
  }

  .processes-layout .process-full-command,
  .processes-layout .detail-facts {
    font-size: 0.92rem;
  }

  .process-detail-actions {
    width: 100%;
    justify-content: flex-start;
  }
}

@media (max-width: 1100px) {
  .processes-layout .detail-pane {
    position: static;
  }
}
</style>
