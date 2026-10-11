<script setup lang="ts">
import { computed } from "vue";
import { useLocale } from "vuetify";
import { useCloud } from "../composables/useCloud.js";
import { appIntlLocale } from "../locales.js";

const locale = useLocale();
const cloud = useCloud();
const {
  status,
  error,
  errorVisible,
  recoveryKey,
  restoring,
  refreshing,
  managing,
  busy,
  confirmationService,
  serviceUpdating,
  subscribed,
  subscriptionExpiry,
  refresh,
  manage,
  requestServiceChange,
  confirmDisableService,
  restore,
} = cloud;

const subscriptionDescription = computed(() => {
  if (!subscribed.value)
    return locale.t("$vuetify.chatroom.cloud.inactiveDescription");
  if (subscriptionExpiry.value === null)
    return locale.t("$vuetify.chatroom.cloud.active");
  return `${locale.t("$vuetify.chatroom.cloud.expires")} ${new Intl.DateTimeFormat(
    appIntlLocale(locale.current.value),
    { dateStyle: "medium", timeStyle: "short" },
  ).format(new Date(subscriptionExpiry.value))}`;
});

const confirmationTitle = computed(() =>
  confirmationService.value === "remote_web"
    ? locale.t("$vuetify.chatroom.cloud.disableWebTitle")
    : locale.t("$vuetify.chatroom.cloud.disableMcpTitle"),
);

const confirmationDescription = computed(() =>
  confirmationService.value === "remote_web"
    ? locale.t("$vuetify.chatroom.cloud.disableWebDescription")
    : locale.t("$vuetify.chatroom.cloud.disableMcpDescription"),
);
</script>

