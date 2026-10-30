<script setup lang="ts">
import { shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { api, type WorkspaceEntry } from "../api.js";
import { errorMessage } from "../utils/errors.js";

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ updated: [] }>();
const locale = useLocale();
const items = shallowRef<WorkspaceEntry[]>([]);
const projectPath = shallowRef("");
const projectName = shallowRef("");
const editingId = shallowRef<string | null>(null);
const editingName = shallowRef("");
const loading = shallowRef(false);
const saving = shallowRef(false);
const error = shallowRef("");
const notice = shallowRef("");

watch(open, (visible) => {
  if (!visible) return;
  projectPath.value = "";
  projectName.value = "";
  editingId.value = null;
  error.value = "";
  notice.value = "";
  void load();
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    items.value = await api<WorkspaceEntry[]>("/workspaces/manage");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function registerProject() {
  if (!projectPath.value.trim() || saving.value) return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api<WorkspaceEntry>("/workspaces/register", {
      method: "POST",
      body: JSON.stringify({
        path: projectPath.value.trim(),
        name: projectName.value.trim() || null,
      }),
    });
    projectPath.value = "";
    projectName.value = "";
    notice.value = locale.t("$vuetify.chatroom.workspaces.registered");
    emit("updated");
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

function beginRename(item: WorkspaceEntry) {
  editingId.value = item.id;
  editingName.value = item.name;
  error.value = "";
  notice.value = "";
}

function cancelRename() {
  editingId.value = null;
  editingName.value = "";
}

async function saveRename(item: WorkspaceEntry) {
  const name = editingName.value.trim();
  if (!name || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api<WorkspaceEntry>("/workspaces/" + encodeURIComponent(item.id), {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    cancelRename();
    emit("updated");
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function removeProject(item: WorkspaceEntry) {
  if (saving.value) return;
  if (!window.confirm(locale.t("$vuetify.chatroom.workspaces.removeConfirm")))
    return;
  saving.value = true;
  error.value = "";
  try {
    await api<void>("/workspaces/" + encodeURIComponent(item.id), {
      method: "DELETE",
    });
    emit("updated");
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function cleanupProject(item: WorkspaceEntry) {
  if (saving.value) return;
  if (!window.confirm(locale.t("$vuetify.chatroom.workspaces.cleanupConfirm")))
    return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api<void>("/workspaces/" + encodeURIComponent(item.id) + "/cleanup", {
      method: "DELETE",
    });
    emit("updated");
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function restoreProject(item: WorkspaceEntry) {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api<WorkspaceEntry>(
      "/workspaces/" + encodeURIComponent(item.id) + "/restore",
      { method: "POST", body: JSON.stringify({}) },
    );
    emit("updated");
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

function statusLabel(status: WorkspaceEntry["status"]): string {
  if (status === "available")
    return locale.t("$vuetify.chatroom.workspaces.available");
  if (status === "restore_pending")
    return locale.t("$vuetify.chatroom.workspaces.restorePending");
  if (status === "unregistered")
    return locale.t("$vuetify.chatroom.workspaces.unregistered");
  return locale.t("$vuetify.chatroom.workspaces.missing");
}

function sourceLabel(item: WorkspaceEntry): string {
  return locale.t("$vuetify.chatroom.workspaces." + item.source);
}
</script>

<template>
  <v-dialog v-model="open" width="min(760px, 96vw)" scrollable>
    <v-card class="workspace-manage-dialog">
      <v-card-item prepend-icon="$mdiFolderCogOutline">
        <v-card-title>
          {{ locale.t("$vuetify.chatroom.workspaces.manage") }}
        </v-card-title>
        <template #append>
          <v-btn
            icon="$mdiClose"
            variant="text"
            size="small"
            :aria-label="locale.t('$vuetify.chatroom.common.close')"
            @click="open = false"
          />
        </template>
      </v-card-item>

      <v-card-text class="workspace-manage-content">
        <section class="workspace-register-form">
          <div class="text-subtitle-2">
            {{ locale.t("$vuetify.chatroom.workspaces.addExisting") }}
          </div>
          <div class="text-body-2 text-medium-emphasis">
            {{ locale.t("$vuetify.chatroom.workspaces.pathHelp") }}
          </div>
          <v-text-field
            v-model="projectPath"
            :label="locale.t('$vuetify.chatroom.workspaces.projectPathInput')"
            placeholder="/mnt/data/my-project"
            hide-details="auto"
            density="comfortable"
            @keyup.enter="registerProject"
          />
          <v-text-field
            v-model="projectName"
            :label="
              locale.t('$vuetify.chatroom.workspaces.displayNameOptional')
            "
            hide-details="auto"
            density="comfortable"
            @keyup.enter="registerProject"
          />
          <div class="d-flex justify-end">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="$mdiPlus"
              :loading="saving"
              :disabled="!projectPath.trim()"
              @click="registerProject"
            >
              {{ locale.t("$vuetify.chatroom.workspaces.register") }}
            </v-btn>
          </div>
        </section>

        <v-divider />

        <div class="workspace-manage-list-heading">
          <span class="text-subtitle-2">
            {{ locale.t("$vuetify.chatroom.workspaces.workspace") }}
          </span>
          <v-btn
            icon="$mdiRefresh"
            variant="text"
            size="small"
            :loading="loading"
            :aria-label="locale.t('$vuetify.chatroom.workspaces.refresh')"
            @click="load"
          />
        </div>

        <v-progress-linear v-if="loading" indeterminate />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">
          {{ error }}
        </v-alert>
        <v-alert
          v-else-if="notice"
          type="success"
          variant="tonal"
          density="compact"
        >
          {{ notice }}
        </v-alert>

        <div v-if="items.length" class="workspace-manage-list">
          <div
            v-for="item in items"
            :key="item.id"
            class="workspace-manage-item"
          >
            <div class="workspace-manage-item-main">
              <template v-if="editingId === item.id">
                <v-text-field
                  v-model="editingName"
                  autofocus
                  density="compact"
                  hide-details
                  :disabled="saving"
                  @keyup.enter="saveRename(item)"
                  @keyup.esc="cancelRename"
                />
              </template>
              <template v-else>
                <div class="workspace-manage-item-title">{{ item.name }}</div>
              </template>
              <div class="workspace-manage-item-path">{{ item.path }}</div>
              <div class="workspace-manage-item-tags">
                <v-chip
                  size="x-small"
                  variant="tonal"
                  :color="item.status === 'available' ? 'success' : 'warning'"
                >
                  {{ statusLabel(item.status) }}
                </v-chip>
                <v-chip size="x-small" variant="tonal">
                  {{ sourceLabel(item) }}
                </v-chip>
              </div>
            </div>
            <div class="workspace-manage-item-actions">
              <template v-if="editingId === item.id">
                <v-btn
                  icon="$mdiCheck"
                  size="small"
                  variant="text"
                  :loading="saving"
                  :aria-label="locale.t('$vuetify.chatroom.workspaces.save')"
                  @click="saveRename(item)"
                />
                <v-btn
                  icon="$mdiClose"
                  size="small"
                  variant="text"
                  :disabled="saving"
                  :aria-label="locale.t('$vuetify.chatroom.workspaces.cancel')"
                  @click="cancelRename"
                />
              </template>
              <template v-else>
                <v-btn
                  icon="$mdiPencil"
                  size="small"
                  variant="text"
                  :disabled="saving"
                  :aria-label="locale.t('$vuetify.chatroom.workspaces.rename')"
                  @click="beginRename(item)"
                />
                <v-btn
                  v-if="item.status === 'restore_pending'"
                  icon="$mdiFolderSync"
                  size="small"
                  variant="text"
                  :loading="saving"
                  :aria-label="locale.t('$vuetify.chatroom.workspaces.restore')"
                  @click="restoreProject(item)"
                />
                <v-btn
                  v-if="item.status !== 'available'"
                  icon="$mdiDeleteForeverOutline"
                  size="small"
                  variant="text"
                  color="error"
                  :disabled="saving"
                  :aria-label="locale.t('$vuetify.chatroom.workspaces.cleanup')"
                  @click="cleanupProject(item)"
                />
                <v-btn
                  v-if="item.manuallyRegistered && !item.discovered"
                  icon="$mdiFolderRemoveOutline"
                  size="small"
                  variant="text"
                  color="error"
                  :disabled="saving"
                  :aria-label="locale.t('$vuetify.chatroom.workspaces.remove')"
                  @click="removeProject(item)"
                />
              </template>
            </div>
          </div>
        </div>
        <v-empty-state
          v-else-if="!loading"
          icon="$mdiFolderOutline"
          :title="locale.t('$vuetify.chatroom.workspaces.empty')"
        />
      </v-card-text>

      <v-card-actions class="justify-end">
        <v-btn variant="text" @click="open = false">
          {{ locale.t("$vuetify.chatroom.common.close") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.workspace-manage-dialog {
  max-height: min(88vh, 900px);
}

.workspace-manage-content {
  display: grid;
  gap: 18px;
}

.workspace-register-form {
  display: grid;
  gap: 10px;
}

.workspace-manage-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.workspace-manage-list {
  display: grid;
  gap: 0;
}

.workspace-manage-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.workspace-manage-item-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 5px;
}

.workspace-manage-item-title {
  font-weight: 600;
}

.workspace-manage-item-path {
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.workspace-manage-item-tags,
.workspace-manage-item-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.workspace-manage-item-actions {
  flex-shrink: 0;
}
</style>
