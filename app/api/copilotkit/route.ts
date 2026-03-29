import { CopilotRuntime, copilotRuntimeNextJSAppRouterEndpoint } from "@copilotkit/runtime";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";

const backendEndpoint =
  process.env.PFM_AGENT_URL ?? "http://localhost:8123/copilotkit";

const runtime = new CopilotRuntime({
  agents: {
    default: new LangGraphHttpAgent({
      agentId: "default",
      description: "Alias default pour l'agent PFM LangGraph",
      url: backendEndpoint,
    }),
    "pfm-agent": new LangGraphHttpAgent({
      agentId: "pfm-agent",
      description: "Agent PFM connecte a LangGraph",
      url: backendEndpoint,
    }),
  },
});

const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
  runtime,
  endpoint: "/api/copilotkit",
});

export const GET = handleRequest;
export const POST = handleRequest;

