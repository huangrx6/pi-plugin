// Local check shim; tsconfig.runtime.json checks the same source against Pi.
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    appendEntry(customType: string, data?: unknown): void;
    sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "followUp" }): void;
    registerEntryRenderer<T>(type: string, renderer: (entry: { data?: T }, options: { expanded: boolean }, theme: any) => { render(width: number): string[]; invalidate(): void } | undefined): void;
    registerCommand(name: string, definition: { description: string; handler: (args: string, ctx: any) => Promise<void> | void }): void;
  }
}
