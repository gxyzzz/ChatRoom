<script setup lang="ts">
import { computed } from "vue";
import { useLocale } from "vuetify";
import type { AgentHistory, AgentItem, AgentProviderId } from "../api.js";
import AgentArtifactGallery from "./AgentArtifactGallery.vue";
import AgentCommandItem from "./AgentCommandItem.vue";
import AgentInteractionCard from "./AgentInteractionCard.vue";
import AgentProviderIcon from "./AgentProviderIcon.vue";
import AgentActivity from "./AgentActivity.vue";
import MarkdownContent from "./MarkdownContent.vue";

type TurnEntry = AgentHistory["turns"][number];
type ImageArtifactItem = Extract<AgentItem, { type: "artifact" }>;
type TurnRenderItem =
  | AgentItem
  | {
      id: string;
      type: "provider_marker";
      provider: AgentProviderId;
      model: string | null;
    }
  | {
      id: string;
      type: "image_gallery";
      items: ImageArtifactItem[];
    }
  | {
      id: string;
      type: "turn_status";
      status: "failed" | "interrupted";
      error: string | null;
    };

const props = defineProps<{
  entry: TurnEntry;
  workspaceId: string;
  providerNames: Readonly<Record<string, string>>;
  providerIcons: Readonly<Record<string, string | null>>;
}>();
const locale = useLocale();

const renderItems = computed<TurnRenderItem[]>(() => {
  const output: TurnRenderItem[] = [];
  const turnItems = props.entry.items;
  let providerMarked = false;

  for (let index = 0; index < turnItems.length; index += 1) {
    const item = turnItems[index]!;
    if (item.type !== "user_message" && !providerMarked) {
      output.push({
        id: "provider-marker:" + props.entry.turn.id,
        type: "provider_marker",
        provider: props.entry.turn.provider,
        model: props.entry.turn.model,
      });
      providerMarked = true;
    }

    if (item.type !== "artifact" || item.artifact.kind !== "image") {
      output.push(item);
      continue;
    }

    const gallery: ImageArtifactItem[] = [item];
    while (index + 1 < turnItems.length) {
      const next = turnItems[index + 1]!;
      if (next.type !== "artifact" || next.artifact.kind !== "image") break;
      gallery.push(next);
      index += 1;
    }
    output.push({
      id: "image-gallery:" + gallery[0]!.id,
      type: "image_gallery",
      items: gallery,
    });
  }

  if (
    !providerMarked &&
    turnItems.length === 0 &&
    props.entry.turn.status !== "completed"
  ) {
    output.push({
      id: "provider-marker:" + props.entry.turn.id,
      type: "provider_marker",
      provider: props.entry.turn.provider,
      model: props.entry.turn.model,
    });
  }

  if (
    props.entry.turn.status === "failed" ||
    props.entry.turn.status === "interrupted"
  ) {
    output.push({
      id: "turn-status:" + props.entry.turn.id,
      type: "turn_status",
      status: props.entry.turn.status,
      error: formatTurnError(),
    });
  }

  return output;
});

function providerName(provider: AgentProviderId): string {
  return props.providerNames[provider] ?? provider;
}

function providerIcon(provider: AgentProviderId): string | null {
  return props.providerIcons[provider] ?? null;
}

function sourceIcon(source: "human" | "mcp"): string {
  return source === "mcp" ? "$mdiConnection" : "$mdiAccountOutline";
}

function sourceLabel(source: "human" | "mcp"): string {
  return locale.t(
    source === "mcp"
      ? "$vuetify.chatroom.agents.sources.mcp"
      : "$vuetify.chatroom.agents.sources.human",
  );
}

function formatTurnError(): string | null {
  const error = props.entry.turn.error;
  if (!error) return null;
  return [
    error.message,
    error.details,
    error.providerData ? JSON.stringify(error.providerData, null, 2) : null,
  ]
    .filter(Boolean)
    .join("\n");
}
</script>

