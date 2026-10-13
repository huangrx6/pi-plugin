/**
 * Pure system-notification backend selection and argv construction.
 *
 * No subprocesses and no filesystem access: availability is injected, so the
 * whole decision is testable without starting a program. Notification text is
 * always passed as argv data — never interpolated into a shell command or an
 * AppleScript source line.
 */

/** A program plus argv items; used with `execFile`, never with a shell. */
export interface NotifyCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export type SystemBackend =
  | { readonly kind: "osascript"; readonly file: string }
  | { readonly kind: "notify-send"; readonly file: string }
  | {
      readonly kind: "custom";
      readonly file: string;
      readonly argv: readonly string[];
    };

export interface SystemNotifier {
  readonly backend: SystemBackend;
  /** Backend name shown in diagnostics. */
  readonly label: string;
}

/**
 * Result of backend selection.
 *
 * Deliberately not a discriminated union on `ok`: this repo compiles without
 * `strictNullChecks`, where narrowing by a boolean discriminant does not work.
 * Callers test `notifier` and fall back to `error`.
 */
export interface NotifierResolution {
  /** Present when a backend can deliver the notification. */
  readonly notifier?: SystemNotifier;
  /** Present when no backend is usable or the configuration is invalid. */
  readonly error?: string;
}

/**
 * AppleScript run handler: title and body arrive as argv, so quotes,
 * backticks, semicolons and `$()` inside a notification stay data.
 */
const OSASCRIPT_LINES = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
];

const DEFAULT_CUSTOM_ARGS = ["{title}", "{body}"];
const ARGS_ERROR = "PI_NOTIFY_COMMAND_ARGS 必须是 JSON 字符串数组。";

export function resolveSystemNotifier(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  available: (file: string) => boolean,
): NotifierResolution {
  const command = env.PI_NOTIFY_COMMAND?.trim();
  if (command) {
    let argv: readonly string[] = DEFAULT_CUSTOM_ARGS;
    const raw = env.PI_NOTIFY_COMMAND_ARGS?.trim();
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { error: ARGS_ERROR };
      }
      if (
        !Array.isArray(parsed) ||
        !parsed.every((item) => typeof item === "string")
      )
        return { error: ARGS_ERROR };
      argv = parsed as string[];
    }
    return {
      notifier: {
        backend: { kind: "custom", file: command, argv },
        label: `自定义命令 ${command}`,
      },
    };
  }
  if (platform === "darwin" && available("/usr/bin/osascript"))
    return {
      notifier: {
        backend: { kind: "osascript", file: "/usr/bin/osascript" },
        label: "osascript（macOS 通知中心）",
      },
    };
  if (platform === "linux" && available("notify-send"))
    return {
      notifier: {
        backend: { kind: "notify-send", file: "notify-send" },
        label: "notify-send（桌面通知）",
      },
    };
  return {
    error:
      platform === "win32"
        ? "Windows 没有内置后端；请设置 PI_NOTIFY_COMMAND 与 PI_NOTIFY_COMMAND_ARGS。"
        : `当前平台（${platform}）没有可用的系统通知后端；请设置 PI_NOTIFY_COMMAND 与 PI_NOTIFY_COMMAND_ARGS。`,
  };
}

/** The exact program and argv for one notification. */
export function systemCommand(
  notifier: SystemNotifier,
  title: string,
  body: string,
): NotifyCommand {
  const { backend } = notifier;
  if (backend.kind === "osascript")
    return {
      file: backend.file,
      args: [...OSASCRIPT_LINES.flatMap((line) => ["-e", line]), title, body],
    };
  if (backend.kind === "notify-send")
    return { file: backend.file, args: ["--", title, body] };
  return {
    file: backend.file,
    args: backend.argv.map((item) =>
      item.replaceAll("{title}", title).replaceAll("{body}", body),
    ),
  };
}
