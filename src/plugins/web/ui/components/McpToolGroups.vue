<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { api, type McpToolSummary } from "../api.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";

const props = defineProps<{ scope: "chatroom" | "agent" }>();
const locale = useLocale();
const tools = shallowRef<McpToolSummary[]>([]);
const loading = shallowRef(false);
const error = shallowRef("");
const query = shallowRef("");
const status = shallowRef("all");
const busy = reactive(new Set<string>());
const requests = createRequestGate();
const expanded = shallowRef<number | null>(props.scope === "agent" ? 0 : null);

const eligibleTools = computed(() =>
  tools.value.filter(
    (tool) =>
      tool.pluginId !== "custom-mcp" &&
      (props.scope !== "agent" || tool.agentAllowed !== false),
  ),
);
const groups = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  const byPlugin = new Map<string, McpToolSummary[]>();
  for (const tool of eligibleTools.value) {
    const matchesSearch =
      !search ||
      [toolTitle(tool), tool.name, toolDescription(tool), tool.pluginId]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search);
    const matchesStatus =
      status.value === "all" ||
      (status.value === "enabled" ? tool.enabled : !tool.enabled);
    if (!matchesSearch || !matchesStatus) continue;
    const list = byPlugin.get(tool.pluginId) ?? [];
    list.push(tool);
    byPlugin.set(tool.pluginId, list);
  }
  return [...byPlugin.entries()].map(([pluginId, visibleTools]) => ({
    pluginId,
    visibleTools,
    tools: eligibleTools.value.filter((tool) => tool.pluginId === pluginId),
  }));
});
const enabledCount = computed(
  () => eligibleTools.value.filter((tool) => tool.enabled).length,
);

// Balance groups by estimated rendered height. A masonry-style grid avoids
// reserving the height of a large group beside much shorter groups.
const groupColumns = computed(() => {
  const columns: Array<(typeof groups.value)[number][]> = [[], []];
  const heights = [0, 0];
  for (const group of groups.value) {
    const index = heights[0]! <= heights[1]! ? 0 : 1;
    columns[index]!.push(group);
    heights[index] = heights[index]! + 48 + group.visibleTools.length * 42;
  }
  return columns;
});

const localizedTools = new Set([
  "workspace_list",
  "workspace_info",
  "workspace_file_get",
  "process_start",
  "process_read",
  "process_write",
  "process_kill",
  "computer_snapshot",
  "computer_action",
  "agent_providers",
  "agent_provider_details",
  "agent_models",
  "agent_sessions",
  "agent_create",
  "agent_send",
  "agent_steer",
  "agent_review",
  "agent_history",
  "agent_configure",
  "agent_respond",
  "agent_interrupt",
  "agent_switch_provider",
]);

onMounted(() => void load());

async function load() {
  if (busy.size) return;
  const request = requests.begin();
  loading.value = true;
  error.value = "";
  try {
    const path = props.scope === "agent" ? "/agent-mcp/tools" : "/mcp/tools";
    const result = await api<McpToolSummary[]>(path, {
      signal: request.signal,
    });
    if (requests.isCurrent(request)) tools.value = result;
  } catch (cause) {
    if (requests.isCurrent(request)) error.value = errorMessage(cause);
  } finally {
    if (requests.isCurrent(request)) loading.value = false;
  }
}

