import type { EnChatRoomMessages } from "./en.js";
import type { AppLocale } from "./types.js";

type ActionKey = keyof EnChatRoomMessages["actions"];
type SourceKey = keyof EnChatRoomMessages["sources"];
type StatusKey = keyof EnChatRoomMessages["statuses"];

const actionKeys: Record<string, ActionKey> = {
  "workspace:list": "workspaceList",
  "workspace:info": "workspaceInfo",
  "workspace:create": "workspaceCreate",
  "workspace:file.get": "workspaceFileGet",
  "workspace:file.write": "workspaceFileWrite",
  "workspace:attachment.upload": "workspaceAttachmentUpload",
  "git:git.stage": "gitStage",
  "git:git.unstage": "gitUnstage",
  "git:git.restore": "gitRestore",
  "git:git.commit": "gitCommit",
  "git:git.branch.create": "gitBranchCreate",
  "git:git.branch.switch": "gitBranchSwitch",
  "git:git.branch.delete": "gitBranchDelete",
  "git:git.fetch": "gitFetch",
  "git:git.pull": "gitPull",
  "git:git.push": "gitPush",
  "process:start": "startProcess",
  "process:read": "readProcess",
  "process:write": "writeProcess",
  "process:terminate": "terminateProcess",
  "process:kill": "forceStopProcess",
  "computer:snapshot": "computerSnapshot",
  "computer:action": "computerAction",
  "computer:settings.set": "computerSettings",
  "agent:providers": "agentProviders",
  "agent:provider_details": "agentProviderDetails",
  "agent:models": "agentModels",
  "agent:sessions": "agentSessions",
  "agent:create": "agentCreate",
  "agent:send": "agentSend",
  "agent:steer": "agentSteer",
  "agent:review": "agentReview",
  "agent:history": "agentHistory",
  "agent:configure": "agentConfigure",
  "agent:respond": "agentRespond",
  "agent:interrupt": "agentInterrupt",
  "agent:switch_provider": "agentSwitchProvider",
  "cloud:sync": "syncCloud",
  "cloud:management": "manageCloud",
  "cloud:restore": "restoreCloud",
  "cloud:recovery-key.replace": "replaceRecoveryKey",
  "cloud:service.set": "setCloudService",
};

const sourceKeys = [
  "mcp",
  "gui",
  "cli",
  "system",
] as const satisfies readonly SourceKey[];
const statusKeys = [
  "running",
  "success",
  "exited",
  "error",
  "failed",
  "cancelled",
  "killed",
] as const satisfies readonly StatusKey[];

export function initialAppLocale(): AppLocale {
  const stored = window.localStorage.getItem("chatroom.locale");
  if (stored === "en" || stored === "zhHans" || stored === "zhHant")
    return stored;

  const languages = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith("zh"))
      return /(?:^|[-_])(hant|tw|hk|mo)(?:$|[-_])/.test(normalized)
        ? "zhHant"
        : "zhHans";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}

export function actionMessageKey(
  pluginId: string,
  action: string,
): `$vuetify.chatroom.actions.${ActionKey}` | null {
  const key = actionKeys[pluginId + ":" + action];
  return key ? `$vuetify.chatroom.actions.${key}` : null;
}

export function sourceMessageKey(
  source: string,
): `$vuetify.chatroom.sources.${SourceKey}` | null {
  return (sourceKeys as readonly string[]).includes(source)
    ? `$vuetify.chatroom.sources.${source as SourceKey}`
    : null;
}

export function statusMessageKey(
  status: string,
): `$vuetify.chatroom.statuses.${StatusKey}` | null {
  return (statusKeys as readonly string[]).includes(status)
    ? `$vuetify.chatroom.statuses.${status as StatusKey}`
    : null;
}

export function humanizeAction(action: string): string {
  return action
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function appIntlLocale(locale: string): string {
  if (locale === "zhHans") return "zh-CN";
  if (locale === "zhHant") return "zh-TW";
  return "en-US";
}
