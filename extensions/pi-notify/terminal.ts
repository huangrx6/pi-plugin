/** Pure protocol selection and encoding. No terminal writes or subprocesses. */
export type Protocol = "osc9" | "osc99" | "osc777" | "bell" | "off";
export type Transport = "direct" | "tmux" | "screen" | "zellij";
export interface TerminalPlan {
  terminal: string;
  detectedTransport: string;
  transport?: Transport;
  protocol?: Protocol;
  blocked: boolean;
  notes: string[];
}

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, " ")
    .replace(/\u001b./g, " ")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, char =>
      char === "\n" || char === "\r" || char === "\t" ? " " : "",
    )
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  const code = segment.codePointAt(0) ?? 0;
  if (
    (code >= 0x1f000 && code <= 0x1ffff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2300 && code <= 0x23ff)
  ) return 2;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
    ? 2
    : 1;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(value)) width += graphemeWidth(segment);
  return width;
}

export function singleLine(value: string, max = 240): string {
  const clean = sanitizeTerminalText(value);
  if (displayWidth(clean) <= max) return clean;
  const target = Math.max(0, max - 1);
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(clean)) {
    const width = graphemeWidth(segment);
    if (used + width > target) break;
    result += segment;
    used += width;
  }
  return `${result}${max > 0 ? "…" : ""}`;
}

function detectTerminal(env: NodeJS.ProcessEnv): {
  name: string;
  protocol?: Protocol;
} {
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();
  if (program === "ghostty" || term === "xterm-ghostty")
    return { name: "Ghostty", protocol: "osc9" };
  if (program === "iterm.app" || env.ITERM_SESSION_ID)
    return { name: "iTerm2", protocol: "osc9" };
  if (program === "wezterm" || env.WEZTERM_PANE)
    return { name: "WezTerm", protocol: "osc777" };
  if (env.KITTY_WINDOW_ID || term === "xterm-kitty")
    return { name: "Kitty", protocol: "osc99" };
  if (env.WT_SESSION) return { name: "Windows Terminal（未验证桌面通知协议）" };
  if (term.includes("rxvt"))
    return { name: "rxvt-unicode（通知扩展需自行配置）" };
  return { name: singleLine(env.TERM_PROGRAM || env.TERM || "未知终端", 80) };
}

