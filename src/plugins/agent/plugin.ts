import { WorkspaceAccessToken } from "#app/workspace-access";
import type { InternalPlugin } from "#plugins/types";
import { createServiceToken } from "#app/service-registry";
import { AgentRepository } from "./repository.js";
import { AgentRuntime } from "./runtime.js";
import { registerAgentTools } from "./mcp.js";
import { createAgentProviders } from "./providers/index.js";

export const AgentServiceToken = createServiceToken<AgentRuntime>("agent");

export function createAgentPlugin(): InternalPlugin {
  let runtime: AgentRuntime | null = null;
  let attachmentCleanupTimer: NodeJS.Timeout | null = null;
  return {
    id: "agent",
    async activate(context) {
      runtime = new AgentRuntime(
        new AgentRepository(context.database),
        context.services.require(WorkspaceAccessToken),
        context.events,
        createAgentProviders(context.logs, context.agentMcp),
      );
      await runtime.cleanupOrphanAttachments();
      attachmentCleanupTimer = setInterval(
        () => {
          void runtime?.cleanupOrphanAttachments().catch(() => undefined);
        },
        24 * 60 * 60 * 1000,
      );
      attachmentCleanupTimer.unref();
      context.services.provide(AgentServiceToken, runtime);
    },
    registerMcp(mcp) {
      if (!runtime) throw new Error("Agent plugin is not active");
      registerAgentTools(mcp, runtime);
    },
    async deactivate() {
      if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
      attachmentCleanupTimer = null;
      await runtime?.close();
      runtime = null;
    },
  };
}
