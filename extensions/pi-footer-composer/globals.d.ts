// Ambient declarations for the pi runtime types (local static checks).
//
// MUST stay script-mode (no top-level import/export) so `declare module`
// creates a fresh module declaration — the real package is installed at
// the global nvm path, not under this extension's node_modules. Runtime
// resolves the real package; tsc resolves this shim.

declare const process: {
  env: Record<string, string | undefined>;
};

type ModelLikeShape = {
  id?: string;
  reasoning?: boolean;
  provider?: string;
  contextWindow?: number;
} | null;

type LooseSessionEntry = {
  type?: string;
  message?: { role?: string; usage?: unknown };
  usage?: unknown;
};

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    model: ModelLikeShape;
    thinkingLevel: string | undefined;
    sessionManager: {
      getEntries(): readonly LooseSessionEntry[];
      getCwd(): string;
      getSessionName(): string | null;
    };
    ui: {
      setFooter(
        renderer: (
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string; bold(t: string): string },
          footerData: {
            getGitBranch: () => string | null;
            getExtensionStatuses: () => ReadonlyMap<string, string>;
            getAvailableProviderCount: () => number;
            onBranchChange: (callback: () => void) => () => void;
          },
        ) => unknown,
      ): void;
    };
    getContextUsage?: () =>
      | { tokens: number | null; contextWindow: number; percent: number | null }
      | undefined;
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
  }

  // Default export type for the extension entry (index.ts).
  export type ExtensionEntry = (pi: ExtensionAPI) => void;
}
