<script setup lang="ts">
import { shallowRef } from "vue";
import { useLocale } from "vuetify";
import CustomMcpView from "./CustomMcpView.vue";
import AgentMcpView from "./AgentMcpView.vue";
import McpToolGroups from "./McpToolGroups.vue";

const locale = useLocale();
const activeScope = shallowRef("chatroom");
const customMcpView = shallowRef<InstanceType<typeof CustomMcpView> | null>(
  null,
);
</script>

<template>
  <div class="mcp-tools-shell">
    <header class="mcp-page-heading">
      <div class="min-w-0">
        <div class="mcp-page-title">
          {{ locale.t("$vuetify.chatroom.mcpTools.title") }}
        </div>
      </div>
      <div class="mcp-page-actions">
        <div
          class="mcp-scope-buttons"
          role="group"
          :aria-label="locale.t('$vuetify.chatroom.mcpTools.title')"
        >
          <v-btn
            size="small"
            variant="tonal"
            :color="activeScope === 'chatroom' ? 'primary' : 'default'"
            :aria-pressed="activeScope === 'chatroom'"
            @click="activeScope = 'chatroom'"
            >{{ locale.t("$vuetify.chatroom.agentMcp.chatroom") }}</v-btn
          >
          <v-btn
            size="small"
            variant="tonal"
            :color="activeScope === 'agent' ? 'primary' : 'default'"
            :aria-pressed="activeScope === 'agent'"
            @click="activeScope = 'agent'"
            >{{ locale.t("$vuetify.chatroom.agentMcp.agent") }}</v-btn
          >
        </div>
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="$mdiPlus"
          @click="customMcpView?.openAdd()"
          >{{ locale.t("$vuetify.chatroom.customMcp.add") }}</v-btn
        >
      </div>
    </header>

    <McpToolGroups v-if="activeScope === 'chatroom'" scope="chatroom" />
    <CustomMcpView ref="customMcpView" v-show="activeScope === 'chatroom'" />
    <AgentMcpView v-if="activeScope === 'agent'" />
  </div>
</template>

<style scoped>
.mcp-tools-shell {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.mcp-page-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}
.mcp-page-title {
  font-size: 1.05rem;
  font-weight: 700;
}
.mcp-page-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.mcp-scope-buttons {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 0 0 auto;
  gap: 8px;
  max-width: 100%;
}
@media (max-width: 620px) {
  .mcp-page-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .mcp-page-actions {
    width: 100%;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .mcp-scope-buttons {
    max-width: 100%;
    flex-wrap: wrap;
  }
}
</style>
