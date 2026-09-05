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

// Structural shape of a pi TUI renderable (see pi's extensions/types.d.ts:
// tool renderCall/renderResult must return Component, never a string).
// pi 0.85+: invalidate is REQUIRED on every component handed to the
// runtime — ToolExecutionComponent wraps renderer output in a
// MouseRegion whose invalidate() calls child.invalidate() uncondi-
// tionally (mouse click-to-expand). A bare { render } literal crashes
// the TUI at startup render with "this.child.invalidate is not a
// function".
type ToolRenderComponent = {
  render(width: number): string[];
  invalidate(): void;
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
    sendMessage?(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "followUp" }): void;
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
      // pi 0.84.x contract: both renderers must return a Component —
      // { render(width): string[] } — not a string (a raw string crashes
      // the TUI's Box.render with "child.render is not a function").
      renderCall?: (args: any, theme: any, context: any) => ToolRenderComponent;
      renderResult?: (
        result: any,
        options: any,
        theme: any,
        context: any,
      ) => ToolRenderComponent;
    }): void;
  }
}
