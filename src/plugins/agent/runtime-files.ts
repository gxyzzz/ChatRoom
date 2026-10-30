import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ChatRoomError } from "#core/errors/chatroom-error";
import {
  removeFileWithin,
  resolveReadableFileWithin,
  writeBytesAtomicWithin,
} from "#core/fs/safe-directory";
import type { ProviderItem } from "./provider.js";
import type { AgentStore } from "./store.js";
import type { AgentHistory, AgentSession, AgentTurnInput } from "./types.js";
import { runtimeErrorMessage } from "./runtime-state.js";

export function sessionAttachmentPrefix(sessionId: string): string {
  return ".chatroom/agent-attachments/" + sessionId + "/";
}

export async function cleanupSessionFiles(
  store: AgentStore,
  history: AgentHistory,
  workspaceRoot: string | null,
): Promise<void> {
  if (!workspaceRoot) return;
  const retained = referencedManagedFiles(
    store,
    history.session.workspaceId,
    history.session.id,
  );
  const attachmentPrefix = sessionAttachmentPrefix(history.session.id);
  const attachmentDirectory = path.join(workspaceRoot, attachmentPrefix);

  try {
    for (const file of await readdir(attachmentDirectory)) {
      const filePath = attachmentPrefix + file;
      if (retained.has(filePath)) continue;
      await removeFileWithin(workspaceRoot, filePath).catch(() => undefined);
    }
  } catch {
    // The session may not have uploaded local attachments.
  }

  for (const filePath of sessionArtifactFiles(history)) {
    if (retained.has(filePath)) continue;
    await removeFileWithin(workspaceRoot, filePath).catch(() => undefined);
  }
}

export async function cleanupOrphanAttachments(
  store: AgentStore,
  resolveWorkspace: (workspaceId: string) => Promise<string>,
  maxAgeMs: number,
): Promise<void> {
  const now = Date.now();
  const workspaceIds = new Set(
    store.listSessions().map((session) => session.workspaceId),
  );
  for (const workspaceId of workspaceIds) {
    const workspaceRoot = await resolveWorkspace(workspaceId).catch(() => null);
    if (!workspaceRoot) continue;
    await removeUnreferencedAttachmentFiles(
      workspaceRoot,
      referencedManagedFiles(store, workspaceId),
      now,
      maxAgeMs,
    );
  }
}

export async function prepareProviderItem(
  workspaceRoot: string,
  item: ProviderItem,
): Promise<ProviderItem> {
  if (item.type !== "artifact") return item;
  try {
    if (!path.isAbsolute(item.artifact.path)) {
      return {
        ...item,
        artifact: {
          ...item.artifact,
          path: (
            await resolveReadableFileWithin(workspaceRoot, item.artifact.path)
          ).relative,
        },
      };
    }

    if (item.artifact.kind !== "image")
      throw new ChatRoomError(
        "FORBIDDEN",
        "External Agent artifacts must be imported explicitly",
      );
    const info = await stat(item.artifact.path);
    if (!info.isFile())
      throw new ChatRoomError("INVALID_INPUT", "Agent artifact is not a file");
    if (info.size > 32 * 1024 * 1024)
      throw new ChatRoomError("INVALID_INPUT", "Agent artifact is too large");
    const extension = path.extname(item.artifact.name).slice(0, 16);
    const target =
      ".chatroom/agent-artifacts/" + randomUUID() + extension.toLowerCase();
    const content = await readFile(item.artifact.path);
    if (content.byteLength > 32 * 1024 * 1024)
      throw new ChatRoomError("INVALID_INPUT", "Agent artifact is too large");
    await writeBytesAtomicWithin(workspaceRoot, target, content);
    return {
      ...item,
      artifact: {
        ...item.artifact,
        path: target,
      },
    };
  } catch (error) {
    return {
      type: "notice",
      level: "warning",
      text:
        "Agent artifact could not be imported: " + runtimeErrorMessage(error),
    };
  }
}

export async function validateAttachments(
  session: AgentSession,
  workspaceRoot: string,
  attachments: AgentTurnInput["attachments"],
): Promise<AgentTurnInput["attachments"]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      const resolved = await resolveReadableFileWithin(
        workspaceRoot,
        attachment.path,
      );
      if (
        resolved.relative.startsWith(".chatroom/agent-attachments/") &&
        !resolved.relative.startsWith(sessionAttachmentPrefix(session.id))
      )
        throw new ChatRoomError(
          "FORBIDDEN",
          "Agent attachment belongs to another session",
        );
      return {
        ...attachment,
        path: resolved.relative,
      };
    }),
  );
}

function referencedManagedFiles(
  store: AgentStore,
  workspaceId: string,
  excludedSessionId?: string,
): Set<string> {
  const paths = new Set<string>();
  for (const session of store.listSessions()) {
    if (session.id === excludedSessionId) continue;
    if (session.workspaceId !== workspaceId) continue;
    const history = store.history(session.id);
    if (!history) continue;
    for (const filePath of managedFilesInHistory(history)) paths.add(filePath);
  }
  return paths;
}

async function removeUnreferencedAttachmentFiles(
  workspaceRoot: string,
  referenced: Set<string>,
  now: number,
  maxAgeMs: number,
): Promise<void> {
  const root = path.join(workspaceRoot, ".chatroom/agent-attachments");
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return;
  }
  for (const sessionId of sessions) {
    const dir = path.join(root, sessionId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const relative = sessionAttachmentPrefix(sessionId) + file;
      if (referenced.has(relative)) continue;
      try {
        const info = await stat(path.join(dir, file));
        if (info.isFile() && now - info.mtimeMs > maxAgeMs)
          await removeFileWithin(workspaceRoot, relative);
      } catch {
        // Ignore races with uploads/deletions.
      }
    }
  }
}

function managedFilesInHistory(history: AgentHistory): Set<string> {
  const paths = new Set<string>();
  for (const entry of history.turns) {
    for (const item of entry.items) {
      if (item.type === "user_message") {
        for (const attachment of item.attachments) {
          if (
            attachment.path.startsWith(".chatroom/agent-attachments/") ||
            attachment.path.startsWith(".chatroom/agent-artifacts/")
          )
            paths.add(attachment.path);
        }
      } else if (
        item.type === "artifact" &&
        item.artifact.path.startsWith(".chatroom/agent-artifacts/")
      ) {
        paths.add(item.artifact.path);
      }
    }
  }
  return paths;
}

function sessionArtifactFiles(history: AgentHistory): Set<string> {
  const paths = new Set<string>();
  for (const entry of history.turns) {
    for (const item of entry.items) {
      if (
        item.type === "artifact" &&
        item.artifact.path.startsWith(".chatroom/agent-artifacts/")
      )
        paths.add(item.artifact.path);
    }
  }
  return paths;
}
