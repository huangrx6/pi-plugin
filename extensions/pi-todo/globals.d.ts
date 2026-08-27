// Ambient declarations for pi runtime types (local static checks).
//
// MUST stay script-mode (no top-level import/export) so `declare module`
// creates a fresh module declaration — the real package resolves at the
// global nvm path at runtime, not from this extension's node_modules.

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

type ModelLikeShape = { id?: string; provider?: string } | null;

// Loose branch-entry shape the replay walker reads.
type LooseBranchEntry = {
  type?: string;
  message?: { role?: string; toolName?: string; details?: unknown };
};

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    hasUI: boolean;
    sessionManager: {
      getSessionId(): string;
      getBranch(): Iterable<LooseBranchEntry>;
    };
    ui: {
      notify(message: string, level: string): void;
      setWidget(
        key: string,
        value: unknown,
        options?: { placement?: string },
      ): void;
    };
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    registerCommand(
      name: string,
      def: {
        description: string;
        handler: (args: string | undefined, ctx: any) => Promise<void> | void;
      },
    ): void;
    registerTool(def: {
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
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details?: unknown;
      }>;
      renderCall?: (args: any, theme: any, context: any) => unknown;
      renderResult?: (result: any, options: any, theme: any, context: any) => unknown;
    }): void;
  }
}
