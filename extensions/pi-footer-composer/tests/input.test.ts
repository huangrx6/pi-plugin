import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { keyboardAction, observeDismissInput, type DismissEvent } from "../input.ts";

test("passive observations reassemble reports and ignore paste, drag, release, modifiers and wheel", () => {
  const source = Object.assign(new EventEmitter(), { isTTY: true }), events: DismissEvent[] = [];
  const stop = observeDismissInput(source, event => events.push(event));
  source.emit("data", Buffer.from("text\x1b[<0;12;"));
  source.emit("data", Buffer.from("5M\x1b[O\x1b[I"));
  assert.deepEqual(events, [{ type: "press", x: 11, y: 4 }, { type: "blur" }]);
  source.emit("data", "\x1b[200~pasted \x1b[O\x1b[<0;1;1M");
  source.emit("data", "more\x1b[201~\x1b[<32;1;1M\x1b[<0;1;1m\x1b[<64;1;1M\x1b[<4;1;1M");
  assert.equal(events.length, 2);
  source.emit("data", "\x1b[<0;0;1M\x1b[<0;9999999999999999999999;1M\x1b[<0;4;7M");
  assert.deepEqual(events.at(-1), { type: "press", x: 3, y: 6 });
  stop(); assert.equal(source.listenerCount("data"), 0);
  source.emit("data", "\x1b[O"); assert.equal(events.length, 3);
});

test("non-TTY sources stay untouched and disposal during a batch stops later reports", () => {
  const source = new EventEmitter();
  observeDismissInput(source, () => assert.fail("non-TTY")); assert.equal(source.listenerCount("data"), 0);
  Object.assign(source, { isTTY: true }); let count = 0;
  const stop = observeDismissInput(source, () => { count++; stop(); });
  source.emit("data", "\x1b[O\x1b[O"); assert.equal(count, 1);
});

test("editing keys pass through; reports and key releases do not count as edits", () => {
  for (const raw of ["a", "\x1ba", "\x1b[97;1u", "\x1b[200~paste\x1b[201~", "\x1b[D", "\x1b[3~"]) assert.equal(keyboardAction(raw), "edit", JSON.stringify(raw));
  for (const raw of ["", "\x1b[<0;1;1M", "\x1b[I", "\x1b[O", "\x1b[97;1:3u", "\x1b[8;24;80t", "\x1b]10;rgb:ffff/ffff/ffff\x07"]) assert.equal(keyboardAction(raw), undefined, JSON.stringify(raw));
});
