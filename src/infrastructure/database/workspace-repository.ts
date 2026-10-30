import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppDatabase } from "./app-database.js";

export type WorkspaceState = "available" | "missing" | "restore_pending";

export interface WorkspaceRecord {
  id: string;
  path: string;
  name_override: string | null;
  manually_registered: number;
  discovered_from: string | null;
  state: WorkspaceState;
}

export class WorkspaceRepository {
  constructor(private readonly database: AppDatabase) {}

  list(): WorkspaceRecord[] {
    const rows = this.database.raw
      .prepare("SELECT * FROM workspaces")
      .all() as unknown as WorkspaceRecord[];
    return rows.sort(
      (a, b) =>
        displayName(a).localeCompare(displayName(b), undefined, {
          sensitivity: "base",
        }) || a.path.localeCompare(b.path),
    );
  }

  get(id: string): WorkspaceRecord | null {
    return (
      (this.database.raw
        .prepare("SELECT * FROM workspaces WHERE id=?")
        .get(id) as WorkspaceRecord | undefined) ?? null
    );
  }

  getByPath(workspacePath: string): WorkspaceRecord | null {
    return (
      (this.database.raw
        .prepare("SELECT * FROM workspaces WHERE path=?")
        .get(workspacePath) as WorkspaceRecord | undefined) ?? null
    );
  }

  syncDiscoveredRoot(root: string, discoveredPaths: readonly string[]): void {
    const paths = new Set(discoveredPaths);
    const updateMissing = this.database.raw.prepare(
      "UPDATE workspaces SET discovered_from=CASE WHEN manually_registered=1 THEN NULL ELSE discovered_from END, state=CASE WHEN manually_registered=1 THEN state ELSE 'missing' END WHERE id=?",
    );
    for (const row of this.list()) {
      if (row.discovered_from === root && !paths.has(row.path))
        updateMissing.run(row.id);
    }
    for (const workspacePath of paths)
      this.registerDiscoveredPath(workspacePath, root, true);
  }

  registerDiscoveredPath(
    workspacePath: string,
    root: string,
    requireRestoreConfirmation: boolean,
  ): WorkspaceRecord {
    const existing = this.getByPath(workspacePath);
    if (!existing) {
      const id = "ws_" + randomUUID();
      this.database.raw
        .prepare(
          "INSERT INTO workspaces(id, path, manually_registered, discovered_from, state) VALUES(?,?,0,?,'available')",
        )
        .run(id, workspacePath, root);
      return this.get(id)!;
    }

    const wasUnavailable = existing.state !== "available";
    const state =
      requireRestoreConfirmation && wasUnavailable
        ? "restore_pending"
        : "available";
    this.database.raw
      .prepare("UPDATE workspaces SET discovered_from=?, state=? WHERE id=?")
      .run(root, state, existing.id);
    return this.get(existing.id)!;
  }

  clearRemovedDiscoveryRoots(roots: readonly string[]): void {
    const configured = new Set(roots);
    const update = this.database.raw.prepare(
      "UPDATE workspaces SET discovered_from=NULL, state=CASE WHEN state='restore_pending' THEN 'missing' ELSE state END WHERE id=?",
    );
    for (const row of this.list()) {
      if (row.discovered_from && !configured.has(row.discovered_from))
        update.run(row.id);
    }
  }

  registerManual(workspacePath: string, name: string | null): WorkspaceRecord {
    const existing = this.getByPath(workspacePath);
    if (existing) {
      this.database.raw
        .prepare(
          "UPDATE workspaces SET name_override=COALESCE(?, name_override), manually_registered=1, state='available' WHERE id=?",
        )
        .run(name, existing.id);
      return this.get(existing.id)!;
    }

    const id = "ws_" + randomUUID();
    this.database.raw
      .prepare(
        "INSERT INTO workspaces(id, path, name_override, manually_registered, state) VALUES(?,?,?,?, 'available')",
      )
      .run(id, workspacePath, name, 1);
    return this.get(id)!;
  }

  rename(id: string, name: string): WorkspaceRecord | null {
    this.database.raw
      .prepare("UPDATE workspaces SET name_override=? WHERE id=?")
      .run(name, id);
    return this.get(id);
  }

  removeManual(id: string): WorkspaceRecord | null {
    this.database.raw
      .prepare(
        "UPDATE workspaces SET manually_registered=0, state=CASE WHEN state='restore_pending' THEN 'missing' ELSE state END WHERE id=?",
      )
      .run(id);
    return this.get(id);
  }

  hasActiveSessions(id: string): boolean {
    return Boolean(
      this.database.raw
        .prepare(
          "SELECT 1 FROM agent_sessions WHERE workspace_id=? AND status IN ('running','waiting_input') LIMIT 1",
        )
        .get(id),
    );
  }

  cleanup(id: string): void {
    this.database.raw.exec("BEGIN IMMEDIATE");
    try {
      this.database.raw
        .prepare("DELETE FROM agent_sessions WHERE workspace_id=?")
        .run(id);
      this.database.raw.prepare("DELETE FROM workspaces WHERE id=?").run(id);
      this.database.raw.exec("COMMIT");
    } catch (error) {
      this.database.raw.exec("ROLLBACK");
      throw error;
    }
  }

  markMissing(id: string): void {
    this.database.raw
      .prepare("UPDATE workspaces SET state='missing' WHERE id=?")
      .run(id);
  }

  markRestorePending(id: string): void {
    this.database.raw
      .prepare(
        "UPDATE workspaces SET state='restore_pending' WHERE id=? AND state='missing'",
      )
      .run(id);
  }

  confirmRestore(id: string): WorkspaceRecord | null {
    this.database.raw
      .prepare(
        "UPDATE workspaces SET state='available' WHERE id=? AND (manually_registered=1 OR discovered_from IS NOT NULL)",
      )
      .run(id);
    return this.get(id);
  }
}

function displayName(record: WorkspaceRecord): string {
  return record.name_override ?? (path.basename(record.path) || record.path);
}
