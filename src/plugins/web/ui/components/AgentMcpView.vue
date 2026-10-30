<script setup lang="ts">
import { onMounted, reactive, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { api, type CustomMcpServerSummary } from "../api.js";
import { errorMessage } from "../utils/errors.js";
import McpToolGroups from "./McpToolGroups.vue";

const locale = useLocale();
const t = (key: string) => locale.t("$vuetify.chatroom.agentMcp." + key);
const servers = shallowRef<CustomMcpServerSummary[]>([]);
const loading = shallowRef(false);
const error = shallowRef("");
const busy = reactive(new Set<string>());

onMounted(() => void load());

async function load() {
  loading.value = true;
  error.value = "";
  try {
    servers.value = await api<CustomMcpServerSummary[]>("/agent-mcp/servers");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function setServerEnabled(
  server: CustomMcpServerSummary,
  enabled: boolean,
) {
  if (busy.has(server.id) || server.enabled === enabled) return;
  busy.add(server.id);
  error.value = "";
  try {
    await api("/agent-mcp/servers/" + encodeURIComponent(server.id), {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
      timeoutMs: 30000,
    });
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.delete(server.id);
  }
}

async function setToolEnabled(
  server: CustomMcpServerSummary,
  tool: CustomMcpServerSummary["tools"][number],
  enabled: boolean,
) {
  if (busy.has(tool.name) || tool.enabled === enabled) return;
  busy.add(tool.name);
  error.value = "";
  try {
    const updated = await api<{ enabled: boolean }>(
      "/agent-mcp/tools/" + encodeURIComponent(tool.name),
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    );
    servers.value = servers.value.map((item) =>
      item.id !== server.id
        ? item
        : {
            ...item,
            tools: item.tools.map((entry) =>
              entry.name === tool.name
                ? { ...entry, enabled: updated.enabled }
                : entry,
            ),
          },
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.delete(tool.name);
  }
}

function statusLabel(status: CustomMcpServerSummary["status"]): string {
  const key: Record<CustomMcpServerSummary["status"], string> = {
    connected: "connected",
    connecting: "connecting",
    disabled: "disabled",
    auth_required: "authRequired",
    error: "error",
  };
  return locale.t("$vuetify.chatroom.customMcp." + key[status]);
}

function statusColor(status: CustomMcpServerSummary["status"]): string {
  if (status === "connected") return "success";
  if (status === "connecting") return "info";
  if (status === "auth_required" || status === "error") return "error";
  return "default";
}
</script>

<template>
  <div class="agent-mcp-view">
    <McpToolGroups scope="agent" />

    <section class="agent-mcp-custom">
      <div class="agent-mcp-section-heading">
        <span>{{ t("custom") }}</span>
        <v-btn
          icon="$mdiRefresh"
          size="small"
          variant="text"
          :loading="loading"
          :aria-label="t('refresh')"
          :title="t('refresh')"
          @click="load"
        />
      </div>

      <v-alert v-if="error" type="error" variant="tonal" density="compact">
        {{ error }}
      </v-alert>

      <v-progress-linear
        v-if="loading && !servers.length"
        indeterminate
        rounded
      />

      <v-card v-if="!loading && !servers.length" class="agent-mcp-empty">
        {{ t("noCustom") }}
      </v-card>

      <v-card
        v-for="server in servers"
        :key="server.id"
        class="agent-mcp-server"
      >
        <div class="agent-mcp-server-header">
          <span class="agent-mcp-server-name">{{ server.name }}</span>
          <v-chip
            size="x-small"
            variant="tonal"
            :color="statusColor(server.status)"
          >
            {{ statusLabel(server.status) }}
          </v-chip>
          <v-chip size="x-small" variant="tonal">{{
            server.tools.length
          }}</v-chip>
          <v-switch
            :model-value="server.enabled"
            color="primary"
            density="compact"
            hide-details
            inset
            :loading="busy.has(server.id)"
            :disabled="busy.has(server.id)"
            :aria-label="server.name"
            @update:model-value="setServerEnabled(server, Boolean($event))"
          />
        </div>
        <div v-if="server.error" class="agent-mcp-server-error">
          {{ server.error }}
        </div>
        <v-divider />
        <div v-if="!server.tools.length" class="agent-mcp-empty">
          {{ t("noTools") }}
        </div>
        <div v-else class="agent-mcp-tool-list">
          <div
            v-for="tool in server.tools"
            :key="tool.name"
            class="agent-mcp-tool"
            :title="tool.description + ' (' + tool.name + ')'"
          >
            <span>{{ tool.title }}</span>
            <v-switch
              :model-value="tool.enabled"
              color="primary"
              density="compact"
              hide-details
              inset
              :loading="busy.has(tool.name)"
              :disabled="busy.has(tool.name) || !server.enabled"
              :aria-label="tool.title"
              @update:model-value="
                setToolEnabled(server, tool, Boolean($event))
              "
            />
          </div>
        </div>
      </v-card>
    </section>
  </div>
</template>

<style scoped>
.agent-mcp-view {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.agent-mcp-custom {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.agent-mcp-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  font-size: 0.92rem;
  font-weight: 650;
}
.agent-mcp-server {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), 0.14);
}
.agent-mcp-server-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 6px 12px;
}
.agent-mcp-server-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 0.86rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-mcp-server-error {
  padding: 0 12px 8px;
  color: rgb(var(--v-theme-error));
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.agent-mcp-tool-list {
  display: grid;
}
.agent-mcp-tool {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  min-height: 42px;
  padding: 3px 12px;
  font-size: 0.82rem;
}
.agent-mcp-tool + .agent-mcp-tool {
  border-top: 1px solid rgba(var(--v-border-color), 0.1);
}
.agent-mcp-tool > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-mcp-empty {
  padding: 16px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.84rem;
}
@media (max-width: 620px) {
  .agent-mcp-server-header {
    flex-wrap: wrap;
  }
  .agent-mcp-server-name {
    flex-basis: 50%;
  }
}
</style>
