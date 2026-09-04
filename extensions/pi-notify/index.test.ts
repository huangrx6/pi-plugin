import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerNotify, type NotifyIO } from "./index.ts";
import {
  formatBody,
  formatDuration,
  freshStats,
  outcomeFor,
} from "./format.ts";
import {
  displayWidth,
  notificationBytes,
  resolveTerminal,
  sanitizeTerminalText,
  singleLine,
  wrapForTransport,
} from "./terminal.ts";
const ESC = "\x1b",
  BEL = "\x07",
  ST = `${ESC}\\`;

describe("protocol and transport", () => {
  const terminals = [
    [{ TERM_PROGRAM: "ghostty" }, "osc9"],
    [{ TERM_PROGRAM: "iTerm.app" }, "osc9"],
    [{ TERM_PROGRAM: "WezTerm" }, "osc777"],
    [{ KITTY_WINDOW_ID: "1" }, "osc99"],
  ] as const;
  const multiplexers = [
    [{}, "direct"],
    [{ TMUX: "socket" }, "tmux"],
    [{ STY: "session" }, "screen"],
    [{ ZELLIJ: "0" }, "zellij"],
  ] as const;
  for (const [terminal, preferred] of terminals)
    for (const [env, transport] of multiplexers) {
      it(`${JSON.stringify(terminal)} through ${transport}`, () => {
        const plan = resolveTerminal({ ...terminal, ...env });
        const protocol =
          transport === "zellij" ||
          (transport === "screen" && preferred === "osc99")
            ? "osc9"
            : preferred;
        assert.equal(plan.protocol, protocol);
        assert.equal(plan.transport, transport);
        assert.equal(plan.blocked, false);
        const chunks = notificationBytes(plan, "Pi", "hello", "id");
        assert.equal(chunks.length, protocol === "osc99" ? 2 : 1);
        assert.ok(
          chunks[0].startsWith(
            transport === "tmux"
              ? `${ESC}Ptmux;${ESC}${ESC}]`
              : transport === "screen"
                ? `${ESC}P${ESC}]`
                : `${ESC}]`,
          ),
        );
      });
    }
  for (const env of [
    {},
    { TERM: "xterm-256color" },
    { TERM_PROGRAM: "Apple_Terminal" },
    { TERM: "alacritty" },
    { WT_SESSION: "wsl" },
    { TERM: "rxvt-unicode" },
  ]) {
    it(`does not invent support for ${JSON.stringify(env)}`, () => {
      const plan = resolveTerminal(env);
      assert.equal(plan.blocked, true);
      assert.deepEqual(notificationBytes(plan, "Pi", "hello", "id"), []);
    });
  }
  it("recognizes identity fallbacks", () => {
    for (const [env, expected] of [
      [{ TERM: "xterm-ghostty" }, "osc9"],
      [{ ITERM_SESSION_ID: "x" }, "osc9"],
      [{ WEZTERM_PANE: "0" }, "osc777"],
      [{ TERM: "xterm-kitty" }, "osc99"],
    ] as const)
      assert.equal(resolveTerminal(env).protocol, expected);
  });
  it("does not guess nested multiplexer order or ambiguous screen TERM", () => {
    for (const env of [
      { TMUX: "1", ZELLIJ: "1" },
      { TMUX: "1", STY: "1" },
      { ZELLIJ: "1", STY: "1" },
      { TERM: "screen-256color" },
    ])
      assert.equal(
        resolveTerminal({ TERM_PROGRAM: "ghostty", ...env }).blocked,
        true,
      );
  });
  it("supports explicit protocol and path while retaining detection diagnostics", () => {
    const plan = resolveTerminal({
      PI_NOTIFY_PROTOCOL: "osc9",
      PI_NOTIFY_TRANSPORT: "tmux",
      TMUX: "1",
      STY: "1",
    });
    assert.equal(plan.blocked, false);
    assert.equal(plan.transport, "tmux");
    assert.equal(plan.detectedTransport, "tmux + screen");
    assert.match(plan.notes.join(" "), /allow-passthrough/);
  });
  it("rejects invalid overrides", () => {
    for (const env of [
      { PI_NOTIFY_PROTOCOL: "bad" },
      { PI_NOTIFY_TRANSPORT: "bad" },
    ])
      assert.equal(
        resolveTerminal({ TERM_PROGRAM: "ghostty", ...env }).blocked,
        true,
      );
  });
  it("uses native Zellij forwarding when host identity is hidden", () => {
    const plan = resolveTerminal({ ZELLIJ_SESSION_NAME: "session" });
    assert.deepEqual(notificationBytes(plan, "Pi", "hello", "id"), [
      `${ESC}]9;Pi: hello${BEL}`,
    ]);
    assert.match(plan.notes.join(" "), /host_notification_protocol/);
  });
  it("supports explicit bell and off for unknown terminals", () => {
    assert.deepEqual(
      notificationBytes(
        resolveTerminal({ PI_NOTIFY_PROTOCOL: "bell", TMUX: "1", STY: "1" }),
        "Pi",
        "hello",
        "id",
      ),
      [BEL],
    );
    assert.deepEqual(
      notificationBytes(
        resolveTerminal({ PI_NOTIFY_PROTOCOL: "off" }),
        "Pi",
        "hello",
        "id",
      ),
      [],
    );
  });
  it("does not embed Kitty ST in screen DCS", () => {
    assert.equal(
      resolveTerminal({
        KITTY_WINDOW_ID: "1",
        STY: "1",
        PI_NOTIFY_PROTOCOL: "osc99",
      }).blocked,
      true,
    );
    assert.throws(
      () => wrapForTransport(`${ESC}]99;;body${ST}`, "screen"),
      /inner ST/,
    );
  });
  it("encodes screen and tmux wrappers byte for byte", () => {
    assert.deepEqual(
      notificationBytes(
        resolveTerminal({ TERM_PROGRAM: "WezTerm", STY: "1" }),
        "Pi",
        "hello",
        "id",
      ),
      [`${ESC}P${ESC}]777;notify;Pi;hello${BEL}${ST}`],
    );
    assert.deepEqual(
      notificationBytes(
        resolveTerminal({ KITTY_WINDOW_ID: "1", TMUX: "1" }),
        "Pi",
        "hello",
        "run-1",
      ),
      [
        `${ESC}Ptmux;${ESC}${ESC}]99;i=run-1:d=0;Pi${ESC}${ESC}\\${ST}`,
        `${ESC}Ptmux;${ESC}${ESC}]99;i=run-1:p=body;hello${ESC}${ESC}\\${ST}`,
      ],
    );
  });
  it("sanitizes payload controls, delimiters and unicode truncation", () => {
    assert.deepEqual(
      notificationBytes(
        resolveTerminal({ TERM_PROGRAM: "WezTerm" }),
        "Pi;evil",
        `a${BEL}${ESC}]52;c;bad\n\u009cb`,
        "id",
      ),
      [`${ESC}]777;notify;Pi:evil;a b${BEL}`],
    );
    assert.ok(displayWidth(singleLine("𠮷".repeat(300))) <= 240);
    assert.equal(singleLine("a\n\r\tb"), "a b");
    assert.equal(singleLine("a\u009bb"), "a");
    assert.equal(singleLine("👩‍💻".repeat(130)), `${"👩‍💻".repeat(119)}…`);
    assert.equal(sanitizeTerminalText("A\u202eB\x1b[31mC"), "AB C");
  });
});

