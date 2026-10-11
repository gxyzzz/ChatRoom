<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useLocale } from "vuetify";
import type { AgentModel, AgentProviderStatus } from "../api.js";
import type {
  ReasoningSummary,
  ApprovalPolicyMode,
  GranularApproval,
  ApprovalsReviewer,
  PermissionMode,
} from "../utils/agent-config.js";
import { defaultAgentSettingLabel } from "../utils/agent-display.js";
type NativeSetting = AgentProviderStatus["nativeSettings"][number];

const props = withDefaults(
  defineProps<{
    model: AgentModel | null;
    approvalSetting: NativeSetting | null;
    reviewerSetting: NativeSetting | null;
    permissionSetting: NativeSetting | null;
    disabled?: boolean;
    outlined?: boolean;
  }>(),
  {
    disabled: false,
    outlined: false,
  },
);

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
const granular = defineModel<GranularApproval>("granular", {
  required: true,
});
const reviewer = defineModel<ApprovalsReviewer>("reviewer", { required: true });
const permissionMode = defineModel<PermissionMode>("permissionMode", {
  required: true,
});

const locale = useLocale();
const pendingPermissionMode = shallowRef<PermissionMode>(null);
const fieldVariantProps = computed(() =>
  props.outlined ? ({ variant: "outlined" } as const) : {},
);

const summaryItems = computed(() => [
  {
    title: defaultSettingLabel(
      props.model?.defaultReasoningSummary
        ? summaryLabel(props.model.defaultReasoningSummary)
        : null,
    ),
    value: null,
    subtitle: "",
  },
  ...(props.model?.reasoningSummaries ?? []).map((value) => ({
    title: summaryLabel(value),
    value,
    subtitle: "",
  })),
]);

const tierItems = computed(() => {
  const tiers = props.model?.serviceTiers ?? [];
  return [
    {
      title: defaultSettingLabel(
        tiers.find((tier) => tier.id === props.model?.defaultServiceTier)
          ?.name ?? props.model?.defaultServiceTier,
      ),
      value: null,
      subtitle: "",
    },
    ...tiers.map((tier) => ({
      title: tier.name,
      value: tier.id,
      subtitle: tier.description,
    })),
  ];
});

function nativeSettingItems(setting: NativeSetting | null) {
  return (setting?.options ?? []).map((option) => ({
    title: `${nativeOptionLabel(option.id, "title")} (${option.id})`,
    value: option.id,
    subtitle: nativeOptionLabel(
      option.id,
      "description",
      option.description ?? "",
    ),
  }));
}

const nativeOptionKeys: Record<string, string> = {
  untrusted: "untrusted",
  "on-request": "onRequest",
  granular: "granular",
  never: "never",
  user: "user",
  auto_review: "autoReview",
  guardian_subagent: "autoReview",
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "fullAccessCodex",
};

function nativeOptionLabel(
  id: string,
  field: "title" | "description",
  fallback = id,
): string {
  const key = nativeOptionKeys[id];
  return key
    ? locale.t(`$vuetify.chatroom.agents.nativeOptions.${key}.${field}`)
    : fallback;
}

function setPermissionMode(value: PermissionMode) {
  if (value === permissionMode.value) return;
  if (value === "danger-full-access") {
    pendingPermissionMode.value = value;
    return;
  }
  permissionMode.value = value;
}

function confirmPermissionMode() {
  const value = pendingPermissionMode.value;
  pendingPermissionMode.value = null;
  if (!value) return;
  if (value === "danger-full-access") approvalMode.value = "never";
  permissionMode.value = value;
}

function summaryLabel(value: ReasoningSummary): string {
  return locale.t(`$vuetify.chatroom.agents.summaries.${value}`);
}

function defaultSettingLabel(officialDefault?: string | null): string {
  return defaultAgentSettingLabel(
    locale.t("$vuetify.chatroom.agents.defaultModel"),
    officialDefault,
  );
}

function granularValue(field: string): boolean {
  return field in granular.value
    ? granular.value[field as keyof GranularApproval]
    : false;
}

