// Complete ambient declarations for runtime types.
//
// This file MUST be a script (no top-level `import` / `export`):
//   - Script-mode `declare module "X" { ... }` creates a NEW module
//     declaration (not an augmentation). This is what we want here:
//     the real `@earendil-works/pi-coding-agent` is installed at the
//     GLOBAL nvm path (not under this extension's node_modules), so
//     TypeScript can't resolve it from this directory. We declare
//     the module shape ourselves so static checks pass; the runtime
//     uses the real package via jiti + Node's normal resolution.
//
// If you ever add a top-level `export {}` (turning this into a module),
// `declare module` becomes augmentation instead — and TS2307 returns
// because there's nothing to augment against.

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
  }

  export interface ExtensionAPI {
    registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
    registerTool(definition: {
      name: string;
      label?: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: any,
        signal: AbortSignal,
        onUpdate: ((chunk: unknown) => void) | undefined,
        ctx: any,
      ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
    }): void;
  }

  export declare const CONFIG_DIR_NAME: string;
}
