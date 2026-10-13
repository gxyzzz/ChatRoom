<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import { downloadContent } from "../utils/download.js";

const HIGHLIGHT_MAX_CHARS = 200_000;
const SEARCH_DEBOUNCE_MS = 120;

const props = withDefaults(
  defineProps<{
    value?: unknown;
    text?: string;
    filename?: string;
    language?: string;
    toolbar?: boolean;
    showDownload?: boolean;
    highlight?: boolean;
  }>(),
  {
    filename: "chatroom-output.txt",
    toolbar: true,
    showDownload: true,
    highlight: true,
  },
);
const query = shallowRef("");
const effectiveQuery = shallowRef("");
const wrap = shallowRef(true);
const highlighted = shallowRef<string | null>(null);
const locale = useLocale();
const copyError = shallowRef("");
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let highlightGeneration = 0;

const source = computed(
  () => props.text ?? JSON.stringify(props.value ?? null, null, 2),
);
const display = computed(() => {
  const needle = effectiveQuery.value.toLocaleLowerCase();
  if (!needle) return source.value;
  return source.value
    .split("\n")
    .filter((line) => line.toLocaleLowerCase().includes(needle))
    .join("\n");
});

watch(query, (value) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    effectiveQuery.value = value;
    searchTimer = null;
  }, SEARCH_DEBOUNCE_MS);
});

watch(
  [
    display,
    () => props.filename,
    () => props.language,
    () => props.value !== undefined,
    () => props.highlight,
  ],
  async (_values, _previous, onCleanup) => {
    const generation = ++highlightGeneration;
    onCleanup(() => {
      highlightGeneration += 1;
    });
    highlighted.value = null;
    const text = display.value;
    if (!props.highlight || !text || text.length > HIGHLIGHT_MAX_CHARS) {
      return;
    }
    const options = {
      filename: props.filename,
      language: props.language ?? (props.value !== undefined ? "json" : null),
    };
    try {
      const { highlightSource } = await import("../syntax-highlight.js");
      if (generation !== highlightGeneration) return;
      highlighted.value = highlightSource(text, options);
    } catch {
      // Keep the current plain text if the optional highlighter cannot load.
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  highlightGeneration += 1;
});

async function copy() {
  copyError.value = "";
  try {
    await navigator.clipboard.writeText(source.value);
  } catch {
    copyError.value = locale.t("$vuetify.chatroom.code.copyFailed");
  }
}
function download() {
  downloadContent(
    new Blob([source.value], { type: "text/plain;charset=utf-8" }),
    props.filename,
  );
}
</script>

<template>
  <v-sheet
    :border="toolbar"
    :rounded="toolbar ? 'lg' : 0"
    overflow-hidden
    class="code-viewer"
    :class="{ 'code-viewer-plain': !toolbar }"
  >
    <template v-if="toolbar">
      <div class="code-toolbar">
        <v-text-field
          v-model="query"
          :placeholder="locale.t('$vuetify.chatroom.code.search')"
          :aria-label="locale.t('$vuetify.chatroom.code.search')"
          prepend-inner-icon="$mdiMagnify"
          density="compact"
          hide-details
          class="code-search"
        />
        <v-spacer />
        <div class="code-actions">
          <v-btn
            icon="$mdiContentCopy"
            size="small"
            variant="text"
            :aria-label="locale.t('$vuetify.chatroom.code.copy')"
            @click="copy"
          />
          <v-btn
            :icon="wrap ? '$mdiWrap' : '$mdiFormatAlignLeft'"
            size="small"
            variant="text"
            :aria-label="
              locale.t(
                wrap
                  ? '$vuetify.chatroom.code.disableWrap'
                  : '$vuetify.chatroom.code.enableWrap',
              )
            "
            @click="wrap = !wrap"
          />
          <v-btn
            v-if="showDownload"
            icon="$mdiDownloadOutline"
            size="small"
            variant="text"
            :aria-label="locale.t('$vuetify.chatroom.code.download')"
            @click="download"
          />
        </div>
      </div>
      <v-divider />
    </template>
    <div v-if="copyError" class="code-copy-error" role="alert">
      {{ copyError }}
    </div>
    <pre class="code-block" :class="{ wrap }"><code
      v-if="highlighted"
      class="hljs"
      v-html="highlighted"
    /><code v-else>{{ display || locale.t("$vuetify.chatroom.code.noOutput") }}</code></pre>
  </v-sheet>
</template>
