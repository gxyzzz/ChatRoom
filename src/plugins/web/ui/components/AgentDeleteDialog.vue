<script setup lang="ts">
import { useLocale } from "vuetify";

const props = withDefaults(defineProps<{ busy?: boolean; count?: number }>(), {
  count: 1,
});
defineEmits<{ confirm: [] }>();
const open = defineModel<boolean>({ required: true });
const locale = useLocale();
</script>

<template>
  <v-dialog v-model="open" width="auto" max-width="32rem" :persistent="busy">
    <v-card>
      <v-card-item prepend-icon="$mdiAlertCircleOutline" class="text-error">
        <v-card-title>
          {{
            locale.t(
              props.count > 1
                ? "$vuetify.chatroom.agents.bulkDeleteTitle"
                : "$vuetify.chatroom.agents.deleteTitle",
            )
          }}
        </v-card-title>
      </v-card-item>
      <v-card-text>
        {{
          locale.t(
            props.count > 1
              ? "$vuetify.chatroom.agents.bulkDeleteDescription"
              : "$vuetify.chatroom.agents.deleteDescription",
            props.count,
          )
        }}
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="open = false">
          {{ locale.t("$vuetify.chatroom.common.cancel") }}
        </v-btn>
        <v-btn
          color="error"
          variant="flat"
          :loading="busy"
          @click="$emit('confirm')"
        >
          {{
            locale.t(
              props.count > 1
                ? "$vuetify.chatroom.agents.deleteSelected"
                : "$vuetify.chatroom.agents.delete",
            )
          }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
