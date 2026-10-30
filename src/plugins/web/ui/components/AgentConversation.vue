<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from "vue";
import { useLocale } from "vuetify";
import type { AgentHistory } from "../api.js";
import { useAgentConversationScroll } from "../composables/useAgentConversationScroll.js";
import AgentTurn from "./AgentTurn.vue";

const props = defineProps<{
  history: AgentHistory | null;
  providerNames: Readonly<Record<string, string>>;
  providerIcons: Readonly<Record<string, string | null>>;
}>();
const locale = useLocale();
const TURN_PAGE_SIZE = 100;
const visibleTurnLimit = shallowRef(TURN_PAGE_SIZE);
const conversation = useTemplateRef<HTMLElement>("conversation");
const conversationContent = useTemplateRef<HTMLElement>("conversationContent");
const { autoFollow, onConversationScroll, scrollToBottom } =
  useAgentConversationScroll(conversation, conversationContent);

const visibleTurns = computed(() => {
  const turns = props.history?.turns ?? [];
  return turns.slice(Math.max(0, turns.length - visibleTurnLimit.value));
});
const hiddenTurnCount = computed(() =>
  Math.max(0, (props.history?.turns.length ?? 0) - visibleTurns.value.length),
);

watch(
  () => props.history?.session.id ?? null,
  () => {
    visibleTurnLimit.value = TURN_PAGE_SIZE;
    scrollToBottom();
  },
  { flush: "post" },
);

watch(
  () => props.history?.turns.length ?? 0,
  (next, previous) => {
    if (
      previous > 0 &&
      next > previous &&
      visibleTurnLimit.value > TURN_PAGE_SIZE
    )
      visibleTurnLimit.value += next - previous;
  },
);

async function showOlderTurns() {
  const element = conversation.value;
  const previousHeight = element?.scrollHeight ?? 0;
  const previousTop = element?.scrollTop ?? 0;
  visibleTurnLimit.value += TURN_PAGE_SIZE;
  await nextTick();
  if (!element) return;
  element.scrollTop = previousTop + (element.scrollHeight - previousHeight);
}
</script>

<template>
  <div class="agent-conversation-shell">
    <div
      ref="conversation"
      class="agent-conversation"
      @scroll.passive="onConversationScroll"
    >
      <div ref="conversationContent" class="agent-conversation-content">
        <v-btn
          v-if="hiddenTurnCount"
          class="agent-show-older-turns"
          size="small"
          variant="text"
          @click="showOlderTurns"
        >
          {{
            locale.t(
              "$vuetify.chatroom.agents.showOlderTurns",
              String(Math.min(TURN_PAGE_SIZE, hiddenTurnCount)),
            )
          }}
        </v-btn>
        <div v-if="!history?.turns.length" class="empty-panel">
          {{ locale.t("$vuetify.chatroom.agents.noHistory") }}
        </div>
        <AgentTurn
          v-for="entry in visibleTurns"
          :key="entry.turn.id"
          :entry="entry"
          :workspace-id="history?.session.workspaceId ?? ''"
          :provider-names="providerNames"
          :provider-icons="providerIcons"
        />
      </div>
    </div>

    <v-btn
      v-if="!autoFollow"
      class="agent-back-to-latest"
      icon="$mdiArrowDown"
      size="small"
      variant="tonal"
      :title="locale.t('$vuetify.chatroom.agents.backToLatest')"
      :aria-label="locale.t('$vuetify.chatroom.agents.backToLatest')"
      @click="scrollToBottom"
    />
  </div>
</template>

<style scoped>
.agent-conversation-shell {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}

.agent-conversation {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
  overflow-anchor: none;
}

.agent-conversation-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.agent-back-to-latest {
  position: absolute;
  right: 18px;
  bottom: 14px;
  z-index: 3;
}

@media (max-width: 960px) {
  .agent-conversation {
    padding: 14px;
  }
}

@media (max-width: 520px) {
  .agent-conversation {
    padding: 12px 10px;
  }
}

.agent-show-older-turns {
  align-self: center;
}
</style>
