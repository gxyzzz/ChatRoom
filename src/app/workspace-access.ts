import { createServiceToken } from "#app/service-registry";

export type WorkspaceStatus =
  "available" | "missing" | "restore_pending" | "unregistered";
export type WorkspaceSource = "configured" | "manual" | "both" | "history";

export interface WorkspaceEntry {
  id: string;
  path: string;
  name: string;
  summary: string | null;
  status: WorkspaceStatus;
  source: WorkspaceSource;
  manuallyRegistered: boolean;
  discovered: boolean;
}

export interface WorkspaceSkill {
  name: string;
  description: string;
  path: string;
}

export interface WorkspaceInfo extends WorkspaceEntry {
  presetPrompt: string | null;
  instructions: string | null;
  skills: WorkspaceSkill[];
}

export interface WorkspaceAccess {
  roots(): string[];
  list(): Promise<WorkspaceEntry[]>;
  listAll(): Promise<WorkspaceEntry[]>;
  resolve(workspaceId: string): Promise<string>;
  createProject(
    parentInput: string,
    nameInput: string,
  ): Promise<WorkspaceEntry>;
  registerProject(
    pathInput: string,
    nameInput?: string | null,
  ): Promise<WorkspaceEntry>;
  renameProject(
    workspaceId: string,
    nameInput: string,
  ): Promise<WorkspaceEntry>;
  removeProject(workspaceId: string): Promise<void>;
  cleanupProject(workspaceId: string): Promise<void>;
  restoreProject(workspaceId: string): Promise<WorkspaceEntry>;
  projectFiles(workspaceId: string, maxFiles?: number): Promise<string[]>;
  info(workspaceId: string): Promise<WorkspaceInfo>;
}

export const WorkspaceAccessToken =
  createServiceToken<WorkspaceAccess>("workspace-access");
