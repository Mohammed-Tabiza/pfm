"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <CopilotKit
      agent="pfm-agent"
      runtimeUrl="/api/copilotkit"
      showDevConsole={process.env.NEXT_PUBLIC_SHOW_COPILOT_DEV_CONSOLE === "true"}
    >
      {children}
    </CopilotKit>
  );
}

