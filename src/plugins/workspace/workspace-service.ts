import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { GitAccess } from "#app/git-access";
import type {
  WorkspaceAccess,
  WorkspaceEntry,
  WorkspaceInfo,
  WorkspaceSource,
  WorkspaceStatus,
} from "#app/workspace-access";
import { ChatRoomError } from "#core/errors/chatroom-error";
import type { AppDatabase } from "#infrastructure/database/app-database";
import {
  WorkspaceRepository,
  type WorkspaceRecord,
} from "#infrastructure/database/workspace-repository";
import { WorkspaceRootPolicy } from "./workspace-root-policy.js";
import {
  readInstructions,
  readPresetPrompt,
  readSkills,
  readSummary,
} from "./metadata.js";
import { WorkspaceFs } from "./workspace-fs.js";

export class WorkspaceService implements WorkspaceAccess {
  private readonly repository: WorkspaceRepository;

  private constructor(
    private readonly rootsPolicy: WorkspaceRootPolicy,
    private readonly git: Pick<GitAccess, "projectFiles">,
    database: AppDatabase,
  ) {
    this.repository = new WorkspaceRepository(database);
  }

  static async create(
    allowedRoots: string[],
    git: Pick<GitAccess, "projectFiles">,
    database: AppDatabase,
  ): Promise<WorkspaceService> {
    const service = new WorkspaceService(
      await WorkspaceRootPolicy.create(allowedRoots),
      git,
      database,
    );
    const scannedRoots = await service.refreshDiscovery();
    await service.refreshWorkspaceStatuses(scannedRoots);
    return service;
  }

  roots(): string[] {
    return this.rootsPolicy.roots();
  }

  async list(): Promise<WorkspaceEntry[]> {
    const scannedRoots = await this.refreshDiscovery();
    await this.refreshWorkspaceStatuses(scannedRoots);
    return this.entries(false);
  }

  async listAll(): Promise<WorkspaceEntry[]> {
    const scannedRoots = await this.refreshDiscovery();
    await this.refreshWorkspaceStatuses(scannedRoots);
    return this.entries(true);
  }

  async resolve(workspaceId: string): Promise<string> {
    const record = this.requireRecord(workspaceId);
    const status = workspaceStatus(record);
    if (status === "restore_pending")
      throw new ChatRoomError(
        "CONFLICT",
        "Workspace needs restore confirmation before it can be used",
        { workspaceId },
      );
    if (status !== "available")
      throw new ChatRoomError("NOT_FOUND", "Workspace is unavailable", {
        workspaceId,
        path: record.path,
      });

    const parent = path.dirname(record.path);
    const parentEntries = await readdir(parent, { withFileTypes: true }).catch(
      () => null,
    );
    if (!parentEntries) {
      this.repository.markMissing(record.id);
      throw new ChatRoomError(
        "NOT_FOUND",
        "Workspace location is unavailable",
        {
          workspaceId,
          path: record.path,
        },
      );
    }
    const entry = parentEntries.find(
      (candidate) => candidate.name === path.basename(record.path),
    );
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
      this.repository.markMissing(record.id);
      throw new ChatRoomError(
        "NOT_FOUND",
        "Workspace directory no longer exists at its registered path",
        { workspaceId, path: record.path },
      );
    }

