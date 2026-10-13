/**
 * notifier.test.ts — pure oracle for system-notification backend selection.
 *
 * Covers resolveSystemNotifier (platform defaults, custom command, invalid
 * args) and systemCommand (argv layout and injection safety). No subprocess is
 * started: availability is injected, and argv is inspected as data.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSystemNotifier, systemCommand } from "./notifier.ts";

const always = () => true;
const never = () => false;

describe("system notifier backend", () => {
  it("uses osascript on macOS with title and body as argv", () => {
    const { notifier, error } = resolveSystemNotifier({}, "darwin", always);
    assert.equal(error, undefined);
    assert.ok(notifier);
    const command = systemCommand(notifier!, "Pi", "✓ Pi · 已结束");
    assert.equal(command.file, "/usr/bin/osascript");
    // The script runs through -e flags; the payload is appended as argv.
    assert.deepEqual(command.args.slice(-2), ["Pi", "✓ Pi · 已结束"]);
    assert.ok(command.args.filter((arg) => arg === "-e").length >= 3);
  });

  it("keeps hostile notification text as one argv item", () => {
    const { notifier } = resolveSystemNotifier({}, "darwin", always);
    const payload = '"; rm -rf /; echo $(whoami) `id` && |';
    const command = systemCommand(notifier!, "Pi", payload);
    assert.equal(command.args.at(-1), payload);
    assert.equal(command.args.at(-2), "Pi");
    // Nothing is joined into a single shell-looking string.
    assert.ok(!command.args.some((arg) => arg.includes("display notification") && arg.includes(payload)));
  });

  it("uses notify-send on Linux and reports a missing backend", () => {
    const linux = resolveSystemNotifier({}, "linux", always);
    assert.ok(linux.notifier);
    assert.deepEqual(systemCommand(linux.notifier!, "Pi", "body"), {
      file: "notify-send",
      args: ["--", "Pi", "body"],
    });
    const missing = resolveSystemNotifier({}, "linux", never);
    assert.equal(missing.notifier, undefined);
    assert.match(missing.error!, /PI_NOTIFY_COMMAND/);
  });

  it("asks for an explicit command on Windows and unknown platforms", () => {
    for (const platform of ["win32", "freebsd"] as const) {
      const result = resolveSystemNotifier({}, platform, always);
      assert.equal(result.notifier, undefined);
      assert.match(result.error!, /PI_NOTIFY_COMMAND/);
    }
  });

  it("prefers an explicit command over the platform default", () => {
    const { notifier } = resolveSystemNotifier(
      {
        PI_NOTIFY_COMMAND: "terminal-notifier",
        PI_NOTIFY_COMMAND_ARGS: '["-title", "{title}", "-message", "{body}"]',
      },
      "darwin",
      never,
    );
    assert.ok(notifier);
    assert.deepEqual(systemCommand(notifier!, "Pi", "36 turns"), {
      file: "terminal-notifier",
      args: ["-title", "Pi", "-message", "36 turns"],
    });
  });

  it("defaults custom argv to title and body", () => {
    const { notifier } = resolveSystemNotifier(
      { PI_NOTIFY_COMMAND: "notify" },
      "linux",
      always,
    );
    assert.ok(notifier);
    assert.deepEqual(systemCommand(notifier!, "Pi", "done").args, [
      "Pi",
      "done",
    ]);
  });

  it("rejects invalid custom argv instead of guessing", () => {
    for (const args of ["not json", '{"title":"x"}', '["a", 1]']) {
      const result = resolveSystemNotifier(
        { PI_NOTIFY_COMMAND: "notify", PI_NOTIFY_COMMAND_ARGS: args },
        "linux",
        always,
      );
      assert.equal(result.notifier, undefined);
      assert.match(result.error!, /JSON 字符串数组/);
    }
  });

  it("treats a blank command as unset", () => {
    const { notifier, error } = resolveSystemNotifier(
      { PI_NOTIFY_COMMAND: "   " },
      "darwin",
      always,
    );
    assert.equal(error, undefined);
    assert.equal(notifier!.backend.kind, "osascript");
  });
});
