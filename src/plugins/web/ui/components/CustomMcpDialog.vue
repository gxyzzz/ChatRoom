<script setup lang="ts">
import { reactive, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { api, type CustomMcpServerSummary } from "../api.js";
import { errorMessage } from "../utils/errors.js";

const props = defineProps<{ server: CustomMcpServerSummary | null }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ saved: [] }>();
const locale = useLocale();
const t = (key: string) => locale.t("$vuetify.chatroom.customMcp." + key);
const busy = shallowRef(false);
const testing = shallowRef(false);
const advanced = shallowRef(false);
const error = shallowRef("");
const result = shallowRef("");
const resultNeedsAuth = shallowRef(false);
const form = reactive({
  name: "",
  type: "http" as "stdio" | "http",
  authMode: "auto" as "auto" | "none" | "headers",
  command: "",
  args: "",
  cwd: "",
  url: "",
  env: "",
  headers: "",
});
watch(
  [open, () => props.server],
  () => {
    if (!open.value) return;
    const server = props.server;
    Object.assign(form, {
      name: server?.name ?? "",
      type: server?.type ?? "http",
      authMode: server?.authMode ?? "auto",
      command: server?.command ?? "",
      args:
        server?.args
          ?.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))
          .join(" ") ?? "",
      cwd: server?.cwd ?? "",
      url: server?.url ?? "",
      env: "",
      headers: "",
    });
    advanced.value = false;
    error.value = "";
    result.value = "";
    resultNeedsAuth.value = false;
  },
  { immediate: true },
);

function parseMap(text: string): Record<string, string> {
  if (!text.trim()) return {};
  const data: unknown = JSON.parse(text);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.values(data).some((value) => typeof value !== "string")
  )
    throw new Error(t("invalidMap"));
  return data as Record<string, string>;
}

