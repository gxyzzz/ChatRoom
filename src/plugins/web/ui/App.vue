<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  watch,
} from "vue";
import { useDisplay, useLocale } from "vuetify";
import LoginView from "./components/LoginView.vue";
const TerminalView = defineAsyncComponent(
  () => import("./components/TerminalView.vue"),
);
import {
  rtcConnected,
  rtcIceRoute,
  startRtc,
  stopRtc,
} from "./transport/rtc.js";
import WorkspaceDownloadPage from "./components/WorkspaceDownloadPage.vue";
import {
  downloadProgress,
  cancelDownload,
  dismissDownload,
} from "./utils/download.js";
import { bytes } from "./utils.js";
import PasskeyManagerDialog from "./components/PasskeyManagerDialog.vue";
import { useAppNavigation, type View } from "./composables/useAppNavigation.js";
import { useAppPreferences } from "./composables/useAppPreferences.js";
import { useAuthSession } from "./composables/useAuthSession.js";
import { useRuntimeEvents } from "./composables/useRuntimeEvents.js";

const locale = useLocale();
const isDownloadPage = window.location.pathname === "/download";
const display = useDisplay();
const drawer = shallowRef(!display.smAndDown.value);
const terminalVisible = shallowRef(false);
const terminalActivated = shallowRef(false);
const terminalHeight = shallowRef(300);
let stopTerminalResize: (() => void) | null = null;
function toggleTerminal(): void {
  terminalVisible.value = !terminalVisible.value;
  if (terminalVisible.value) terminalActivated.value = true;
}
function beginTerminalResize(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  stopTerminalResize?.();
  const startY = event.clientY;
  const original = terminalHeight.value;
  const resize = (next: PointerEvent) => {
    terminalHeight.value = Math.max(
      145,
      Math.min(window.innerHeight * 0.75, original + startY - next.clientY),
    );
  };
  const stop = () => {
    window.removeEventListener("pointermove", resize);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    stopTerminalResize = null;
  };
  stopTerminalResize = stop;
  window.addEventListener("pointermove", resize);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}
function terminalShortcut(event: KeyboardEvent): void {
  if (
    event.code !== "Backquote" ||
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    isDownloadPage ||
    !authenticated.value
  )
    return;
  event.preventDefault();
  toggleTerminal();
}
onMounted(() => window.addEventListener("keydown", terminalShortcut));
onBeforeUnmount(() => {
  stopTerminalResize?.();
  window.removeEventListener("keydown", terminalShortcut);
});

const navigation = useAppNavigation(!isDownloadPage);
const runtimeState = useRuntimeEvents();
const preferences = useAppPreferences();
const auth = useAuthSession({
  onAuthenticated: () => {
    if (!isDownloadPage) runtimeState.start();
    startRtc();
  },
  onSignedOut: () => {
    runtimeState.clear();
    stopRtc();
    if (!isDownloadPage) navigation.reset();
    drawer.value = !display.smAndDown.value;
  },
});

const { view, current, definitions: nav, prefetch } = navigation;
const {
  runtime,
  updateStatus,
  processRevision,
  processChanges,
  operationRevision,
  operationChanges,
  computerRevision,
  computerChanges,
  agentRevision,
  agentChanges,
  connectionState,
  latencyMs,
} = runtimeState;
const { themeMode, themeIcon, languageName, setThemeMode, setLocale } =
  preferences;
const {
  authenticated,
  canUsePasskeys,
  passkeyRegistered,
  passkeyBusy,
  loginBusy,
  passkeyDialog,
  passkeys,
  passkeyName,
  token,
  remember,
  loginError,
  passkeyError,
  login,
  loginWithPasskey,
  logout,
  openPasskeyManager,
  registerPasskey,
  removePasskey,
} = auth;

const currentTitle = computed(() =>
  locale.t(`$vuetify.chatroom.${current.value.titleKey}`),
);
const currentComponent = computed(() => current.value.component);
const currentProps = computed<Record<string, unknown>>(() => {
  switch (view.value) {
    case "processes":
      return {
        revision: processRevision.value,
        changes: processChanges.value,
      };
    case "operations":
      return {
        revision: operationRevision.value,
        changes: operationChanges.value,
      };
    case "computer":
      return {
        revision: computerRevision.value,
        changes: computerChanges.value,
      };
    case "agents":
      return {
        revision: agentRevision.value,
        changes: agentChanges.value,
      };
    default:
      return {};
  }
});

watch(
  () => display.smAndDown.value,
  (compact) => {
    drawer.value = !compact;
  },
);

watch(
  currentTitle,
  (title) => {
    document.title = `${title} · ChatRoom`;
  },
  { immediate: true },
);

function navigate(next: View) {
  prefetch(next);
  navigation.navigate(next);
  if (display.smAndDown.value) drawer.value = false;
}

function formatUptime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return locale.t(
    "$vuetify.chatroom.runtime.uptimeHoursMinutes",
    hours,
    minutes,
  );
}
</script>

