// Ambient declarations for the pi runtime types (local static checks).
//
// MUST stay script-mode (no top-level import/export) so `declare module`
// creates a fresh module declaration — the real packages are installed at
// the global pi path (or this extension's node_modules after
// `npm install`); tsc resolves this shim.
//
// Node built-ins come from @types/node (tsconfig `types: ["node"]`).
// Shapes are intentionally loose/structural: the runtime contract is
// wider than what this extension reads. Index signatures on event types
// keep the shim tolerant of fields this extension reads but that pi
// keeps adding (source, isError, …).

type InlineSkillEventCtx = {
  cwd: string;
  ui: {
    notify(message: string, level?: string): void;
    // The extension wraps the CURRENT provider (identity-guarded), so the
    // accepted argument is intentionally unknown here.
    addAutocompleteProvider(provider: unknown): void;
  };
  sessionManager: {
    getBranch(): Iterable<unknown>;
  };
};

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    getCommands(): unknown[];
    // Renderer factory receives (message, options, theme) at runtime.
    registerMessageRenderer(
      type: string,
      factory: (message: any, options: any, theme: any) => unknown,
    ): void;
    registerCommand(
      name: string,
      definition: {
        description: string;
        handler: (
          args: string,
          ctx: InlineSkillEventCtx,
        ) => Promise<void> | void;
      },
    ): void;
    appendEntry(type: string, data?: unknown): void;
    on(
      event: string,
      handler: (event: any, ctx: InlineSkillEventCtx) => unknown,
    ): void;
  }
  export type ExtensionContext = InlineSkillEventCtx;
  export type ParsedSkillBlock = {
    name?: string;
    path?: string;
    location: string;
    content: string;
    [key: string]: unknown;
  };
}

declare module "@earendil-works/pi-tui" {
  // TUI components are used with `new` (Box/Text are constructible
  // components in the real pi-tui); loose on purpose.
  export class Box {
    constructor(...args: unknown[]);
    addChild(child: unknown): void;
  }
  export class Text {
    constructor(...args: unknown[]);
  }
}