function parseArgs(value: string): string[] {
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string"))
      throw new Error(t("invalidArgs"));
    return parsed;
  }
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!quote && /\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (!quote) {
        quote = char;
        started = true;
      } else current += char;
    } else if (
      char === "\\" &&
      quote !== "'" &&
      i + 1 < text.length &&
      /[\s"'\\]/.test(text[i + 1]!)
    ) {
      current += text[++i]!;
      started = true;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error(t("invalidArgs"));
  if (started) args.push(current);
  return args;
}

function parseEnv(value: string): Record<string, string> {
  if (!value.trim()) return {};
  if (value.trim().startsWith("{")) return parseMap(value);
  const pairs: Record<string, string> = {};
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf("=");
    if (at <= 0) throw new Error(t("invalidEnv"));
    pairs[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return pairs;
}

function payload() {
  if (!form.name.trim()) throw new Error(t("nameRequired"));
  if (form.type === "http") {
    if (!form.url.trim()) throw new Error(t("urlRequired"));
    return {
      name: form.name.trim(),
      type: form.type,
      url: form.url.trim(),
      authMode: form.authMode,
      ...(form.authMode === "headers" && (form.headers.trim() || !props.server)
        ? { headers: parseMap(form.headers) }
        : {}),
      ...(!props.server ? { enabled: true } : {}),
    };
  }
  if (!form.command.trim()) throw new Error(t("commandRequired"));
  return {
    name: form.name.trim(),
    type: form.type,
    command: form.command.trim(),
    args: parseArgs(form.args),
    cwd: form.cwd.trim(),
    ...(form.env.trim() || !props.server ? { env: parseEnv(form.env) } : {}),
    ...(!props.server ? { enabled: true } : {}),
  };
}

async function save() {
  if (busy.value || testing.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(
      props.server
        ? "/mcp/servers/" + encodeURIComponent(props.server.id)
        : "/mcp/servers",
      {
        method: props.server ? "PATCH" : "POST",
        body: JSON.stringify(payload()),
        timeoutMs: 30000,
      },
    );
    open.value = false;
    emit("saved");
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function test() {
  if (testing.value || busy.value) return;
  testing.value = true;
  error.value = "";
  result.value = "";
  resultNeedsAuth.value = false;
  try {
    const response = await api<{ tools: number; authRequired?: boolean }>(
      props.server
        ? "/mcp/servers/" + encodeURIComponent(props.server.id) + "/test"
        : "/mcp/servers/test",
      {
        method: "POST",
        ...(!props.server ? { body: JSON.stringify(payload()) } : {}),
        timeoutMs: 25000,
      },
    );
    resultNeedsAuth.value = Boolean(response.authRequired);
    result.value = response.authRequired
      ? t("testAuthRequired")
      : t("testSuccess").replace("{0}", String(response.tools));
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="720" scrollable>
    <v-card>
      <v-card-title>{{ t(server ? "edit" : "add") }}</v-card-title>
      <v-card-text class="custom-mcp-form">
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{
          error
        }}</v-alert>
        <v-alert
          v-if="result"
          :type="resultNeedsAuth ? 'info' : 'success'"
          variant="tonal"
          density="compact"
          >{{ result }}</v-alert
        >
        <div
          class="custom-mcp-transport"
          role="group"
          :aria-label="t('transport')"
        >
          <v-btn
            size="small"
            rounded="lg"
            :variant="form.type === 'http' ? 'tonal' : 'outlined'"
            :color="form.type === 'http' ? 'primary' : undefined"
            :aria-pressed="form.type === 'http'"
            @click="form.type = 'http'"
            >{{ t("remote") }}</v-btn
          >
          <v-btn
            size="small"
            rounded="lg"
            :variant="form.type === 'stdio' ? 'tonal' : 'outlined'"
            :color="form.type === 'stdio' ? 'primary' : undefined"
            :aria-pressed="form.type === 'stdio'"
            @click="form.type = 'stdio'"
            >{{ t("local") }}</v-btn
          >
        </div>
        <v-text-field
          v-model="form.name"
          :label="t('name')"
          variant="outlined"
          density="comfortable"
          hide-details
        />
        <template v-if="form.type === 'http'">
          <v-text-field
            v-model="form.url"
            label="MCP Server URL"
            placeholder="https://example.com/mcp"
            variant="outlined"
            density="comfortable"
            hide-details
          />
          <v-select
            v-model="form.authMode"
            :label="t('authMode')"
            :items="[
              { title: t('authAuto'), value: 'auto' },
              { title: t('authNone'), value: 'none' },
              { title: t('authHeaders'), value: 'headers' },
            ]"
            variant="outlined"
            density="comfortable"
            hide-details
          />
          <v-textarea
            v-if="form.authMode === 'headers'"
            v-model="form.headers"
            :label="t('headers')"
            placeholder='{"X-API-Key":"..."}'
            rows="2"
            auto-grow
            variant="outlined"
            density="comfortable"
            hide-details
          />
          <div
            v-if="form.authMode === 'auto'"
            class="text-caption text-medium-emphasis"
          >
            {{ t("authHint") }}
          </div>
        </template>
        <template v-else>
          <v-text-field
            v-model="form.command"
            :label="t('command')"
            placeholder="npx"
            variant="outlined"
            density="comfortable"
            hide-details
          />
          <v-text-field
            v-model="form.args"
            :label="t('argsSimple')"
            placeholder="-y @modelcontextprotocol/server-filesystem /path"
            variant="outlined"
            density="comfortable"
            hide-details
          />
          <v-btn
            variant="text"
            size="small"
            class="align-self-start"
            @click="advanced = !advanced"
          >
            <v-icon
              :icon="advanced ? '$mdiChevronUp' : '$mdiChevronDown'"
              start
            />
            {{ t("advanced") }}
          </v-btn>
          <template v-if="advanced">
            <v-text-field
              v-model="form.cwd"
              :label="t('cwd')"
              variant="outlined"
              density="comfortable"
              hide-details
            />
            <v-textarea
              v-model="form.env"
              :label="t('envSimple')"
              placeholder="KEY=value"
              rows="2"
              auto-grow
              variant="outlined"
              density="comfortable"
              hide-details
            />
          </template>
        </template>
        <div
          v-if="server && (server.envKeys.length || server.headerKeys.length)"
          class="text-caption text-medium-emphasis"
        >
          {{ t("secretsHint") }}
          {{ [...server.envKeys, ...server.headerKeys].join(", ") }}
        </div>
      </v-card-text>
      <v-card-actions class="flex-wrap">
        <v-btn
          variant="text"
          :loading="testing"
          :disabled="busy"
          @click="test"
          >{{ t("test") }}</v-btn
        >
        <v-spacer />
        <v-btn
          variant="text"
          :disabled="busy || testing"
          @click="open = false"
          >{{ t("cancel") }}</v-btn
        >
        <v-btn
          color="primary"
          :loading="busy"
          :disabled="testing"
          @click="save"
          >{{ t("save") }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.custom-mcp-transport {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.custom-mcp-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
}
</style>
