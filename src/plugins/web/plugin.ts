import type { InternalPlugin } from "#plugins/types";
import { createServiceToken } from "#app/service-registry";
import { ComputerServiceToken } from "#plugins/computer/plugin";
import { GitAccessToken } from "#app/git-access";
import { ProcessServiceToken } from "#plugins/process/plugin";
import { WorkspaceServiceToken } from "#plugins/workspace/plugin";
import { AgentServiceToken } from "#plugins/agent/plugin";
import { WebRuntime } from "./runtime.js";

interface WebPluginService {
  application: WebRuntime;
}
export const WebServiceToken = createServiceToken<WebPluginService>("web");

export function createWebPlugin(): InternalPlugin {
  return {
    id: "web",
    activate(context) {
      context.services.provide(WebServiceToken, {
        application: new WebRuntime(
          context.services.require(WorkspaceServiceToken),
          context.services.require(GitAccessToken),
          context.operations,
          context.services.require(ProcessServiceToken),
          context.services.require(ComputerServiceToken),
          context.services.require(AgentServiceToken),
          context.mcpTools,
          context.customMcp,
        ),
      });
    },
  };
}
