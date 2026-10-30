<script setup lang="ts">
import { onMounted, onUnmounted, reactive, shallowRef } from "vue";
import { useLocale } from "vuetify";
import {
  api,
  type CustomMcpServerSummary,
  type McpToolSummary,
} from "../api.js";
import { errorMessage } from "../utils/errors.js";
import CustomMcpDialog from "./CustomMcpDialog.vue";

const locale = useLocale();
const t = (key: string) => locale.t("$vuetify.chatroom.customMcp." + key);
const servers = shallowRef<CustomMcpServerSummary[]>([]);
const loading = shallowRef(false);
const error = shallowRef("");
const authError = shallowRef("");
const dialog = shallowRef(false);
const editing = shallowRef<CustomMcpServerSummary | null>(null);
const deleting = shallowRef<CustomMcpServerSummary | null>(null);
const expanded = reactive(new Set<string>());
const busy = reactive(new Set<string>());
let authorizationPolling: number | null = null;
let authorizationServerId: string | null = null;
let authorizationTimeout: number | null = null;
const stopPolling = () => {
  if (authorizationPolling !== null) window.clearInterval(authorizationPolling);
  if (authorizationTimeout !== null) window.clearTimeout(authorizationTimeout);
  authorizationPolling = null;
  authorizationTimeout = null;
  authorizationServerId = null;
};
const onOAuthMessage = (event: MessageEvent) => {
  if (
    event.origin === window.location.origin &&
    event.data?.type === "chatroom:mcp-oauth-completed"
  ) {
    stopPolling();
    if (event.data.success === false) authError.value = t("authFailed");
    void load();
  }
};
onMounted(() => window.addEventListener("message", onOAuthMessage));
onUnmounted(() => {
  stopPolling();
  window.removeEventListener("message", onOAuthMessage);
});