<template>
  <div class="agent-turn">
    <template v-for="item in renderItems" :key="item.id">
      <div v-if="item.type === 'user_message'" class="agent-message-row user">
        <div class="agent-message user-message">
          <div class="agent-message-text agent-plain-text">
            {{ item.text }}
          </div>
          <div
            class="agent-message-source"
            :data-source="item.source ?? entry.turn.source"
          >
            <v-icon
              :icon="sourceIcon(item.source ?? entry.turn.source)"
              size="13"
            />
            <span>{{ sourceLabel(item.source ?? entry.turn.source) }}</span>
          </div>
          <div v-if="item.attachments.length" class="agent-message-attachments">
            <v-chip
              v-for="attachment in item.attachments"
              :key="attachment.path"
              size="x-small"
              variant="tonal"
              prepend-icon="$mdiFileOutline"
            >
              {{ attachment.name }}
            </v-chip>
          </div>
        </div>
      </div>

      <div
        v-else-if="item.type === 'provider_marker'"
        class="agent-turn-provider"
        :title="
          item.model
            ? providerName(item.provider) + ' · ' + item.model
            : providerName(item.provider)
        "
      >
        <AgentProviderIcon :icon="providerIcon(item.provider)" :size="13" />
        <span>{{ providerName(item.provider) }}</span>
      </div>

      <div
        v-else-if="item.type === 'turn_status'"
        class="agent-turn-status"
        :data-status="item.status"
      >
        <span>{{
          locale.t(`$vuetify.chatroom.agents.statuses.${item.status}`)
        }}</span>
        <span v-if="item.error"> · {{ item.error }}</span>
      </div>

      <div
        v-else-if="item.type === 'assistant_message'"
        class="agent-response-text"
        :data-phase="item.phase"
      >
        <MarkdownContent
          class="agent-message-markdown"
          :text="item.text"
          :streaming="item.status === 'running'"
        />
        <v-progress-linear
          v-if="item.status === 'running'"
          indeterminate
          height="2"
          class="agent-item-progress"
        />
      </div>

      <div
        v-else-if="item.type === 'reasoning_summary'"
        class="agent-reasoning-summary"
      >
        <div class="agent-summary-label">
          {{ locale.t("$vuetify.chatroom.agents.reasoningSummary") }}
        </div>
        <MarkdownContent
          :text="item.text"
          :streaming="item.status === 'running'"
        />
      </div>

      <div v-else-if="item.type === 'command'" class="agent-response-command">
        <AgentCommandItem
          :command="item.command"
          :cwd="item.cwd"
          :output="item.output"
          :exit-code="item.exitCode"
          :status="item.status"
        />
      </div>

      <AgentArtifactGallery
        v-else-if="item.type === 'image_gallery'"
        :items="item.items"
        :workspace-id="workspaceId"
      />

      <details
        v-else-if="item.type === 'interaction' && item.status !== 'waiting'"
        class="agent-resolved-interaction"
      >
        <summary>
          <v-icon
            :icon="
              item.status === 'completed'
                ? '$mdiCheckCircleOutline'
                : '$mdiAlertCircleOutline'
            "
            size="18"
          />
          {{ item.interaction.title }}
        </summary>
        <AgentInteractionCard :item="item" />
      </details>

      <AgentActivity
        v-else-if="
          item.type === 'tool' ||
          item.type === 'file_change' ||
          item.type === 'turn_diff' ||
          item.type === 'plan' ||
          item.type === 'artifact'
        "
        :item="item"
      />

      <div
        v-else-if="item.type === 'context_compaction'"
        class="agent-compaction"
        :data-status="item.status"
        role="status"
        aria-live="polite"
      >
        <v-progress-circular
          v-if="item.status === 'running'"
          indeterminate
          size="14"
          width="2"
        />
        <v-icon
          v-else
          :icon="
            item.status === 'completed'
              ? '$mdiCheckCircleOutline'
              : '$mdiAlertCircleOutline'
          "
          size="16"
        />
        <span>{{
          locale.t(
            "$vuetify.chatroom.agents.compaction." +
              (item.status === "running"
                ? "running"
                : item.status === "completed"
                  ? "completed"
                  : "failed"),
          )
        }}</span>
        <span v-if="item.error">{{ item.error }}</span>
      </div>

      <div
        v-else-if="item.type === 'notice'"
        class="agent-notice"
        :data-level="item.level"
      >
        {{ item.text }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-turn {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  content-visibility: auto;
  contain-intrinsic-size: auto 160px;
}

.agent-message-row {
  min-width: 0;
  display: flex;
}

.agent-message-row.user {
  justify-content: flex-end;
}

.agent-message {
  min-width: 0;
  max-inline-size: 100%;
  border-radius: 8px;
  padding: 11px 14px;
}

.user-message {
  position: relative;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}

.agent-turn-provider {
  min-height: 18px;
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 5px;
  margin: 1px 2px -4px;
  color: rgba(var(--v-theme-on-surface), 0.56);
  font-size: 0.7rem;
  font-weight: 500;
  line-height: 1;
}

.agent-turn-status {
  align-self: stretch;
  min-width: 0;
  color: rgb(var(--v-theme-error));
  font-size: 0.76rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.agent-response-text,
.agent-response-command,
.agent-reasoning-summary {
  min-width: 0;
  align-self: stretch;
}

.agent-response-text {
  padding: 1px 2px;
  color: rgb(var(--v-theme-on-surface));
}

.agent-response-command {
  display: block;
}

.agent-response-text + .agent-response-text {
  margin-top: -6px;
}

.agent-response-text + .agent-response-command,
.agent-response-command + .agent-response-text {
  margin-top: -3px;
}

.agent-message-source {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-block-start: 6px;
  color: currentColor;
  opacity: 0.72;
  font-size: 0.7rem;
}

.agent-message-text,
.agent-message-markdown,
.agent-plan {
  overflow-wrap: anywhere;
  line-height: 1.55;
}

.agent-plain-text {
  white-space: pre-wrap;
}

.agent-message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.agent-item-progress {
  margin-top: 8px;
}

.agent-notice {
  align-self: center;
  max-inline-size: 100%;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.82rem;
  text-align: center;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.agent-reasoning-summary {
  padding: 8px 12px;
  border-inline-start: 2px solid rgba(var(--v-border-color), 0.3);
  overflow-wrap: anywhere;
}

.agent-summary-label {
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.72rem;
  margin-bottom: 4px;
  font-weight: 600;
}

.agent-response-text[data-phase="commentary"] {
  padding-inline-start: 10px;
  border-inline-start: 2px solid rgba(var(--v-border-color), 0.18);
  color: rgba(var(--v-theme-on-surface), 0.68);
  font-size: 0.875rem;
}

.agent-compaction {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.8rem;
}
.agent-compaction[data-status="failed"] {
  color: rgb(var(--v-theme-error));
}

@media (max-width: 960px) {
  .agent-message {
    width: auto;
    max-width: 94%;
  }

  .agent-turn-provider,
  .agent-response-text,
  .agent-response-command,
  .agent-reasoning-summary {
    width: 100%;
    max-width: 100%;
  }
}

@media (max-width: 520px) {
  .agent-message {
    max-width: 96%;
  }
}

.agent-resolved-interaction {
  min-inline-size: 0;
}
.agent-resolved-interaction > summary {
  cursor: pointer;
  padding-block: 0.5em;
  overflow-wrap: anywhere;
  color: rgba(var(--v-theme-on-surface), 0.72);
}
.agent-resolved-interaction > summary .v-icon {
  margin-inline-end: 0.5em;
}
</style>