function harness(
  options: {
    env?: NodeJS.ProcessEnv;
    mode?: ExtensionContext["mode"];
    hasUI?: boolean;
    tty?: boolean;
    writeError?: boolean;
  } = {},
) {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  let command: (args: string, ctx: ExtensionContext) => unknown;
  const chunks: string[] = [],
    notices: string[] = [],
    menus: Array<{ title: string; options: string[] }> = [];
  let selection: string | undefined,
    pending = false,
    idle = true,
    time = 1_000,
    id = 0;
  const io: NotifyIO = {
    env: () => options.env ?? { TERM_PROGRAM: "ghostty" },
    isTTY: () => options.tty ?? true,
    now: () => time,
    id: () => `test-${++id}`,
    write: (value) => {
      if (options.writeError) throw new Error("write failed");
      chunks.push(value);
    },
  };
  const ctx: ExtensionContext = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: {
      notify: (message) => {
        notices.push(message);
      },
      select: async (title, choices) => {
        menus.push({ title, options: choices });
        return selection;
      },
    },
    sessionManager: { getSessionName: () => "test-session" },
  };
  registerNotify(
    {
      on: (name, handler) => {
        handlers.set(name, handler);
      },
      registerCommand: (name, definition) => {
        assert.equal(name, "notify");
        command = definition.handler;
      },
    } as ExtensionAPI,
    io,
  );
  const fire = (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event, ctx);
  const finish = (reason = "stop") => {
    const message = { role: "assistant", stopReason: reason };
    fire("turn_end", { message });
    fire("agent_end", { messages: [message] });
    fire("agent_settled");
  };
  return {
    chunks,
    notices,
    menus,
    fire,
    finish,
    command: async (args = "") => {
      await command(args, ctx);
    },
    select: (value: string) => {
      selection = value;
    },
    pending: (value: boolean) => {
      pending = value;
    },
    idle: (value: boolean) => {
      idle = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("settlement and standalone command", () => {
  it("notifies once after retry and does not turn recovered errors into final failure", async () => {
    const h = harness();
    h.fire("agent_start");
    h.fire("tool_execution_end", { toolName: "bash", isError: true });
    h.fire("agent_end", {
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    assert.deepEqual(h.chunks, []);
    h.fire("agent_start");
    h.fire("tool_execution_end", { toolName: "bash" });
    h.advance(2000);
    h.finish();
    h.fire("agent_settled");
    assert.equal(h.chunks.length, 1);
    assert.match(h.chunks[0], /✓ Pi · 已结束.*2 tools.*2s/);
    await h.command("status");
    assert.match(h.notices.at(-1)!, /过程中 1 次工具错误/);
  });
  it("reports final model failure without tool errors", () => {
    const h = harness();
    h.fire("agent_start");
    h.finish("error");
    assert.match(h.chunks[0], /✗ Pi · 运行失败/);
  });
  it("keeps aborted runs quiet and distinct in diagnostics", async () => {
    const h = harness();
    h.fire("agent_start");
    h.finish("aborted");
    assert.deepEqual(h.chunks, []);
    await h.command("status");
    assert.match(h.notices[0], /已中断/);
  });
  for (const reason of ["length", "toolUse", undefined])
    it(`does not label ${String(reason)} successful`, () => {
      const h = harness();
      h.fire("agent_start");
      h.fire("agent_end", {
        messages: [{ role: "assistant", stopReason: reason }],
      });
      h.fire("agent_settled");
      assert.match(h.chunks[0], /已停止，请检查结果/);
    });
  it("waits for queued continuation and streaming", () => {
    const h = harness();
    h.fire("agent_start");
    h.pending(true);
    h.finish();
    assert.equal(h.chunks.length, 0);
    h.fire("agent_start");
    h.pending(false);
    h.idle(false);
    h.finish();
    assert.equal(h.chunks.length, 0);
    h.idle(true);
    h.fire("agent_settled");
    assert.equal(h.chunks.length, 1);
    assert.match(h.chunks[0], /2 turns/);
  });
  it("resets counters per settled run and invalidates replaced sessions", () => {
    const h = harness();
    h.fire("agent_start");
    h.finish();
    h.fire("agent_start");
    h.finish();
    assert.match(h.chunks[1], /1 turn/);
    for (const event of ["session_start", "session_shutdown"]) {
      h.fire("agent_start");
      h.fire(event);
      h.fire("agent_settled");
    }
    assert.equal(h.chunks.length, 2);
  });
  for (const options of [
    { mode: "rpc" as const },
    { mode: "json" as const, hasUI: false },
    { mode: "print" as const, hasUI: false },
    { hasUI: false },
    { tty: false },
  ])
    it(`never writes control bytes for ${JSON.stringify(options)}`, async () => {
      const h = harness(options);
      h.fire("agent_start");
      h.finish();
      await h.command("test");
      assert.deepEqual(h.chunks, []);
    });
  it("warns once per unknown-terminal configuration without OSC", () => {
    const h = harness({ env: {} });
    h.fire("agent_start");
    h.finish();
    h.fire("agent_start");
    h.advance(3000);
    h.finish();
    assert.deepEqual(h.chunks, []);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0], /PI_NOTIFY_PROTOCOL/);
  });
  it("opens the daily summary without sending and needs no footer APIs", async () => {
    const h = harness();
    await h.command();
    assert.deepEqual(h.chunks, []);
    assert.match(h.menus[0].title, /通知 \/ 已开启/);
    assert.match(h.menus[0].title, /Ghostty · 可以发送/);
    assert.doesNotMatch(h.menus[0].title, /协议：osc9/);
    assert.deepEqual(h.menus[0].options, [
      "发送测试通知",
      "关闭本会话通知",
      "查看终端诊断",
      "返回",
    ]);
  });
  it("keeps terminal details behind a secondary action", async () => {
    const h = harness();
    h.select("查看终端诊断");
    await h.command();
    assert.equal(h.menus.length, 2);
    assert.match(h.menus[1].title, /终端：Ghostty.*转发：direct/);
    assert.match(h.menus[1].title, /协议：osc9/);
  });
  it("returns a non-interactive summary in RPC mode", async () => {
    const h = harness({ mode: "rpc" });
    await h.command();
    assert.equal(h.menus.length, 0);
    assert.match(h.notices[0], /当前模式不发送/);
    assert.doesNotMatch(h.notices[0], /协议：/);
  });
  it("supports menu testing and legacy message, without claiming delivery", async () => {
    const h = harness();
    h.select("发送测试通知");
    await h.command();
    await h.command("custom message");
    assert.equal(h.chunks.length, 2);
    assert.match(h.chunks[1], /custom message/);
    assert.match(h.notices[0], /无法确认送达/);
  });
  it("supports mute/unmute, while environment off stays authoritative", async () => {
    const h = harness();
    await h.command("off");
    h.fire("agent_start");
    h.finish();
    assert.equal(h.chunks.length, 0);
    await h.command("on");
    await h.command("test hello");
    assert.match(h.chunks[0], /hello/);
    const off = harness({
      env: { TERM_PROGRAM: "ghostty", PI_NOTIFY_PROTOCOL: "off" },
    });
    await off.command("on");
    await off.command("test");
    assert.equal(off.chunks.length, 0);
  });
  it("uses unique Kitty notification IDs", async () => {
    const h = harness({ env: { KITTY_WINDOW_ID: "1" } });
    await h.command("test");
    await h.command("test");
    assert.match(h.chunks[0], /i=test-1:d=0/);
    assert.match(h.chunks[2], /i=test-2:d=0/);
  });
  it("isolates notification write errors from the agent run", () => {
    const h = harness({ writeError: true });
    h.fire("agent_start");
    assert.doesNotThrow(() => h.finish());
    assert.match(h.notices[0], /写入终端失败/);
  });
});

describe("format", () => {
  it("formats duration boundaries", () => {
    for (const [ms, expected] of [
      [-1000, "0s"],
      [42000, "42s"],
      [84000, "1m24s"],
      [4320000, "1h12m"],
    ] as const)
      assert.equal(formatDuration(ms), expected);
  });
  it("uses final reason and caps long names by terminal display width", () => {
    assert.equal(outcomeFor("error"), "failed");
    assert.equal(outcomeFor("aborted"), "cancelled");
    const stats = freshStats(0);
    stats.errors = 3;
    assert.match(formatBody(stats, null, "completed", 1000), /^✓ Pi · 已结束/);
    const body = formatBody(stats, "𠮷".repeat(300), "completed", 1000);
    assert.ok(displayWidth(body) <= 240);
    assert.ok(body.endsWith("…"));
  });
});
