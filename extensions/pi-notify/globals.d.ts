// Ambient declarations for the pi runtime types (local static checks).
//
// MUST stay script-mode (no top-level import/export) so `declare module`
// creates a fresh module declaration — the real package is installed at
// the global nvm path, not under this extension's node_modules. Runtime
// resolves the real package; tsc resolves this shim.
//
// `process` and other Node built-ins come from @types/node (declared in
// tsconfig.json `types: ["node"]`). This shim only declares the pi
// module shape, nothing else.

type ToolExecutionEndEvent = {
  toolName: string;
  isError?: boolean;
};

type ExtensionUI = {
  notify(message: string, level?: string): void;
};

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    ui: ExtensionUI;
    sessionManager?: {
      getSessionName(): string | null;
    };
  }

  export interface ExtensionAPI {
    on(
      event:
        | "agent_start"
        | "turn_end"
        | "tool_execution_end"
        | "agent_settled",
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ): void;
    registerCommand(
      name: string,
      def: {
        description: string;
        handler: (args: string, ctx: ExtensionContext) => unknown;
      },
    ): void;
  }

  // Default export type for the extension entry (index.ts).
  export type ExtensionEntry = (pi: ExtensionAPI) => void;
}
