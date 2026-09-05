declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerCommand(name: string, definition: {
      description: string;
      handler: (args: string, ctx: any) => Promise<void> | void;
    }): void;
  }
}