async function setEnabled(tool: McpToolSummary, enabled: boolean) {
  if (busy.has(tool.name) || tool.enabled === enabled) return;
  requests.invalidate();
  loading.value = false;
  busy.add(tool.name);
  error.value = "";
  try {
    const prefix =
      props.scope === "agent" ? "/agent-mcp/tools/" : "/mcp/tools/";
    const updated = await api<McpToolSummary>(
      prefix + encodeURIComponent(tool.name),
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    );
    tools.value = tools.value.map((item) =>
      item.name === updated.name ? updated : item,
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.delete(tool.name);
  }
}

async function setGroupEnabled(
  group: { tools: McpToolSummary[] },
  enabled: boolean,
) {
  const pending = group.tools.filter(
    (tool) => tool.enabled !== enabled && !busy.has(tool.name),
  );
  await Promise.all(pending.map((tool) => setEnabled(tool, enabled)));
}

function pluginLabel(pluginId: string): string {
  const known = ["workspace", "process", "computer", "agent"];
  return known.includes(pluginId)
    ? locale.t("$vuetify.chatroom.mcpTools.plugins." + pluginId)
    : pluginId;
}

function toolTitle(tool: McpToolSummary): string {
  return localizedTools.has(tool.name)
    ? locale.t("$vuetify.chatroom.mcpTools.tools." + tool.name + ".title")
    : tool.title;
}

function toolDescription(tool: McpToolSummary): string {
  return localizedTools.has(tool.name)
    ? locale.t("$vuetify.chatroom.mcpTools.tools." + tool.name + ".description")
    : tool.description;
}

function someEnabled(group: { tools: McpToolSummary[] }): boolean {
  return group.tools.some((tool) => tool.enabled);
}

function allEnabled(group: { tools: McpToolSummary[] }): boolean {
  return group.tools.length > 0 && group.tools.every((tool) => tool.enabled);
}
</script>

<template>
  <div class="mcp-built-in">
    <v-alert v-if="error" type="error" variant="tonal" density="compact">
      {{ error }}
    </v-alert>

    <v-expansion-panels v-model="expanded" class="mcp-built-in-panel">
      <v-expansion-panel>
        <v-expansion-panel-title>
          <div class="mcp-built-in-heading">
            <span>{{
              locale.t(
                props.scope === "agent"
                  ? "$vuetify.chatroom.agentMcp.builtIn"
                  : "$vuetify.chatroom.mcpTools.builtInSection",
              )
            }}</span>
            <v-chip size="x-small" variant="tonal"
              >{{ enabledCount }}/{{ eligibleTools.length }}</v-chip
            >
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div class="mcp-built-in-content">
            <div class="mcp-built-in-controls">
              <v-text-field
                v-model="query"
                density="compact"
                variant="solo-filled"
                flat
                hide-details
                clearable
                prepend-inner-icon="$mdiMagnify"
                :placeholder="
                  locale.t('$vuetify.chatroom.agentMcp.searchTools')
                "
                :aria-label="locale.t('$vuetify.chatroom.agentMcp.searchTools')"
              />
              <div
                class="mcp-built-in-status-buttons"
                role="group"
                :aria-label="locale.t('$vuetify.chatroom.agentMcp.all')"
              >
                <v-btn
                  size="small"
                  variant="tonal"
                  :color="status === 'all' ? 'primary' : 'default'"
                  :aria-pressed="status === 'all'"
                  @click="status = 'all'"
                  >{{ locale.t("$vuetify.chatroom.agentMcp.all") }}</v-btn
                >
                <v-btn
                  size="small"
                  variant="tonal"
                  :color="status === 'enabled' ? 'primary' : 'default'"
                  :aria-pressed="status === 'enabled'"
                  @click="status = 'enabled'"
                  >{{ locale.t("$vuetify.chatroom.agentMcp.enabled") }}</v-btn
                >
                <v-btn
                  size="small"
                  variant="tonal"
                  :color="status === 'disabled' ? 'primary' : 'default'"
                  :aria-pressed="status === 'disabled'"
                  @click="status = 'disabled'"
                  >{{ locale.t("$vuetify.chatroom.agentMcp.disabled") }}</v-btn
                >
              </div>
            </div>

            <v-progress-linear v-if="loading" indeterminate rounded />

            <div v-if="groups.length" class="mcp-built-in-columns">
              <div
                v-for="(column, columnIndex) in groupColumns"
                :key="columnIndex"
                class="mcp-built-in-column"
              >
                <v-card
                  v-for="group in column"
                  :key="group.pluginId"
                  class="mcp-built-in-group"
                >
                  <div class="mcp-built-in-group-header">
                    <div class="mcp-built-in-group-name">
                      <span>{{ pluginLabel(group.pluginId) }}</span>
                      <v-chip size="x-small" variant="tonal">
                        {{
                          group.tools.filter((tool) => tool.enabled).length
                        }}/{{ group.tools.length }}
                      </v-chip>
                    </div>
                    <v-switch
                      :model-value="allEnabled(group)"
                      :indeterminate="someEnabled(group) && !allEnabled(group)"
                      color="primary"
                      density="compact"
                      hide-details
                      inset
                      :disabled="
                        group.tools.some((tool) => busy.has(tool.name))
                      "
                      :aria-label="pluginLabel(group.pluginId)"
                      @update:model-value="
                        setGroupEnabled(group, Boolean($event))
                      "
                    />
                  </div>
                  <v-divider />
                  <div class="mcp-built-in-tool-list">
                    <div
                      v-for="tool in group.visibleTools"
                      :key="tool.name"
                      class="mcp-built-in-tool"
                      :title="toolDescription(tool) + ' (' + tool.name + ')'"
                    >
                      <span>{{ toolTitle(tool) }}</span>
                      <v-switch
                        :model-value="tool.enabled"
                        color="primary"
                        density="compact"
                        hide-details
                        inset
                        :loading="busy.has(tool.name)"
                        :disabled="busy.has(tool.name)"
                        :aria-label="toolTitle(tool)"
                        @update:model-value="setEnabled(tool, Boolean($event))"
                      />
                    </div>
                  </div>
                </v-card>
              </div>
            </div>
            <div v-else-if="!loading" class="mcp-built-in-empty">
              {{ locale.t("$vuetify.chatroom.agentMcp.noMatchingTools") }}
            </div>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<style scoped>
.mcp-built-in {
  min-width: 0;
}
.mcp-built-in-panel {
  border: 1px solid rgba(var(--v-border-color), 0.16);
  border-radius: 10px;
  overflow: hidden;
}
.mcp-built-in-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.9rem;
  font-weight: 600;
}
.mcp-built-in-content {
  display: grid;
  gap: 12px;
}
.mcp-built-in-controls {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto;
  align-items: center;
  gap: 10px;
}
.mcp-built-in-controls :deep(.v-field) {
  border-radius: 8px;
}
.mcp-built-in-status-buttons {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.mcp-built-in-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 10px;
}
.mcp-built-in-column {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
}
.mcp-built-in-group {
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), 0.12);
}
.mcp-built-in-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 48px;
  padding: 6px 12px;
}
.mcp-built-in-group-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.86rem;
  font-weight: 600;
}
.mcp-built-in-tool-list {
  display: grid;
}
.mcp-built-in-tool {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  min-height: 42px;
  padding: 3px 12px;
  font-size: 0.82rem;
}
.mcp-built-in-tool + .mcp-built-in-tool {
  border-top: 1px solid rgba(var(--v-border-color), 0.1);
}
.mcp-built-in-tool > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-built-in-empty {
  padding: 20px;
  text-align: center;
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-size: 0.85rem;
}
@media (max-width: 900px) {
  .mcp-built-in-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 640px) {
  .mcp-built-in-controls {
    grid-template-columns: minmax(0, 1fr);
  }
  .mcp-built-in-status-buttons {
    justify-content: flex-start;
  }
}
</style>
