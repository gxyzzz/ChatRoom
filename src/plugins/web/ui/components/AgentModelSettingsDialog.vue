<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { useLocale } from "vuetify";
import type { AgentModel, AgentProviderStatus } from "../api.js";
import type {
  ApprovalPolicyMode,
  ApprovalsReviewer,
  GranularApproval,
  PermissionMode,
  ReasoningSummary,
} from "../utils/agent-config.js";
import { defaultAgentSettingLabel } from "../utils/agent-display.js";
import AgentSessionConfigFields from "./AgentSessionConfigFields.vue";

type NativeSetting = AgentProviderStatus["nativeSettings"][number];

const props = defineProps<{
  models: AgentModel[];
  approvalSetting: NativeSetting | null;
  reviewerSetting: NativeSetting | null;
  permissionSetting: NativeSetting | null;
  busy: boolean;
}>();

const emit = defineEmits<{ save: [] }>();
const open = defineModel<boolean>({ required: true });
const modelId = defineModel<string | null>("modelId", { required: true });
const reasoningEffort = defineModel<string | null>("reasoningEffort", {
  required: true,
});
const reasoningSummary = defineModel<ReasoningSummary | null>(
  "reasoningSummary",
  { required: true },
);
const serviceTier = defineModel<string | null>("serviceTier", {
  required: true,
});
const approvalMode = defineModel<ApprovalPolicyMode | null>("approvalMode", {
  required: true,
});
const granular = defineModel<GranularApproval>("granular", { required: true });
const reviewer = defineModel<ApprovalsReviewer>("reviewer", { required: true });
const permissionMode = defineModel<PermissionMode>("permissionMode", {
  required: true,
});

const locale = useLocale();
const modelSelectHost = useTemplateRef<HTMLElement>("modelSelectHost");
let modelSelectObserver: ResizeObserver | null = null;
const modelMenuWidth = shallowRef<number | null>(null);

const model = computed(() =>
  modelId.value
    ? (props.models.find((item) => item.id === modelId.value) ?? null)
    : (props.models.find((item) => item.isDefault) ?? props.models[0] ?? null),
);

const modelItems = computed(() => [
  {
    title: locale.t("$vuetify.chatroom.agents.defaultModel"),
    value: null,
    subtitle: "",
  },
  ...props.models.map((item) => ({
    title: item.displayName,
    value: item.id,
    subtitle: item.description,
  })),
]);

const modelMenuProps = computed(() => {
  const width = modelMenuWidth.value;
  return {
    contentClass: "agent-model-select-menu",
    ...(width === null ? {} : { width, minWidth: width, maxWidth: width }),
  };
});

const reasoningOptions = computed(() => {
  const defaultEffort = model.value?.reasoningEfforts.find(
    (effort) => effort.id === model.value?.defaultReasoningEffort,
  );
  return [
    {
      title: defaultSettingLabel(model.value?.defaultReasoningEffort),
      value: null,
      subtitle: defaultEffort?.description ?? "",
    },
    ...(model.value?.reasoningEfforts ?? []).map((effort) => ({
      title: effort.id,
      value: effort.id,
      subtitle: effort.description,
    })),
  ];
});

const reasoningIndex = computed({
  get() {
    const index = reasoningOptions.value.findIndex(
      (item) => item.value === reasoningEffort.value,
    );
    return index < 0 ? 0 : index;
  },
  set(index: number) {
    reasoningEffort.value =
      reasoningOptions.value[Math.round(index)]?.value ?? null;
  },
});
const reasoningOption = computed(
  () => reasoningOptions.value[reasoningIndex.value] ?? null,
);

watch(model, (next) => {
  if (
    !next?.reasoningEfforts?.some(
      (effort) => effort.id === reasoningEffort.value,
    )
  )
    reasoningEffort.value = null;
  if (!next?.reasoningSummaries?.includes(reasoningSummary.value ?? "none"))
    reasoningSummary.value = null;
  if (!next?.serviceTiers?.some((tier) => tier.id === serviceTier.value))
    serviceTier.value = null;
});

watch(open, async (value) => {
  if (!value) {
    disconnectModelObserver();
    modelMenuWidth.value = null;
    return;
  }
  await nextTick();
  observeModelSelect();
});

onBeforeUnmount(disconnectModelObserver);

function defaultSettingLabel(officialDefault?: string | null): string {
  return defaultAgentSettingLabel(
    locale.t("$vuetify.chatroom.agents.defaultModel"),
    officialDefault,
  );
}

