<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { parseDelimitedTable } from "../utils/csv.js";

const props = defineProps<{
  content: string;
  path: string;
  truncated: boolean;
}>();
const locale = useLocale();
const page = shallowRef(1);
const PAGE_SIZE = 100;
const parsed = computed(() =>
  parseDelimitedTable(props.content, /\.tsv$/i.test(props.path) ? "\t" : ","),
);
const headers = computed(() => parsed.value.rows[0] ?? []);
const data = computed(() => parsed.value.rows.slice(1));
const pageCount = computed(() =>
  Math.max(1, Math.ceil(data.value.length / PAGE_SIZE)),
);
const visibleRows = computed(() =>
  data.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);
watch(
  () => [props.content, props.path],
  () => (page.value = 1),
);
</script>

<template>
  <div class="workspace-csv-preview">
    <div class="workspace-csv-toolbar">
      <span>
        {{
          locale.t(
            "$vuetify.chatroom.files.tableSummary",
            data.length,
            headers.length,
          )
        }}
      </span>
      <div v-if="pageCount > 1" class="workspace-csv-pages">
        <v-btn
          icon="$mdiChevronLeft"
          size="x-small"
          variant="text"
          :disabled="page === 1"
          :aria-label="locale.t('$vuetify.chatroom.files.previousPage')"
          @click="page--"
        />
        <span>{{ page }} / {{ pageCount }}</span>
        <v-btn
          icon="$mdiChevronRight"
          size="x-small"
          variant="text"
          :disabled="page === pageCount"
          :aria-label="locale.t('$vuetify.chatroom.files.nextPage')"
          @click="page++"
        />
      </div>
    </div>
    <v-alert
      v-if="truncated || parsed.truncatedRows || parsed.truncatedColumns"
      type="info"
      density="compact"
      variant="tonal"
    >
      {{ locale.t("$vuetify.chatroom.files.tableLimited") }}
    </v-alert>
    <div class="workspace-csv-scroll">
      <table class="workspace-csv-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th v-for="(header, index) in headers" :key="index" scope="col">
              {{
                header || locale.t("$vuetify.chatroom.files.column", index + 1)
              }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in visibleRows"
            :key="(page - 1) * PAGE_SIZE + index"
          >
            <th scope="row">{{ (page - 1) * PAGE_SIZE + index + 1 }}</th>
            <td
              v-for="(_, column) in headers"
              :key="column"
              :title="row[column] ?? ''"
            >
              {{ row[column] ?? "" }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!headers.length" class="empty-inline">
        {{ locale.t("$vuetify.chatroom.files.emptyTable") }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-csv-preview {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  height: 100%;
  border: 1px solid rgb(var(--v-theme-outline), 0.12);
  border-radius: 10px;
  overflow: hidden;
}
.workspace-csv-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 12px;
  font-size: 12px;
  color: rgb(var(--v-theme-on-surface), 0.6);
}
.workspace-csv-pages {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.workspace-csv-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.workspace-csv-table {
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
  text-align: left;
}
.workspace-csv-table th,
.workspace-csv-table td {
  padding: 8px 12px;
  max-width: 350px;
  border-right: 1px solid rgb(var(--v-theme-outline), 0.07);
  border-bottom: 1px solid rgb(var(--v-theme-outline), 0.1);
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.workspace-csv-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(var(--v-theme-surface));
  font-weight: 600;
}
.workspace-csv-table tbody th {
  color: rgb(var(--v-theme-on-surface), 0.5);
  font-variant-numeric: tabular-nums;
}
@media (max-width: 820px) {
  .workspace-csv-preview {
    height: auto;
  }
  .workspace-csv-scroll {
    max-height: 75dvh;
  }
}
</style>
