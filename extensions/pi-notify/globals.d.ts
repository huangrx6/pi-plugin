// Script-mode shim for local static checks; runtime imports are type-only.
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    mode: "tui" | "rpc" | "json" | "print";
    hasUI: boolean;
    isIdle(): boolean;
    hasPendingMessages(): boolean;
    ui: {
      notify(message: string, level?: string): void;
      select(title: string, options: string[]): Promise<string | undefined>;
    };
    sessionManager?: { getSessionName(): string | null };
  }
  export interface ExtensionAPI {
    on(
      event:
        | "session_start"
        | "session_shutdown"
        | "agent_start"
        | "agent_end"
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
}