<template>
  <div class="cloud-view">
    <v-card class="panel-card cloud-panel">
      <v-alert
        v-if="status?.lastError"
        type="error"
        variant="tonal"
        density="compact"
        class="ma-3"
      >
        {{ status.lastError }}
      </v-alert>
      <template v-if="status && subscribed">
        <div class="cloud-row">
          <div class="cloud-row-main">
            <div class="cloud-row-title">
              {{ locale.t("$vuetify.chatroom.cloud.subscription") }}
            </div>
            <div class="cloud-row-value">{{ subscriptionDescription }}</div>
          </div>
          <div class="cloud-row-actions">
            <v-chip color="success" size="small" variant="tonal">
              {{ locale.t("$vuetify.chatroom.cloud.active") }}
            </v-chip>
            <v-btn
              icon="$mdiRefresh"
              size="small"
              variant="text"
              :loading="refreshing"
              :disabled="busy"
              :aria-label="locale.t('$vuetify.chatroom.cloud.refresh')"
              @click="refresh"
            />
            <v-btn
              variant="text"
              size="small"
              :disabled="!status.installationId || busy"
              :loading="managing"
              @click="manage"
            >
              {{ locale.t("$vuetify.chatroom.cloud.manage") }}
            </v-btn>
          </div>
        </div>
        <v-divider />

        <div class="cloud-row">
          <div class="cloud-row-main">
            <div class="cloud-row-title">
              {{ locale.t("$vuetify.chatroom.cloud.remoteMcp") }}
            </div>
            <div v-if="status.mcpUrl" class="cloud-row-value mono">
              {{ status.mcpUrl }}
            </div>
            <div v-else class="cloud-row-value">
              {{ locale.t("$vuetify.chatroom.cloud.remoteMcpDescription") }}
            </div>
          </div>
          <v-switch
            :model-value="status.desiredServices.remote_mcp"
            :loading="serviceUpdating === 'remote_mcp'"
            :disabled="busy"
            :aria-label="locale.t('$vuetify.chatroom.cloud.remoteMcp')"
            @update:model-value="
              requestServiceChange('remote_mcp', Boolean($event))
            "
          />
        </div>
        <v-divider />
        <div class="cloud-row">
          <div class="cloud-row-main">
            <div class="cloud-row-title">
              {{ locale.t("$vuetify.chatroom.cloud.remoteWeb") }}
            </div>
            <div v-if="status.webUrl" class="cloud-row-value mono">
              {{ status.webUrl }}
            </div>
            <div v-else class="cloud-row-value">
              {{ locale.t("$vuetify.chatroom.cloud.remoteWebDescription") }}
            </div>
          </div>
          <v-switch
            :model-value="status.desiredServices.remote_web"
            :loading="serviceUpdating === 'remote_web'"
            :disabled="busy"
            :aria-label="locale.t('$vuetify.chatroom.cloud.remoteWeb')"
            @update:model-value="
              requestServiceChange('remote_web', Boolean($event))
            "
          />
        </div>
      </template>

      <template v-else-if="status">
        <div class="cloud-row">
          <div class="cloud-row-main">
            <div class="cloud-row-title">
              {{ locale.t("$vuetify.chatroom.cloud.subscription") }}
            </div>
            <div class="cloud-row-value">{{ subscriptionDescription }}</div>
          </div>
          <v-btn
            color="primary"
            variant="flat"
            size="small"
            :disabled="!status.installationId || busy"
            :loading="managing"
            @click="manage"
          >
            {{ locale.t("$vuetify.chatroom.cloud.purchase") }}
          </v-btn>
        </div>
        <v-divider />
        <div class="cloud-restore-row">
          <v-text-field
            v-model="recoveryKey"
            :placeholder="locale.t('$vuetify.chatroom.cloud.recoveryKey')"
            :aria-label="locale.t('$vuetify.chatroom.cloud.recoveryKey')"
            type="password"
            density="compact"
            variant="outlined"
            hide-details
            autocomplete="off"
            @keyup.enter="restore"
          />
          <v-btn
            :loading="restoring"
            :disabled="!status.installationId || !recoveryKey.trim() || busy"
            variant="tonal"
            size="small"
            @click="restore"
          >
            {{ locale.t("$vuetify.chatroom.cloud.restoreAction") }}
          </v-btn>
        </div>
      </template>

      <div v-else class="cloud-loading">
        <v-progress-circular indeterminate size="20" width="2" />
      </div>

      <template v-if="status">
        <v-divider />
        <div class="cloud-row cloud-installation-row">
          <div class="cloud-row-main">
            <div class="cloud-row-title">
              {{ locale.t("$vuetify.chatroom.cloud.installationId") }}
            </div>
            <div class="cloud-row-value mono installation-id">
              {{ status.installationId || "—" }}
            </div>
          </div>
        </div>
      </template>
    </v-card>
  </div>

  <v-dialog
    :model-value="confirmationService !== null"
    width="auto"
    max-width="32rem"
    @update:model-value="!$event && (confirmationService = null)"
  >
    <v-card>
      <v-card-item prepend-icon="$mdiAlertCircleOutline" class="text-error">
        <v-card-title>{{ confirmationTitle }}</v-card-title>
      </v-card-item>
      <v-card-text>{{ confirmationDescription }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn
          variant="text"
          :disabled="busy"
          @click="confirmationService = null"
        >
          {{ locale.t("$vuetify.chatroom.common.cancel") }}
        </v-btn>
        <v-btn
          color="error"
          variant="flat"
          :loading="serviceUpdating === confirmationService"
          @click="confirmDisableService"
        >
          {{ locale.t("$vuetify.chatroom.cloud.disableConfirm") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-snackbar
    v-model="errorVisible"
    color="error"
    location="top"
    :timeout="6000"
  >
    {{ error }}
    <template #actions>
      <v-btn variant="text" @click="errorVisible = false">
        {{ locale.t("$vuetify.chatroom.common.close") }}
      </v-btn>
    </template>
  </v-snackbar>
</template>
<style>
.cloud-view {
  width: 100%;
}

.cloud-panel {
  width: 100%;
}

.cloud-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 10px 18px;
}

.cloud-row-main {
  min-width: 0;
}

.cloud-row-title {
  font-size: 14px;
  font-weight: 500;
}

.cloud-row-value {
  overflow: hidden;
  margin-top: 3px;
  color: rgb(var(--v-theme-on-surface), 0.52);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-row .v-switch,
.cloud-row .v-btn {
  flex: 0 0 auto;
}

.cloud-installation-row .cloud-row-main {
  min-width: 0;
}

.cloud-row-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.cloud-restore-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 12px 18px;
}

.cloud-loading {
  padding: 16px 18px;
}

@media (max-width: 640px) {
  .cloud-row-actions {
    gap: 2px;
  }
}

.installation-id {
  overflow-wrap: anywhere;
  white-space: normal;
}
</style>
