import { onBeforeUnmount, onMounted, shallowRef, watch } from "vue";
import { api, type LogLevel, type LogPage, type LogRecord } from "../api.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";
import { rtcConnected } from "../transport/rtc.js";

const PAGE_SIZE = 100;
const MAX_VISIBLE_RECORDS = 1000;

export function useSystemLogs() {
  const records = shallowRef<LogRecord[]>([]);
  const selected = shallowRef<LogRecord | null>(null);
  const level = shallowRef<LogLevel | "all">("all");
  const module = shallowRef("all");
  const nextCursor = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const loadingMore = shallowRef(false);
  const error = shallowRef("");
  const limitReached = shallowRef(false);

  const listRequests = createRequestGate();
  const moreRequests = createRequestGate();
  const liveDuringLoad = new Map<string, LogRecord>();
  let stream: EventSource | null = null;
  let ready = false;

  watch(rtcConnected, (connected) => {
    if (connected && ready) connectStream();
  });

  watch([level, module], () => {
    if (ready) void loadInitial();
  });

  onMounted(() => {
    ready = true;
    connectStream();
    void loadInitial();
  });

  onBeforeUnmount(() => {
    ready = false;
    stream?.close();
    stream = null;
  });

  async function loadInitial() {
    moreRequests.invalidate();
    loadingMore.value = false;
    liveDuringLoad.clear();
    const request = listRequests.begin();
    loading.value = true;
    error.value = "";
    limitReached.value = false;

    try {
      const page = await api<LogPage>(logsUrl(level.value, module.value), {
        signal: request.signal,
      });
      if (!listRequests.isCurrent(request)) return;
      const merged = mergeRecords(page.items, [...liveDuringLoad.values()]);
      records.value = merged.slice(0, MAX_VISIBLE_RECORDS);
      limitReached.value =
        merged.length > MAX_VISIBLE_RECORDS ||
        (records.value.length >= MAX_VISIBLE_RECORDS &&
          page.nextCursor !== null);
      nextCursor.value = limitReached.value ? null : page.nextCursor;
      if (selected.value) {
        selected.value =
          records.value.find((item) => item.id === selected.value?.id) ?? null;
      }
      liveDuringLoad.clear();
    } catch (cause) {
      if (listRequests.isCurrent(request)) error.value = errorMessage(cause);
    } finally {
      if (listRequests.isCurrent(request)) loading.value = false;
    }
  }

  async function loadMore() {
    if (loading.value || !nextCursor.value || loadingMore.value) return;
    const request = moreRequests.begin();
    const cursor = nextCursor.value;
    loadingMore.value = true;
    error.value = "";
    try {
      const page = await api<LogPage>(
        logsUrl(level.value, module.value, cursor),
        {
          signal: request.signal,
        },
      );
      if (!moreRequests.isCurrent(request)) return;
      const merged = mergeRecords(records.value, page.items);
      records.value = merged.slice(0, MAX_VISIBLE_RECORDS);
      limitReached.value =
        merged.length > MAX_VISIBLE_RECORDS ||
        (records.value.length >= MAX_VISIBLE_RECORDS &&
          page.nextCursor !== null);
      nextCursor.value = limitReached.value ? null : page.nextCursor;
    } catch (cause) {
      if (moreRequests.isCurrent(request)) error.value = errorMessage(cause);
    } finally {
      if (moreRequests.isCurrent(request)) loadingMore.value = false;
    }
  }

  function connectStream() {
    stream?.close();
    const source = new EventSource("/api/logs/stream");
    stream = source;
    source.addEventListener("open", () => {
      if (stream === source) void loadInitial();
    });
    source.addEventListener("log", (message) => {
      if (stream !== source) return;
      const record = parseLogEvent(message);
      if (!record || !matchesFilters(record)) return;

      if (loading.value) liveDuringLoad.set(record.id, record);
      const merged = mergeRecords([record], records.value);
      if (merged.length > MAX_VISIBLE_RECORDS) limitReached.value = true;
      records.value = merged.slice(0, MAX_VISIBLE_RECORDS);
      if (limitReached.value) nextCursor.value = null;

      if (selected.value?.id === record.id) selected.value = record;
    });
  }

  function matchesFilters(record: LogRecord): boolean {
    return (
      (level.value === "all" || record.level === level.value) &&
      (module.value === "all" || record.module === module.value)
    );
  }

  function select(record: LogRecord) {
    selected.value = record;
  }

  function clearSelection() {
    selected.value = null;
  }

  return {
    records,
    selected,
    level,
    module,
    nextCursor,
    loading,
    loadingMore,
    error,
    limitReached,
    loadInitial,
    loadMore,
    select,
    clearSelection,
  };
}

function mergeRecords(
  primary: readonly LogRecord[],
  secondary: readonly LogRecord[],
): LogRecord[] {
  const byId = new Map<string, LogRecord>();
  for (const record of secondary) byId.set(record.id, record);
  for (const record of primary) byId.set(record.id, record);
  return [...byId.values()].sort(
    (left, right) =>
      right.timestamp.localeCompare(left.timestamp) ||
      right.id.localeCompare(left.id),
  );
}

function parseLogEvent(event: Event): LogRecord | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string")
    return null;
  try {
    const value = JSON.parse(event.data) as LogRecord;
    return typeof value?.id === "string" && typeof value?.message === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

function logsUrl(
  level: LogLevel | "all",
  module: string,
  cursor?: string,
): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (level !== "all") params.set("level", level);
  if (module !== "all") params.set("module", module);
  if (cursor) params.set("cursor", cursor);
  return `/logs?${params}`;
}