function setGranular(field: string, value: boolean) {
  if (!(field in granular.value)) return;
  granular.value = {
    ...granular.value,
    [field]: value,
  };
}
</script>

<template>
  <v-select
    v-if="model?.reasoningSummaries?.length"
    v-model="reasoningSummary"
    :items="summaryItems"
    :label="locale.t('$vuetify.chatroom.agents.reasoningSummary')"
    density="compact"
    v-bind="fieldVariantProps"
    hide-details
    :disabled="disabled"
  >
    <template #item="{ props: itemProps, item }">
      <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
    </template>
  </v-select>

  <v-select
    v-if="model?.serviceTiers?.length"
    v-model="serviceTier"
    :items="tierItems"
    :label="locale.t('$vuetify.chatroom.agents.serviceTier')"
    density="compact"
    v-bind="fieldVariantProps"
    hide-details
    :disabled="disabled"
  >
    <template #item="{ props: itemProps, item }">
      <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
    </template>
  </v-select>

  <v-select
    v-if="approvalSetting"
    v-model="approvalMode"
    :items="nativeSettingItems(approvalSetting)"
    :label="locale.t('$vuetify.chatroom.agents.approvalPolicy')"
    density="compact"
    v-bind="fieldVariantProps"
    hide-details
    :disabled="disabled"
  >
    <template #item="{ props: itemProps, item }">
      <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
    </template>
  </v-select>

  <div
    v-if="approvalSetting && approvalMode === 'granular'"
    class="agent-native-granular"
  >
    <div class="agent-setting-heading">
      {{ locale.t("$vuetify.chatroom.agents.granularApprovals") }}
    </div>
    <v-switch
      v-for="field in approvalSetting.granularFields"
      :key="field.id"
      :model-value="granularValue(field.id)"
      :label="field.id"
      :title="field.description ?? undefined"
      density="compact"
      color="primary"
      hide-details
      :disabled="disabled"
      @update:model-value="setGranular(field.id, Boolean($event))"
    />
  </div>

  <v-select
    v-if="reviewerSetting"
    v-model="reviewer"
    :items="nativeSettingItems(reviewerSetting)"
    :label="locale.t('$vuetify.chatroom.agents.approvalsReviewer')"
    density="compact"
    v-bind="fieldVariantProps"
    hide-details
    :disabled="disabled"
  >
    <template #item="{ props: itemProps, item }">
      <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
    </template>
  </v-select>

  <v-select
    v-if="permissionSetting"
    :model-value="permissionMode"
    :items="nativeSettingItems(permissionSetting)"
    :label="locale.t('$vuetify.chatroom.agents.permissionMode')"
    density="compact"
    v-bind="fieldVariantProps"
    hide-details
    :disabled="disabled"
    @update:model-value="setPermissionMode"
  >
    <template #item="{ props: itemProps, item }">
      <v-list-item v-bind="itemProps" :subtitle="item.subtitle" />
    </template>
  </v-select>

  <v-dialog
    :model-value="pendingPermissionMode !== null"
    width="auto"
    max-width="32rem"
    @update:model-value="
      (value) => {
        if (!value) pendingPermissionMode = null;
      }
    "
  >
    <v-card>
      <v-card-item prepend-icon="$mdiAlertCircleOutline" class="text-warning">
        <v-card-title>{{
          locale.t("$vuetify.chatroom.agents.fullAccessTitle")
        }}</v-card-title>
      </v-card-item>
      <v-card-text>
        {{ locale.t("$vuetify.chatroom.agents.fullAccessConfirm") }}
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="pendingPermissionMode = null">
          {{ locale.t("$vuetify.chatroom.common.cancel") }}
        </v-btn>
        <v-btn color="warning" variant="flat" @click="confirmPermissionMode">
          {{ locale.t("$vuetify.chatroom.common.confirm") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.agent-native-granular {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
}

.agent-native-granular .agent-setting-heading {
  margin-bottom: 2px;
}

.agent-native-granular :deep(.v-switch) {
  min-height: 34px;
}

.agent-setting-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 0.82rem;
}
</style>
