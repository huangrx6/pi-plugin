/** Passive terminal observations: never consume input or change terminal modes. */
export type InputSource = {
  isTTY?: boolean;
  on(event: "data", listener: (data: string | Buffer) => void): unknown;
  removeListener(event: "data", listener: (data: string | Buffer) => void): unknown;
};
export type DismissEvent = { type: "blur" } | { type: "press"; x: number; y: number };

export function keyboardAction(raw: string): "escape" | "edit" | undefined {
  if (raw === "\x1b") return "escape";
  // Kitty CSI-u: ignore releases; Esc with no modifiers also has code point 27.
  const kitty = raw.match(/^\x1b\[(\d+)(?::[\d:]*)?(?:;(\d+)(?::([123]))?)?(?:;[\d:]+)?u$/);
  if (kitty) {
    if (kitty[3] === "3") return undefined;
    return kitty[1] === "27" && (!kitty[2] || kitty[2] === "1") ? "escape" : "edit";
  }
  const xterm = raw.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (xterm) return xterm[1] === "1" && xterm[2] === "27" ? "escape" : "edit";
  if (raw.startsWith("\x1b[200~")) return "edit";
  if (raw && !/^\x1b[\[\]PX^_]/.test(raw)) return "edit";
  if (/^\x1b\[(?:[\d;]*[ABCDHFZ]|[1-8](?:;\d+)?~)$/.test(raw)) return "edit";
  return undefined;
}

export function observeDismissInput(source: InputSource, listener: (event: DismissEvent) => void): () => void {
  if (!source.isTTY) return () => {};
  let pending = "", pasting = false, stopped = false;
  const onData = (chunk: string | Buffer) => {
    pending += chunk.toString();
    while (!stopped) {
      const start = pending.indexOf("\x1b");
      if (start < 0) { pending = ""; break; }
      pending = pending.slice(start);
      if (pending === "\x1b") break;
      if (!pending.startsWith("\x1b[")) { pending = pending.slice(1); continue; }
      const sequence = pending.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
      if (!sequence) {
        if (pending.length < 64 && /^\x1b\[[0-?]*[ -/]*$/.test(pending)) break;
        pending = pending.slice(1); continue;
      }
      pending = pending.slice(sequence.length);
      if (sequence === "\x1b[201~") { pasting = false; continue; }
      if (pasting) continue;
      if (sequence === "\x1b[200~") { pasting = true; continue; }
      if (sequence === "\x1b[O") { listener({ type: "blur" }); continue; }
      const mouse = sequence.match(/^\x1b\[<0;(\d+);(\d+)M$/);
      if (mouse) {
        const x = Number(mouse[1]) - 1, y = Number(mouse[2]) - 1;
        if (Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0) listener({ type: "press", x, y });
      }
    }
  };
  // Fullscreen TUI consumes mouse/focus reports before addInputListener callbacks.
  // Observe the public stdin stream without replacing or reordering host listeners.
  source.on("data", onData);
  return () => { stopped = true; pending = ""; source.removeListener("data", onData); };
}
