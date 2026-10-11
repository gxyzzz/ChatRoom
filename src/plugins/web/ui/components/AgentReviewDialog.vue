<script setup lang="ts">
import { useLocale } from "vuetify";
import type { AgentReviewTarget } from "../../api-types.js";

defineProps<{
  types: Array<{ title: string; value: AgentReviewTarget["type"] }>;
  fieldLabel: string;
  busy: boolean;
  error: string;
  canStart: boolean;
}>();

defineEmits<{ start: [] }>();

const open = defineModel<boolean>({ required: true });
const reviewType = defineModel<AgentReviewTarget["type"]>("reviewType", {
  required: true,
});
const reviewValue = defineModel<string>("reviewValue", { required: true });
const reviewTitle = defineModel<string>("reviewTitle", { required: true });
const locale = useLocale();
</script>

<template>
  <v-dialog v-model="open" :persistent="busy">
    <v-card>
      <v-card-item prepend-icon="$mdiFileCompare">
        <v-card-title>{{
          locale.t("$vuetify.chatroom.agents.review")
        }}</v-card-title>
      </v-card-item>
      <v-card-text class="agent-review-fields">
        <v-select
          v-model="reviewType"
          :items="types"
          :label="locale.t('$vuetify.chatroom.agents.reviewTarget')"
          :disabled="busy"
          density="compact"
          hide-details
        />
        <v-text-field
          v-if="reviewType !== 'uncommittedChanges'"
          v-model="reviewValue"
          :label="fieldLabel"
          :disabled="busy"
          density="compact"
          hide-details
          @keydown.enter.prevent="$emit('start')"
        />
        <v-text-field
          v-if="reviewType === 'commit'"
          v-model="reviewTitle"
          :label="locale.t('$vuetify.chatroom.agents.reviewCommitTitle')"
          :disabled="busy"
          density="compact"
          hide-details
        />
        <div v-if="error" class="agent-review-error" role="alert">
          {{ error }}
        </div>
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
          :disabled="!canStart"
          @click="$emit('start')"
        >
          {{ locale.t("$vuetify.chatroom.agents.startReview") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.agent-review-fields {
  display: grid;
  gap: 14px;
}

.agent-review-error {
  color: rgb(var(--v-theme-error));
}
</style>
