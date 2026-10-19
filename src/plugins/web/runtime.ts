import type { OperationLog } from "#operations/operation-log";
import type { ComputerService } from "#plugins/computer/computer-service";
import type { GitAccess } from "#app/git-access";
import type { ProcessSupervisor } from "#plugins/process/process-supervisor";
import type { WorkspaceService } from "#plugins/workspace/workspace-service";
import type { AgentRuntime } from "#plugins/agent/runtime";
import type { CustomMcpManager } from "#mcp/custom/manager";
import type { McpToolControl } from "#mcp/server/tool-control";

export class WebRuntime {
  constructor(
    readonly workspaces: WorkspaceService,
    readonly git: GitAccess,
    readonly operations: OperationLog,
    readonly processes: ProcessSupervisor,
    readonly computer: ComputerService,
    readonly agents: AgentRuntime,
    readonly mcpTools: McpToolControl,
    readonly customMcp: CustomMcpManager,
  ) {}

  processKill(processId: string, force = false) {
    return this.operations.run(
      {
        pluginId: "process",
        source: "gui",
        action: force ? "kill" : "terminate",
        processId,
        input: { processId, force },
      },
      async () => this.processes.kill(processId, force),
    );
  }

  listProcesses() {
    return this.processes.summaries();
  }

  getProcess(processId: string) {
    return this.processes.read(processId);
  }

  getProcessSummary(processId: string) {
    return this.processes.summary(processId);
  }
}
