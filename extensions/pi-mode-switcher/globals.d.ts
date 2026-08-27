// Ambient declarations for the pi runtime types (local static checks).
//
// MUST stay script-mode (no top-level import/export) so `declare module`
// creates a fresh module declaration — the real package is installed at
// the global nvm path, not under this extension's node_modules. Runtime
// resolves the real package; tsc resolves this shim.
//
// `process` and other Node built-ins come from @types/node (declared in
// tsconfig.json `types: ["node"]). This shim only declares the pi
// module shape mode-switcher imports.

type ModeSwitcherToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type ModeSwitcherEventCtx = {
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, level?: string): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
  };
};

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(
      event: "tool_call",
      handler: (
        event: ModeSwitcherToolCallEvent,
        ctx: ModeSwitcherEventCtx,
      ) => Promise<unknown> | unknown,
    ): void;
    on(
      event: "session_start" | "session_tree" | "turn_end",
      handler: (
        event: unknown,
        ctx: ModeSwitcherEventCtx,
      ) => Promise<unknown> | unknown,
    ): void;
    registerCommand(
      name: string,
      definition: {
        description: string;
        handler: (
          args: string,
          ctx: ModeSwitcherEventCtx,
        ) => Promise<void> | void;
      },
    ): void;
  }
}