<template>
  <v-app
    class="app-shell"
    :class="{
      'app-shell--contained':
        authenticated &&
        !isDownloadPage &&
        (view === 'agents' ||
          (view === 'processes' && display.width.value > 1100) ||
          (view === 'workspaces' && display.width.value > 820) ||
          ((view === 'operations' || view === 'systemLogs') &&
            display.width.value > 1100)),
    }"
  >
    <template v-if="authenticated && !isDownloadPage">
      <v-navigation-drawer
        v-model="drawer"
        :temporary="display.smAndDown.value"
        class="app-drawer"
        border="e"
      >
        <v-list nav density="comfortable" class="nav-list">
          <v-list-item
            v-for="item in nav"
            :key="item.id"
            :active="view === item.id"
            :aria-current="view === item.id ? 'page' : undefined"
            :prepend-icon="item.icon"
            :title="locale.t(`$vuetify.chatroom.${item.titleKey}`)"
            rounded="lg"
            @mouseenter="prefetch(item.id)"
            @focus="prefetch(item.id)"
            @click="navigate(item.id)"
          />
        </v-list>

        <template #append>
          <div class="drawer-runtime">
            <div class="drawer-runtime-row">
              <span>{{ locale.t("$vuetify.chatroom.runtime.version") }}</span>
              <div class="drawer-version-value">
                <strong>{{ runtime?.version ?? "—" }}</strong>
                <v-chip
                  v-if="updateStatus?.updateAvailable"
                  size="x-small"
                  color="primary"
                  variant="tonal"
                  :href="updateStatus.releaseUrl ?? undefined"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="
                    locale.t(
                      '$vuetify.chatroom.runtime.updateTitle',
                      updateStatus.latestVersion ?? '',
                    )
                  "
                >
                  {{ locale.t("$vuetify.chatroom.runtime.updateAvailable") }}
                </v-chip>
              </div>
            </div>
            <div class="drawer-runtime-row">
              <span>{{
                locale.t("$vuetify.chatroom.runtime.mcpRequests")
              }}</span>
              <strong>{{ runtime?.mcpRequests ?? "—" }}</strong>
            </div>
            <div class="drawer-runtime-row">
              <span>{{ locale.t("$vuetify.chatroom.runtime.uptime") }}</span>
              <strong>{{
                runtime ? formatUptime(runtime.uptimeMinutes) : "—"
              }}</strong>
            </div>
          </div>
          <div class="drawer-actions">
            <v-btn
              v-if="canUsePasskeys"
              icon="$mdiFingerprint"
              variant="text"
              size="small"
              :aria-label="locale.t('$vuetify.chatroom.auth.passkeys')"
              @click="openPasskeyManager"
            />

            <v-menu location="top start">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  icon="$mdiTranslate"
                  variant="text"
                  size="small"
                  :aria-label="locale.t('$vuetify.chatroom.common.language')"
                />
              </template>
              <v-list density="compact">
                <v-list-item
                  :title="locale.t('$vuetify.chatroom.common.languages.zhHans')"
                  :active="locale.current.value === 'zhHans'"
                  @click="setLocale('zhHans')"
                />
                <v-list-item
                  :title="locale.t('$vuetify.chatroom.common.languages.zhHant')"
                  :active="locale.current.value === 'zhHant'"
                  @click="setLocale('zhHant')"
                />
                <v-list-item
                  :title="locale.t('$vuetify.chatroom.common.languages.en')"
                  :active="locale.current.value === 'en'"
                  @click="setLocale('en')"
                />
              </v-list>
            </v-menu>

            <v-menu location="top start">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  :icon="themeIcon"
                  variant="text"
                  size="small"
                  :aria-label="locale.t('$vuetify.chatroom.common.theme')"
                />
              </template>
              <v-list density="compact">
                <v-list-item
                  prepend-icon="$mdiThemeLightDark"
                  :title="locale.t('$vuetify.chatroom.theme.system')"
                  :active="themeMode === 'system'"
                  @click="setThemeMode('system')"
                />
                <v-list-item
                  prepend-icon="$mdiWeatherSunny"
                  :title="locale.t('$vuetify.chatroom.theme.light')"
                  :active="themeMode === 'light'"
                  @click="setThemeMode('light')"
                />
                <v-list-item
                  prepend-icon="$mdiWeatherNight"
                  :title="locale.t('$vuetify.chatroom.theme.dark')"
                  :active="themeMode === 'dark'"
                  @click="setThemeMode('dark')"
                />
              </v-list>
            </v-menu>

            <v-btn
              icon="$mdiLogout"
              variant="text"
              size="small"
              :aria-label="locale.t('$vuetify.chatroom.common.signOut')"
              @click="logout"
            />
          </div>
        </template>
      </v-navigation-drawer>

      <v-app-bar flat class="app-bar">
        <v-app-bar-nav-icon @click="drawer = !drawer" />
        <v-app-bar-title class="page-title">
          {{ currentTitle }}
        </v-app-bar-title>
        <template #append>
          <v-btn
            icon="$mdiConsoleLine"
            class="me-3"
            size="small"
            variant="text"
            :active="terminalVisible"
            :aria-label="locale.t('$vuetify.chatroom.terminal.title')"
            :aria-pressed="terminalVisible"
            @click="toggleTerminal"
          />
          <div
            class="connection-state"
            :data-state="connectionState"
            role="status"
            aria-live="polite"
          >
            <span class="connection-dot" aria-hidden="true" />
            <span class="connection-state-label">
              {{
                locale.t(
                  `$vuetify.chatroom.common.connection.${connectionState}`,
                )
              }}
              <template
                v-if="connectionState === 'connected' && latencyMs !== null"
              >
                · {{ latencyMs }} ms
              </template>
              <template v-if="rtcConnected">
                ·
                <span :title="rtcIceRoute ? `ICE: ${rtcIceRoute}` : ''"
                  >P2P</span
                >
              </template>
            </span>
          </div>
        </template>
      </v-app-bar>

      <v-main :class="{ 'app-main--terminal-visible': terminalVisible }">
        <v-container fluid class="app-content">
          <component :is="currentComponent" v-bind="currentProps" />
        </v-container>
        <section
          v-if="terminalActivated"
          v-show="terminalVisible"
          class="app-terminal-panel"
          :style="{ height: terminalHeight + 'px' }"
        >
          <div
            class="app-terminal-resize"
            role="separator"
            aria-orientation="horizontal"
            :aria-label="locale.t('$vuetify.chatroom.terminal.resize')"
            @pointerdown="beginTerminalResize"
          />
          <TerminalView :visible="terminalVisible" @hide="toggleTerminal" />
        </section>
      </v-main>
    </template>

    <WorkspaceDownloadPage v-else-if="authenticated && isDownloadPage" />

    <LoginView
      v-else-if="authenticated === false"
      v-model:token="token"
      v-model:remember="remember"
      :can-use-passkeys="canUsePasskeys"
      :passkey-registered="passkeyRegistered"
      :passkey-busy="passkeyBusy"
      :login-busy="loginBusy"
      :login-error="loginError"
      :language-name="languageName"
      :theme-icon="themeIcon"
      @login="login"
      @passkey-login="loginWithPasskey"
      @locale="setLocale"
      @theme="setThemeMode"
    />

    <v-main v-else class="login-page">
      <v-progress-circular indeterminate color="primary" />
    </v-main>

    <v-snackbar
      :model-value="downloadProgress !== null"
      :timeout="-1"
      location="bottom end"
      color="surface"
      elevation="4"
    >
      <template v-if="downloadProgress">
        <div class="text-body-2 text-truncate" :title="downloadProgress.name">
          {{ downloadProgress.name }}
        </div>
        <div class="text-caption text-medium-emphasis">
          {{
            locale.t(
              `$vuetify.chatroom.files.downloadPhase.${downloadProgress.phase}`,
            )
          }}
          <template v-if="downloadProgress.phase === 'transferring'">
            · {{ downloadProgress.mode === "p2p" ? "P2P" : "HTTP" }} ·
            {{ bytes(downloadProgress.received) }}
            <template v-if="downloadProgress.total !== null">
              / {{ bytes(downloadProgress.total) }}
            </template>
            · {{ bytes(downloadProgress.speed) }}/s
          </template>
          <template v-if="downloadProgress.error">
            · {{ downloadProgress.error }}
          </template>
        </div>
        <v-progress-linear
          v-if="downloadProgress.phase === 'transferring'"
          class="mt-2"
          color="primary"
          :model-value="
            downloadProgress.total !== null && downloadProgress.total > 0
              ? (downloadProgress.received / downloadProgress.total) * 100
              : 0
          "
          :indeterminate="downloadProgress.total === null"
          height="3"
          rounded
        />
      </template>
      <template #actions>
        <v-btn
          v-if="downloadProgress?.phase === 'transferring'"
          variant="text"
          size="small"
          @click="cancelDownload"
        >
          {{ locale.t("$vuetify.chatroom.common.cancel") }}
        </v-btn>
        <v-btn v-else variant="text" size="small" @click="dismissDownload">
          {{ locale.t("$vuetify.chatroom.common.close") }}
        </v-btn>
      </template>
    </v-snackbar>

    <PasskeyManagerDialog
      v-model:open="passkeyDialog"
      v-model:name="passkeyName"
      :passkeys="passkeys"
      :busy="passkeyBusy"
      :error="passkeyError"
      @add="registerPasskey"
      @remove="removePasskey"
    />
  </v-app>
</template>

<style scoped>
.app-main--terminal-visible {
  display: flex;
  flex-direction: column;
  block-size: calc(
    100dvh - var(--v-layout-top, 0px) - var(--v-layout-bottom, 0px)
  );
  min-block-size: 0;
  overflow: hidden;
}
.app-main--terminal-visible > .app-content {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow: auto;
}
.app-terminal-panel {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid rgb(var(--v-theme-outline), 0.16);
  background: rgb(var(--v-theme-surface));
}
.app-terminal-resize {
  position: relative;
  flex: 0 0 6px;
  cursor: row-resize;
  touch-action: none;
}
.app-terminal-resize::after {
  content: "";
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: 48%;
  inline-size: 4%;
  block-size: 2px;
  border-radius: 2px;
  background: rgb(var(--v-theme-on-surface), 0.22);
}
</style>