    const canonical = await realpath(record.path).catch(() => null);
    if (!canonical || canonical !== record.path) {
      this.repository.markMissing(record.id);
      throw new ChatRoomError(
        "NOT_FOUND",
        "Workspace directory cannot be resolved safely",
        { workspaceId, path: record.path },
      );
    }
    const directory = await stat(canonical).catch(() => null);
    if (!directory?.isDirectory()) {
      this.repository.markMissing(record.id);
      throw new ChatRoomError(
        "NOT_FOUND",
        "Workspace directory is unavailable",
        {
          workspaceId,
          path: record.path,
        },
      );
    }
    return canonical;
  }

  async registerProject(
    pathInput: string,
    nameInput: string | null = null,
  ): Promise<WorkspaceEntry> {
    if (typeof pathInput !== "string" || !pathInput.trim())
      throw new ChatRoomError("INVALID_INPUT", "Project path is required");
    const requestedPath = pathInput.trim();
    if (!path.isAbsolute(requestedPath))
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Project path must be an absolute path on the ChatRoom host",
      );
    const canonical = await realpath(requestedPath).catch(() => null);
    if (!canonical)
      throw new ChatRoomError("NOT_FOUND", "Project directory does not exist", {
        path: pathInput,
      });
    if (!(await stat(canonical)).isDirectory())
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Project path is not a directory",
      );
    if (
      canonical === path.parse(canonical).root ||
      this.rootsPolicy.roots().includes(canonical)
    )
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Choose a project directory, not a configured parent directory",
      );
    const name =
      nameInput === null || nameInput === undefined
        ? null
        : validateDisplayName(nameInput);
    const record = this.repository.registerManual(canonical, name);
    return this.entry(record, true);
  }

  async renameProject(
    workspaceId: string,
    nameInput: string,
  ): Promise<WorkspaceEntry> {
    const name = validateDisplayName(nameInput);
    const record = this.repository.rename(workspaceId, name);
    if (!record)
      throw new ChatRoomError("NOT_FOUND", "Workspace not found", {
        workspaceId,
      });
    return this.toEntry(record, workspaceStatus(record), null);
  }

  async removeProject(workspaceId: string): Promise<void> {
    const record = this.requireRecord(workspaceId);
    if (!record.manually_registered)
      throw new ChatRoomError(
        "CONFLICT",
        "Only manually registered workspaces can be removed",
        { workspaceId },
      );
    if (record.discovered_from)
      throw new ChatRoomError(
        "CONFLICT",
        "This project is still discovered under a configured workspace location",
        { workspaceId },
      );
    this.repository.removeManual(workspaceId);
  }

  async cleanupProject(workspaceId: string): Promise<void> {
    const record = this.requireRecord(workspaceId);
    if (workspaceStatus(record) === "available")
      throw new ChatRoomError(
        "CONFLICT",
        "Available workspaces cannot be cleaned up",
        { workspaceId },
      );
    if (this.repository.hasActiveSessions(workspaceId))
      throw new ChatRoomError(
        "CONFLICT",
        "Stop active Agent sessions before cleaning up this workspace",
        { workspaceId },
      );
    this.repository.cleanup(workspaceId);
  }

  async restoreProject(workspaceId: string): Promise<WorkspaceEntry> {
    const record = this.requireRecord(workspaceId);
    if (!record.manually_registered && !record.discovered_from)
      throw new ChatRoomError(
        "CONFLICT",
        "Register the project again before restoring it",
        { workspaceId },
      );
    const canonical = await realpath(record.path).catch(() => null);
    if (!canonical || canonical !== record.path)
      throw new ChatRoomError(
        "NOT_FOUND",
        "Workspace directory is not present at its registered path",
        { workspaceId, path: record.path },
      );
    if (!(await stat(canonical)).isDirectory())
      throw new ChatRoomError(
        "INVALID_INPUT",
        "Workspace path is not a directory",
      );
    const restored = this.repository.confirmRestore(workspaceId);
    if (!restored)
      throw new ChatRoomError("CONFLICT", "Workspace cannot be restored", {
        workspaceId,
      });
    return this.entry(restored, true);
  }

  async createProject(
    parentInput: string,
    nameInput: string,
  ): Promise<WorkspaceEntry> {
    const parent = await this.rootsPolicy.resolveAllowedRoot(parentInput);
    const name = validateProjectName(nameInput);
    const target = path.join(parent, name);
    try {
      await mkdir(target, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ChatRoomError(
          "CONFLICT",
          "Workspace already exists: " + target,
        );
      throw error;
    }
    await mkdir(path.join(target, ".chatroom"));
    const root = await realpath(target);
    const record = this.repository.registerDiscoveredPath(root, parent, false);
    if (!record)
      throw new ChatRoomError(
        "INTERNAL",
        "Created workspace was not registered",
      );
    return this.entry(record, true);
  }

  async projectFiles(workspaceId: string, maxFiles = 5000): Promise<string[]> {
    return (await this.projectFilesResult(workspaceId, maxFiles)).paths;
  }

  async projectFilesResult(
    workspaceId: string,
    maxFiles = 5000,
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const fs = await this.fs(workspaceId);
    const limit = Math.min(Math.max(Math.trunc(maxFiles), 1), 9999);
    const gitFiles = await this.git.projectFiles(fs.root, limit + 1);
    if (gitFiles)
      return {
        paths: gitFiles.slice(0, limit),
        truncated: gitFiles.length > limit,
      };

    const entries = await fs.list(".", {
      recursive: true,
      maxEntries: 10_000,
      excludeDirectoryNames: [".chatroom", ".git"],
    });
    const files = entries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path);
    return {
      paths: files.slice(0, limit),
      truncated: entries.length >= 10_000 || files.length > limit,
    };
  }

  async info(workspaceId: string): Promise<WorkspaceInfo> {
    const record = this.requireRecord(workspaceId);
    const root = await this.resolve(workspaceId);
    const fs = await WorkspaceFs.create(root);
    const [summary, presetPrompt, instructions, skills] = await Promise.all([
      readSummary(fs),
      readPresetPrompt(fs),
      readInstructions(fs),
      readSkills(fs),
    ]);
    return {
      ...this.toEntry(record, "available", summary),
      presetPrompt,
      instructions,
      skills,
    };
  }

  async fs(workspaceId: string): Promise<WorkspaceFs> {
    return WorkspaceFs.create(await this.resolve(workspaceId));
  }

  private async refreshDiscovery(): Promise<Set<string>> {
    const roots = this.rootsPolicy.roots();
    const scannedRoots = new Set<string>();
    this.repository.clearRemovedDiscoveryRoots(roots);
    for (const allowedRoot of roots) {
      let entries;
      try {
        entries = await readdir(allowedRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      scannedRoots.add(allowedRoot);
      const paths = new Set<string>();
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          entry.name.startsWith(".")
        )
          continue;
        const candidate = path.join(allowedRoot, entry.name);
        const canonical = await realpath(candidate).catch(() => null);
        if (canonical && this.rootsPolicy.isWorkspaceRoot(canonical))
          paths.add(canonical);
      }
      this.repository.syncDiscoveredRoot(allowedRoot, [...paths]);
    }
    return scannedRoots;
  }

  private async refreshWorkspaceStatuses(
    scannedRoots: ReadonlySet<string>,
  ): Promise<void> {
    for (const record of this.repository.list()) {
      if (
        record.discovered_from &&
        !scannedRoots.has(record.discovered_from) &&
        !record.manually_registered
      ) {
        this.repository.markMissing(record.id);
        continue;
      }

      const parent = path.dirname(record.path);
      const parentStat = await stat(parent).catch(() => null);
      if (!parentStat?.isDirectory()) {
        this.repository.markMissing(record.id);
        continue;
      }
      const parentEntries = await readdir(parent, {
        withFileTypes: true,
      }).catch(() => null);
      if (!parentEntries) {
        this.repository.markMissing(record.id);
        continue;
      }

      const entry = parentEntries.find(
        (candidate) => candidate.name === path.basename(record.path),
      );
      if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
        this.repository.markMissing(record.id);
        continue;
      }

      const canonical = await realpath(record.path).catch(() => null);
      const directory =
        canonical === record.path
          ? await stat(record.path).catch(() => null)
          : null;
      if (!directory?.isDirectory()) {
        this.repository.markMissing(record.id);
        continue;
      }
      if (
        record.state === "missing" &&
        (record.manually_registered || record.discovered_from)
      )
        this.repository.markRestorePending(record.id);
    }
  }

  private async entries(
    includeUnavailable: boolean,
  ): Promise<WorkspaceEntry[]> {
    const output: WorkspaceEntry[] = [];
    for (const record of this.repository.list()) {
      let status = workspaceStatus(record);
      let summary: string | null = null;
      if (status === "available") {
        try {
          summary = await readSummary(await WorkspaceFs.create(record.path));
        } catch {
          status = "missing";
        }
      }
      if (!includeUnavailable && status !== "available") continue;
      output.push(this.toEntry(record, status, summary));
    }
    return output;
  }

  private toEntry(
    record: WorkspaceRecord,
    status: WorkspaceStatus,
    summary: string | null,
  ): WorkspaceEntry {
    return {
      id: record.id,
      path: record.path,
      name: record.name_override ?? (path.basename(record.path) || record.path),
      summary,
      status,
      source: workspaceSource(record),
      manuallyRegistered: Boolean(record.manually_registered),
      discovered: Boolean(record.discovered_from),
    };
  }

  private entry(record: WorkspaceRecord, available: boolean): WorkspaceEntry {
    const status = available ? workspaceStatus(record) : "missing";
    return this.toEntry(record, status, null);
  }

  private requireRecord(workspaceId: string): WorkspaceRecord {
    if (typeof workspaceId !== "string" || !workspaceId.trim())
      throw new ChatRoomError("INVALID_INPUT", "Workspace ID is required");
    const record = this.repository.get(workspaceId);
    if (!record)
      throw new ChatRoomError("NOT_FOUND", "Workspace not found", {
        workspaceId,
      });
    return record;
  }
}

function workspaceStatus(record: WorkspaceRecord): WorkspaceStatus {
  if (record.state === "restore_pending") return "restore_pending";
  if (record.state === "missing") return "missing";
  if (record.manually_registered || record.discovered_from) return "available";
  return "unregistered";
}

function workspaceSource(record: WorkspaceRecord): WorkspaceSource {
  if (record.manually_registered && record.discovered_from) return "both";
  if (record.manually_registered) return "manual";
  if (record.discovered_from) return "configured";
  return "history";
}

function validateDisplayName(input: string): string {
  if (typeof input !== "string")
    throw new ChatRoomError("INVALID_INPUT", "Workspace name is required");
  const name = input.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name))
    throw new ChatRoomError("INVALID_INPUT", "Invalid workspace name");
  return name;
}

function validateProjectName(input: string): string {
  if (typeof input !== "string")
    throw new ChatRoomError("INVALID_INPUT", "Project name is required");
  const name = input.trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  )
    throw new ChatRoomError("INVALID_INPUT", "Invalid project name");
  return name;
}