export function resolveTerminal(env: NodeJS.ProcessEnv): TerminalPlan {
  const terminal = detectTerminal(env);
  const transports: Transport[] = [];
  if (env.TMUX || env.TERM?.startsWith("tmux")) transports.push("tmux");
  if (env.ZELLIJ || env.ZELLIJ_SESSION_NAME) transports.push("zellij");
  if (env.STY) transports.push("screen");
  const ambiguousScreen =
    transports.length === 0 && env.TERM?.startsWith("screen");
  const detectedTransport =
    transports.join(" + ") ||
    (ambiguousScreen ? "未知 screen/tmux 环境" : "direct");
  const plan: TerminalPlan = {
    terminal: terminal.name,
    detectedTransport,
    protocol: terminal.protocol,
    transport:
      transports.length === 1
        ? transports[0]
        : transports.length === 0 && !ambiguousScreen
          ? "direct"
          : undefined,
    blocked: false,
    notes: [],
  };
  const protocol = env.PI_NOTIFY_PROTOCOL?.toLowerCase() || "auto";
  const transport = env.PI_NOTIFY_TRANSPORT?.toLowerCase() || "auto";
  if (protocol !== "auto") {
    if (["osc9", "osc99", "osc777", "bell", "off"].includes(protocol)) {
      plan.protocol = protocol as Protocol;
      plan.notes.push(`协议由 PI_NOTIFY_PROTOCOL=${protocol} 指定。`);
    } else {
      plan.blocked = true;
      plan.notes.push(
        "PI_NOTIFY_PROTOCOL 无效；可选 auto / osc9 / osc99 / osc777 / bell / off。",
      );
    }
  }
  if (transport !== "auto") {
    if (["direct", "tmux", "screen", "zellij"].includes(transport)) {
      plan.transport = transport as Transport;
      plan.notes.push(
        `发送路径由 PI_NOTIFY_TRANSPORT=${transport} 指定，请确认实际转发链路。`,
      );
    } else {
      plan.blocked = true;
      plan.notes.push(
        "PI_NOTIFY_TRANSPORT 无效；可选 auto / direct / tmux / screen / zellij。",
      );
    }
  }
  // Zellij terminates and forwards notifications itself, choosing the outer
  // protocol according to host_notification_protocol, even if the host is hidden.
  if (plan.transport === "zellij") {
    if (protocol === "auto") plan.protocol = "osc9";
    plan.notes.push(
      "Zellij 使用原生通知转发；需支持 host_notification_protocol 的版本，off 会禁用转发。",
    );
  }
  if (plan.transport === "tmux")
    plan.notes.push(
      "tmux 3.3+ 需 allow-passthrough=on 或 all；未自动更改配置。",
    );
  if (plan.transport === "screen") {
    // Screen's DCS is terminated by ST, so it cannot contain Kitty's inner ST.
    // Kitty also documents OSC 9 support; choose that only in automatic mode.
    if (plan.protocol === "osc99" && protocol === "auto") {
      plan.protocol = "osc9";
      plan.notes.push(
        "screen 路径使用 Kitty 兼容的 OSC 9，避免内层 ST 提前结束 DCS。",
      );
    } else if (plan.protocol === "osc99") {
      plan.blocked = true;
      plan.notes.push(
        "screen 不封装 OSC 99；请改用 PI_NOTIFY_PROTOCOL=osc9 或 bell。",
      );
    }
  }
  if (plan.protocol === "off") return plan;
  if (plan.protocol === "bell" && !plan.blocked) {
    plan.transport = "direct";
    plan.notes.push("响铃交给当前终端或多路复用器处理，不保证桌面横幅。");
    return plan;
  }
  if (!plan.transport) {
    plan.blocked = true;
    plan.notes.push(
      "无法确定多层转发顺序；请在单层环境测试，或显式配置发送路径 / bell 降级。",
    );
  }
  if (!plan.protocol) {
    plan.blocked = true;
    plan.notes.push(
      "未自动假定桌面通知协议；确认终端支持后设置 PI_NOTIFY_PROTOCOL，或选择 bell / off。",
    );
  }
  return plan;
}

export function wrapForTransport(
  sequence: string,
  transport: Transport,
): string {
  if (transport === "tmux")
    return `${ESC}Ptmux;${sequence.split(ESC).join(`${ESC}${ESC}`)}${ST}`;
  if (transport === "screen") {
    if (sequence.includes(ST))
      throw new Error("screen passthrough cannot contain an inner ST");
    return `${ESC}P${sequence}${ST}`;
  }
  return sequence;
}

export function notificationBytes(
  plan: TerminalPlan,
  title: string,
  body: string,
  id: string,
): string[] {
  if (
    plan.blocked ||
    !plan.protocol ||
    !plan.transport ||
    plan.protocol === "off"
  )
    return [];
  if (plan.protocol === "bell") return [BEL];
  const safeTitle = singleLine(title);
  const safeBody = singleLine(body);
  let sequences: string[];
  if (plan.protocol === "osc9") {
    sequences = [`${ESC}]9;${safeTitle}: ${safeBody}${BEL}`];
  } else if (plan.protocol === "osc777") {
    sequences = [
      `${ESC}]777;notify;${safeTitle.replaceAll(";", ":")};${safeBody.replaceAll(";", ":")}${BEL}`,
    ];
  } else {
    const safeId = id.replace(/[^a-zA-Z0-9_+.-]/g, "") || "pi";
    sequences = [
      `${ESC}]99;i=${safeId}:d=0;${safeTitle}${ST}`,
      `${ESC}]99;i=${safeId}:p=body;${safeBody}${ST}`,
    ];
  }
  return sequences.map((sequence) =>
    wrapForTransport(sequence, plan.transport!),
  );
}
