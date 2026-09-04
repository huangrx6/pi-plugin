// Ambient shim for local static checks. The real pi package is supplied by the runtime.
// Keep this file in script mode (no top-level import/export).

type ContextQosComponent = {
  render(width: number): string[];
  invalidate(): void;
};

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    appendEntry(customType: string, data?: unknown): void;
    sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "followUp" }): void;
    registerEntryRenderer<T>(type: string, renderer: (entry: { data?: T }, options: { expanded: boolean }, theme: any) => ContextQosComponent | undefined): void;
    registerCommand(
      name: string,
      definition: {
        description: string;
        handler: (args: string, ctx: any) => Promise<void> | void;
      },
    ): void;
    registerTool(definition: {
      name: string;
      label?: string;
      description: string;
      promptSnippet?: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: any,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: any,
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: unknown;
      }>;
      renderCall?: (args: any, theme: any, context: any) => ContextQosComponent;
      renderResult?: (
        result: any,
        options: any,
        theme: any,
        context: any,
      ) => ContextQosComponent;
    }): void;
  }
}