function observeModelSelect() {
  disconnectModelObserver();
  const host = modelSelectHost.value;
  if (!host) {
    modelMenuWidth.value = null;
    return;
  }
  const update = () => {
    const width = host.clientWidth;
    modelMenuWidth.value = width > 0 ? width : null;
  };
  update();
  modelSelectObserver = new ResizeObserver(update);
  modelSelectObserver.observe(host);
}

function disconnectModelObserver() {
  modelSelectObserver?.disconnect();
  modelSelectObserver = null;
}
</script>

<template>
  <v-dialog v-model="open" :persistent="busy">
    <v-card>
      <v-card-item prepend-icon="$mdiTuneVariant">
        <v-card-title>
          {{ locale.t("$vuetify.chatroom.agents.modelSettings") }}
        </v-card-title>
      </v-card-item>
      <v-card-text class="agent-model-settings-dialog">
        <div ref="modelSelectHost" class="agent-model-select-host">
          <v-select
            v-model="modelId"
            :items="modelItems"
            :menu-props="modelMenuProps"
            :label="locale.t('$vuetify.chatroom.agents.model')"
            density="compact"
            variant="outlined"
            hide-details
            :disabled="busy"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
            </template>
          </v-select>
        </div>

        <div
          v-if="model?.reasoningEfforts?.length"
          class="agent-reasoning-slider"
        >
          <div class="agent-setting-heading">
            <span>{{
              locale.t("$vuetify.chatroom.agents.reasoningEffort")
            }}</span>
            <strong>{{ reasoningOption?.title }}</strong>
          </div>
          <v-slider
            v-model="reasoningIndex"
            :min="0"
            :max="Math.max(0, reasoningOptions.length - 1)"
            :step="1"
            color="primary"
            show-ticks="always"
            :aria-label="locale.t('$vuetify.chatroom.agents.reasoningEffort')"
            hide-details
            :disabled="busy"
          />
          <div
            v-if="reasoningOption?.subtitle"
            class="agent-setting-description"
          >
            {{ reasoningOption.subtitle }}
          </div>
        </div>

        <AgentSessionConfigFields
          v-model:reasoning-summary="reasoningSummary"
          v-model:service-tier="serviceTier"
          v-model:approval-mode="approvalMode"
          v-model:granular="granular"
          v-model:reviewer="reviewer"
          v-model:permission-mode="permissionMode"
          :model="model"
          :approval-setting="approvalSetting"
          :reviewer-setting="reviewerSetting"
          :permission-setting="permissionSetting"
          :disabled="busy"
          outlined
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="open = false">
          {{ locale.t("$vuetify.chatroom.common.cancel") }}
        </v-btn>
        <v-btn
          color="primary"
          variant="tonal"
          :loading="busy"
          @click="emit('save')"
        >
          {{ locale.t("$vuetify.chatroom.common.save") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.agent-model-settings-dialog {
  display: grid;
  gap: 18px;
}

.agent-model-select-host {
  min-width: 0;
}

:global(.agent-model-select-menu) {
  overflow-x: hidden;
}

:global(.agent-model-select-menu .v-list-item) {
  min-width: 0;
}

:global(.agent-model-select-menu .v-list-item-title),
:global(.agent-model-select-menu .v-list-item-subtitle) {
  min-width: 0;
  overflow-wrap: anywhere;
}

:global(.agent-model-select-menu .v-list-item-subtitle) {
  white-space: normal;
}

.agent-reasoning-slider {
  min-width: 0;
}

.agent-setting-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 0.82rem;
}

.agent-setting-heading strong {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  text-align: end;
}

.agent-reasoning-slider :deep(.v-slider) {
  margin-inline: 4px;
}

.agent-reasoning-slider :deep(.v-slider-track__background) {
  background: rgba(var(--v-theme-on-surface), 0.24);
  opacity: 1;
}

.agent-reasoning-slider :deep(.v-slider-track__fill),
.agent-reasoning-slider :deep(.v-slider-thumb__surface) {
  background: rgb(var(--v-theme-primary));
  opacity: 1;
}

.agent-reasoning-slider :deep(.v-slider-thumb__surface) {
  box-shadow:
    0 0 0 2px rgb(var(--v-theme-surface)),
    0 1px 5px rgba(0, 0, 0, 0.32);
}

.agent-reasoning-slider :deep(.v-slider-track__tick) {
  background: rgba(var(--v-theme-on-surface), 0.58);
  opacity: 1;
}

.agent-reasoning-slider :deep(.v-slider-track__tick--filled) {
  background: rgb(var(--v-theme-primary));
}

.agent-setting-description {
  margin-top: 2px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.74rem;
  line-height: 1.4;
}
</style>