onMounted(() => void load());
async function load() {
  loading.value = true;
  error.value = "";
  try {
    servers.value = await api<CustomMcpServerSummary[]>("/mcp/servers");
    if (
      authorizationPolling !== null &&
      servers.value.some(
        (item) =>
          item.id === authorizationServerId && item.status === "connected",
      )
    )
      stopPolling();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
function add() {
  editing.value = null;
  dialog.value = true;
}

defineExpose({ openAdd: add });

function edit(server: CustomMcpServerSummary) {
  editing.value = server;
  dialog.value = true;
}
function toggleDetails(id: string) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}
async function mutate(id: string, action: () => Promise<unknown>) {
  if (busy.has(id)) return;
  busy.add(id);
  error.value = "";
  try {
    await action();
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.delete(id);
  }
}
async function enabled(server: CustomMcpServerSummary, enabled: boolean) {
  await mutate(server.id, () =>
    api("/mcp/servers/" + encodeURIComponent(server.id), {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
      timeoutMs: 30000,
    }),
  );
}
async function refresh(server: CustomMcpServerSummary) {
  await mutate(server.id, () =>
    api("/mcp/servers/" + encodeURIComponent(server.id) + "/refresh", {
      method: "POST",
      timeoutMs: 30000,
    }),
  );
}
async function authorize(server: CustomMcpServerSummary) {
  if (busy.has(server.id)) return;
  // Open a window synchronously so browsers do not block it after the API request.
  const popup = window.open("", "chatroom-mcp-login", "width=620,height=760");
  if (!popup) {
    authError.value = t("popupBlocked");
    return;
  }
  busy.add(server.id);
  authError.value = "";
  try {
    const { authorizationUrl } = await api<{ authorizationUrl: string }>(
      "/mcp/servers/" + encodeURIComponent(server.id) + "/authorize",
      { method: "POST", timeoutMs: 30000 },
    );
    popup.location.href = authorizationUrl;
    stopPolling();
    authorizationServerId = server.id;
    authorizationPolling = window.setInterval(() => void load(), 2500);
    authorizationTimeout = window.setTimeout(
      () => {
        stopPolling();
        void load();
      },
      10 * 60 * 1000,
    );
  } catch (cause) {
    popup.close();
    authError.value = errorMessage(cause);
  } finally {
    busy.delete(server.id);
    await load();
  }
}
async function revoke(server: CustomMcpServerSummary) {
  await mutate(server.id, () =>
    api("/mcp/servers/" + encodeURIComponent(server.id) + "/revoke", {
      method: "POST",
    }),
  );
}
async function remove() {
  const server = deleting.value;
  if (!server) return;
  await mutate(server.id, () =>
    api("/mcp/servers/" + encodeURIComponent(server.id), { method: "DELETE" }),
  );
  if (!error.value) deleting.value = null;
}
async function toggleTool(
  tool: CustomMcpServerSummary["tools"][number],
  enabled: boolean,
) {
  await mutate(tool.name, () =>
    api<McpToolSummary>("/mcp/tools/" + encodeURIComponent(tool.name), {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  );
}
</script>

<template>
  <div class="custom-mcp-view">
    <v-alert
      v-if="error || authError"
      type="error"
      variant="tonal"
      density="compact"
      >{{ error || authError }}</v-alert
    >
    <div class="custom-mcp-toolbar">
      <div class="custom-mcp-section-title">{{ t("custom") }}</div>
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
    <v-progress-linear v-if="loading && !servers.length" indeterminate />
    <v-card v-if="!loading && !servers.length" class="panel-card">
      <div class="empty-inline">{{ t("empty") }}</div>
    </v-card>
    <v-card v-for="server in servers" :key="server.id" class="panel-card">
      <div class="custom-mcp-header">
        <div class="min-w-0">
          <div class="panel-title">{{ server.name }}</div>
          <div class="text-caption text-medium-emphasis text-truncate">
            {{ server.type === "stdio" ? "stdio" : "Streamable HTTP" }}
            ·
            {{
              server.status === "connected"
                ? t("connected")
                : server.status === "connecting"
                  ? t("connecting")
                  : server.status === "disabled"
                    ? t("disabled")
                    : server.status === "auth_required"
                      ? t("authRequired")
                      : t("error")
            }}
            · {{ server.tools.length }} {{ t("tools") }}
          </div>
        </div>
        <v-switch
          :model-value="server.enabled"
          color="primary"
          density="compact"
          hide-details
          inset
          :loading="busy.has(server.id)"
          :disabled="busy.has(server.id)"
          :aria-label="server.name"
          @update:model-value="enabled(server, Boolean($event))"
        />
      </div>
      <div v-if="server.error" class="text-error text-body-2 px-4 pb-2">
        {{ server.error }}
      </div>
      <v-card-actions class="flex-wrap ga-1">
        <v-btn
          variant="text"
          size="small"
          :append-icon="
            expanded.has(server.id) ? '$mdiChevronUp' : '$mdiChevronDown'
          "
          @click="toggleDetails(server.id)"
        >
          {{ t("tools") }}
        </v-btn>
        <v-spacer />
        <v-btn
          v-if="
            server.type === 'http' &&
            server.authMode === 'auto' &&
            (server.status === 'auth_required' || server.authorized)
          "
          :variant="server.status === 'auth_required' ? 'tonal' : 'text'"
          :color="server.status === 'auth_required' ? 'primary' : undefined"
          size="small"
          :loading="busy.has(server.id)"
          @click="authorize(server)"
          >{{
            t(server.status === "connected" ? "reauthorize" : "authorize")
          }}</v-btn
        >
        <v-btn
          v-if="
            server.type === 'http' &&
            server.authMode === 'auto' &&
            server.status === 'connected'
          "
          variant="text"
          size="small"
          :disabled="busy.has(server.id)"
          @click="revoke(server)"
          >{{ t("revoke") }}</v-btn
        >
        <v-btn
          variant="text"
          size="small"
          :disabled="busy.has(server.id)"
          @click="edit(server)"
          >{{ t("edit") }}</v-btn
        >
        <v-btn
          variant="text"
          size="small"
          :loading="busy.has(server.id)"
          :disabled="!server.enabled"
          @click="refresh(server)"
          >{{ t("refresh") }}</v-btn
        >
        <v-btn
          variant="text"
          color="error"
          size="small"
          :disabled="busy.has(server.id)"
          @click="deleting = server"
          >{{ t("delete") }}</v-btn
        >
      </v-card-actions>
      <template v-if="expanded.has(server.id)">
        <v-divider />
        <div v-if="!server.tools.length" class="empty-inline">
          {{ t("noTools") }}
        </div>
        <div
          v-for="tool in server.tools"
          :key="tool.name"
          class="custom-mcp-tool-row"
        >
          <div class="min-w-0">
            <div class="text-body-2 font-weight-medium">{{ tool.title }}</div>
            <div
              class="text-caption text-medium-emphasis text-truncate"
              :title="tool.description"
            >
              {{ tool.name }}
            </div>
          </div>
          <v-switch
            :model-value="tool.enabled"
            color="primary"
            density="compact"
            hide-details
            inset
            :loading="busy.has(tool.name)"
            :disabled="busy.has(tool.name) || !server.enabled"
            :aria-label="tool.title"
            @update:model-value="toggleTool(tool, Boolean($event))"
          />
        </div>
      </template>
    </v-card>
    <CustomMcpDialog v-model="dialog" :server="editing" @saved="load" />
    <v-dialog
      :model-value="Boolean(deleting)"
      width="auto"
      max-width="32rem"
      :persistent="Boolean(deleting && busy.has(deleting.id))"
      @update:model-value="!$event && (deleting = null)"
    >
      <v-card v-if="deleting">
        <v-card-item prepend-icon="$mdiAlertCircleOutline" class="text-error">
          <v-card-title>{{ t("delete") }}</v-card-title>
        </v-card-item>
        <v-card-text>{{
          t("deleteConfirm").replace("{0}", deleting.name)
        }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            variant="text"
            :disabled="busy.has(deleting.id)"
            @click="deleting = null"
            >{{ t("cancel") }}</v-btn
          >
          <v-btn
            color="error"
            variant="flat"
            :loading="busy.has(deleting.id)"
            @click="remove"
            >{{ t("delete") }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.custom-mcp-view {
  display: grid;
  gap: 10px;
}
.custom-mcp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 36px;
}
.custom-mcp-section-title {
  font-size: 0.92rem;
  font-weight: 650;
}
.custom-mcp-header,
.custom-mcp-tool-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
}
.custom-mcp-tool-row + .custom-mcp-tool-row {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
