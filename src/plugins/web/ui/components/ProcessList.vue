<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue";
import { useLocale } from "vuetify";
import type { ProcessSummary } from "../api.js";
import { appIntlLocale } from "../locales.js";
import { dateTime, duration } from "../utils.js";
import StateChip from "./StateChip.vue";

defineProps<{
  items: ProcessSummary[];
  selected: string | null;
  error: string;
}>();

defineEmits<{
  select: [processId: string];
  stop: [processId: string, force: boolean];
}>();

const locale = useLocale();
const now = shallowRef(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
});
function elapsed(item: ProcessSummary): number {
  return item.state === "running"
    ? Math.max(0, now.value - Date.parse(item.startedAt))
    : item.durationMs;
}
</script>

<template>
  <v-card class="panel-card">
    <div class="panel-header">
      <div>
        <div class="panel-title">
          {{ locale.t("$vuetify.chatroom.processes.title") }}
        </div>
        <div class="panel-subtitle">
          {{ locale.t("$vuetify.chatroom.processes.subtitle") }}
        </div>
      </div>
    </div>
    <v-divider />

    <div v-if="error" class="panel-error" role="alert">
      <v-icon icon="$mdiAlertCircleOutline" size="18" />
      <span>{{ error }}</span>
    </div>

    <div v-if="items.length" class="process-record-list" role="grid">
      <div class="process-record-header" role="row">
        <span role="columnheader">{{
          locale.t("$vuetify.chatroom.processes.command")
        }}</span>
        <span role="columnheader">{{
          locale.t("$vuetify.chatroom.processes.arguments")
        }}</span>
        <span role="columnheader">{{
          locale.t("$vuetify.chatroom.processes.started")
        }}</span>
        <span class="process-record-duration" role="columnheader">{{
          locale.t("$vuetify.chatroom.processes.duration")
        }}</span>
        <span role="columnheader">{{
          locale.t("$vuetify.chatroom.processes.state")
        }}</span>
      </div>

      <div
        v-for="item in items"
        :key="item.processId"
        role="row"
        tabindex="0"
        class="process-record-row"
        :class="{ 'selected-row': selected === item.processId }"
        :aria-selected="selected === item.processId"
        :data-process-id="item.processId"
        @click="$emit('select', item.processId)"
        @keydown.enter.self="$emit('select', item.processId)"
        @keydown.space.self.prevent="$emit('select', item.processId)"
      >
        <div class="process-record-main">
          <div
            class="process-record-command mono"
            role="gridcell"
            :title="item.command"
          >
            {{ item.command }}
          </div>
          <div
            class="process-record-args mono"
            role="gridcell"
            :class="{ muted: !item.args.length }"
            :title="item.args.join(' ')"
          >
            {{ item.args.length ? item.args.join(" ") : "—" }}
          </div>
        </div>
        <div class="process-record-meta">
          <div class="process-record-started" role="gridcell">
            {{ dateTime(item.startedAt, appIntlLocale(locale.current.value)) }}
          </div>
          <div class="process-record-duration" role="gridcell">
            {{ duration(elapsed(item)) }}
          </div>
        </div>
        <div class="process-record-side" role="gridcell">
          <StateChip v-if="item.state !== 'running'" :value="item.state" />
          <div v-else class="process-actions" @click.stop>
            <v-btn
              size="x-small"
              variant="text"
              class="table-action-btn"
              :aria-label="locale.t('$vuetify.chatroom.processes.terminate')"
              @click="$emit('stop', item.processId, false)"
            >
              <v-progress-circular
                indeterminate
                color="warning"
                :size="22"
                :width="2"
              >
                <v-icon icon="$mdiStop" size="12" />
              </v-progress-circular>
            </v-btn>
            <v-menu>
              <template #activator="{ props: menuProps }">
                <v-btn
                  v-bind="menuProps"
                  icon="$mdiDotsHorizontal"
                  size="x-small"
                  variant="text"
                  class="table-action-btn"
                  :aria-label="
                    locale.t('$vuetify.chatroom.processes.moreActions')
                  "
                />
              </template>
              <v-list density="compact">
                <v-list-item
                  :title="locale.t('$vuetify.chatroom.processes.kill')"
                  prepend-icon="$mdiCloseOctagonOutline"
                  @click="$emit('stop', item.processId, true)"
                />
              </v-list>
            </v-menu>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="empty-inline">
      {{ locale.t("$vuetify.chatroom.processes.empty") }}
    </div>
  </v-card>
</template>
