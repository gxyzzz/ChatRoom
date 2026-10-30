<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { api, type WorkspaceEntry } from "../api.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";
import WorkspaceCreateDialog from "./WorkspaceCreateDialog.vue";
import WorkspaceManageDialog from "./WorkspaceManageDialog.vue";
import WorkspaceFilesPane from "./WorkspaceFilesPane.vue";
import WorkspaceGitPane from "./WorkspaceGitPane.vue";
import WorkspacePromptPane from "./WorkspacePromptPane.vue";
import WorkspaceSkillsPane from "./WorkspaceSkillsPane.vue";

const items = shallowRef<WorkspaceEntry[]>([]);
const allowedRoots = shallowRef<string[]>([]);
const selectedWorkspaceId = shallowRef<string | null>(
  window.localStorage.getItem("chatroom.workspace.id"),
);
const selectedWorkspace = computed(
  () =>
    items.value.find((item) => item.id === selectedWorkspaceId.value) ?? null,
);
const tab = shallowRef("git");
const loading = shallowRef(false);
const error = shallowRef("");
const createOpen = shallowRef(false);
const manageOpen = shallowRef(false);
const creating = shallowRef(false);
const createError = shallowRef("");
const locale = useLocale();
const loadRequests = createRequestGate();

onMounted(() => void load());
watch(selectedWorkspaceId, (id) => {
  if (id) window.localStorage.setItem("chatroom.workspace.id", id);
  else window.localStorage.removeItem("chatroom.workspace.id");
});

async function load() {
  const request = loadRequests.begin();
  loading.value = true;
  error.value = "";
  try {
    const [workspaces, roots] = await Promise.all([
      api<WorkspaceEntry[]>("/workspaces", { signal: request.signal }),
      api<string[]>("/workspace/roots", { signal: request.signal }),
    ]);
    if (!loadRequests.isCurrent(request)) return;
    items.value = workspaces;
    allowedRoots.value = roots;
    if (!items.value.some((item) => item.id === selectedWorkspaceId.value))
      selectedWorkspaceId.value = items.value[0]?.id ?? null;
  } catch (cause) {
    if (loadRequests.isCurrent(request)) error.value = errorMessage(cause);
  } finally {
    if (loadRequests.isCurrent(request)) loading.value = false;
  }
}

async function createProject(parent: string, name: string) {
  if (creating.value) return;
  creating.value = true;
  createError.value = "";
  try {
    const created = await api<WorkspaceEntry>("/workspaces", {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    });
    await load();
    selectedWorkspaceId.value = created.id;
    createOpen.value = false;
  } catch (cause) {
    createError.value = errorMessage(cause);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="workspace-layout">
    <v-card class="workspace-detail panel-card">
      <div class="workspace-header">
        <div class="workspace-identity min-w-0">
          <v-select
            v-model="selectedWorkspaceId"
            :items="
              items.map((item) => ({
                title: item.name,
                value: item.id,
                subtitle: item.path,
              }))
            "
            :loading="loading"
            :aria-label="locale.t('$vuetify.chatroom.workspaces.workspace')"
            density="compact"
            variant="outlined"
            hide-details
            prepend-inner-icon="$mdiFolderOutline"
            class="workspace-switcher"
          />
          <div class="workspace-meta-row">
            <div
              v-if="selectedWorkspace"
              class="workspace-path"
              :title="selectedWorkspace.path"
            >
              {{ selectedWorkspace.path }}
            </div>
            <div class="workspace-actions">
              <v-btn
                icon="$mdiFolderCogOutline"
                size="small"
                variant="text"
                :aria-label="locale.t('$vuetify.chatroom.workspaces.manage')"
                @click="manageOpen = true"
              />
              <v-btn
                icon="$mdiPlus"
                size="small"
                variant="text"
                :aria-label="
                  locale.t('$vuetify.chatroom.workspaces.createTitle')
                "
                @click="
                  createError = '';
                  createOpen = true;
                "
              />
              <v-btn
                icon="$mdiRefresh"
                size="small"
                variant="text"
                :loading="loading"
                :aria-label="locale.t('$vuetify.chatroom.workspaces.refresh')"
                @click="load"
              />
            </div>
          </div>
        </div>
      </div>

      <v-alert v-if="error" type="error" variant="tonal" density="compact">
        {{ error }}
      </v-alert>

      <template v-if="selectedWorkspaceId">
        <v-tabs v-model="tab" density="compact" class="workspace-tabs">
          <v-tab value="git">{{
            locale.t("$vuetify.chatroom.workspaces.git")
          }}</v-tab>
          <v-tab value="prompt">{{
            locale.t("$vuetify.chatroom.workspaces.prompt")
          }}</v-tab>
          <v-tab value="files">{{
            locale.t("$vuetify.chatroom.workspaces.files")
          }}</v-tab>
          <v-tab value="skills">{{
            locale.t("$vuetify.chatroom.workspaces.skills")
          }}</v-tab>
        </v-tabs>
        <v-divider />

        <v-window v-model="tab" :touch="false">
          <v-window-item value="git">
            <WorkspaceGitPane :workspace-id="selectedWorkspaceId" />
          </v-window-item>
          <v-window-item value="prompt">
            <WorkspacePromptPane :workspace-id="selectedWorkspaceId" />
          </v-window-item>
          <v-window-item value="files">
            <WorkspaceFilesPane :workspace-id="selectedWorkspaceId" />
          </v-window-item>
          <v-window-item value="skills">
            <WorkspaceSkillsPane :workspace-id="selectedWorkspaceId" />
          </v-window-item>
        </v-window>
      </template>

      <v-empty-state
        v-else-if="!loading"
        icon="$mdiFolderOutline"
        :title="locale.t('$vuetify.chatroom.workspaces.empty')"
      />
    </v-card>

    <WorkspaceCreateDialog
      v-model="createOpen"
      :roots="allowedRoots"
      :busy="creating"
      :error="createError"
      @create="createProject"
    />
    <WorkspaceManageDialog v-model="manageOpen" @updated="load" />
  </div>
</template>
