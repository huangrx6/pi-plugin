/**
 * Unit tests for pi-notify.
 *
 * Covers:
 *   - formatBody (singular/plural, errors, session, truncation)
 *   - formatDuration (s / m / h)
 *   - wrapForMultiplexer (tmux / zellij / screen / plain)
 *   - OSC sequence bytes (777 / 9 / 99, with and without multiplexer)
 *   - detectSender (terminal detection + unsupported branch)
 *   - Extension factory (registration surface + agent_settled emits OSC)
 *
 * Pure stdout capture via a saved/restored stub. No real terminal
 * notifications are emitted during the test run.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import factory, {
	formatBody,
	formatDuration,
	detectSender,
	isUnsupportedTerminal,
	notifyOSC777,
	notifyOSC99,
	notifyOSC9,
	wrapForMultiplexer,
} from "./index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ── stdout capture ─────────────────────────────────────────────────────

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

interface StdoutCapture {
	chunks: string[];
	restore(): void;
}

function captureStdout(): StdoutCapture {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		chunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
		);
		return true;
	}) as typeof process.stdout.write;
	return {
		chunks,
		restore() {
			process.stdout.write = original;
		},
	};
}

// ── env save / restore ─────────────────────────────────────────────────

const ENV_KEYS = [
	"TMUX",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"STY",
	"KITTY_WINDOW_ID",
	"TERM_PROGRAM",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"TERM",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

let savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnv(): void {
	for (const k of ENV_KEYS) delete process.env[k];
}

function setEnv(patch: Partial<Record<EnvKey, string>>): void {
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) delete process.env[k as EnvKey];
		else process.env[k as EnvKey] = v;
	}
}

beforeEach(() => {
	savedEnv = {};
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	clearEnv();
});

afterEach(() => {
	clearEnv();
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

// ── formatDuration ─────────────────────────────────────────────────────

describe("formatDuration", () => {
	it("clamps negative to 0s", () => {
		assert.equal(formatDuration(-5000), "0s");
	});

	it("formats seconds under a minute", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(42_000), "42s");
		assert.equal(formatDuration(59_499), "59s"); // rounds down to 59
	});

	it("formats minutes with zero-padded seconds", () => {
		assert.equal(formatDuration(60_000), "1m00s");
		assert.equal(formatDuration(84_000), "1m24s");
		assert.equal(formatDuration(599_000), "9m59s");
	});

	it("formats hours with zero-padded minutes", () => {
		assert.equal(formatDuration(3_600_000), "1h00m");
		assert.equal(formatDuration(4_320_000), "1h12m");
	});
});

// ── formatBody ─────────────────────────────────────────────────────────

function freshStats(
	overrides: Partial<{
		turns: number;
		toolCalls: number;
		errors: number;
		uniqueTools: Set<string>;
	}> = {},
) {
	return {
		turns: overrides.turns ?? 0,
		toolCalls: overrides.toolCalls ?? 0,
		errors: overrides.errors ?? 0,
		uniqueTools: overrides.uniqueTools ?? new Set<string>(),
		startedAt: Date.now() - 84_000, // pretend we started 1m24s ago
	};
}

describe("formatBody", () => {
	it("renders a minimal run with just a duration", () => {
		const body = formatBody(freshStats({ turns: 1 }), null);
		assert.equal(body, "\u2713 Pi \u00B7 1 turn \u00B7 1m24s");
	});

	it("uses singular 'tool' for one call", () => {
		const body = formatBody(
			freshStats({ turns: 1, toolCalls: 1, uniqueTools: new Set(["bash"]) }),
			null,
		);
		assert.equal(
			body,
			"\u2713 Pi \u00B7 1 turn \u00B7 1 tool (1 unique) \u00B7 1m24s",
		);
	});

	it("uses plural 'turns' and 'tools' for multiples, with unique count", () => {
		const body = formatBody(
			freshStats({
				turns: 3,
				toolCalls: 5,
				uniqueTools: new Set(["bash", "read", "edit"]),
			}),
			null,
		);
		assert.equal(
			body,
			"\u2713 Pi \u00B7 3 turns \u00B7 5 tools (3 unique) \u00B7 1m24s",
		);
	});

	it("switches to ✗ icon and includes error count when errors > 0", () => {
		const body = formatBody(
			freshStats({
				turns: 3,
				toolCalls: 5,
				errors: 2,
				uniqueTools: new Set(["bash", "read", "edit"]),
			}),
			null,
		);
		assert.equal(
			body,
			"\u2717 Pi \u00B7 3 turns \u00B7 5 tools (3 unique) \u00B7 2 errors \u00B7 1m24s",
		);
	});

	it("uses singular 'error' for a single error", () => {
		const body = formatBody(
			freshStats({
				turns: 1,
				toolCalls: 2,
				errors: 1,
				uniqueTools: new Set(["bash"]),
			}),
			null,
		);
		assert.equal(
			body,
			"\u2717 Pi \u00B7 1 turn \u00B7 2 tools (1 unique) \u00B7 1 error \u00B7 1m24s",
		);
	});

	it("appends session name with the · separator", () => {
		const body = formatBody(freshStats({ turns: 1 }), "debug-session");
		assert.equal(
			body,
			"\u2713 Pi \u00B7 1 turn \u00B7 1m24s \u00B7 debug-session",
		);
	});

	it("ignores empty / whitespace-only session names", () => {
		const body = formatBody(freshStats({ turns: 1 }), "   ");
		assert.equal(body, "\u2713 Pi \u00B7 1 turn \u00B7 1m24s");
	});

	it("truncates a too-long session name with an ellipsis", () => {
		const longName = "x".repeat(300);
		const body = formatBody(freshStats({ turns: 1 }), longName);
		assert.ok(body.length <= 240, `body length ${body.length} exceeds 240`);
		assert.ok(
			body.endsWith("\u2026"),
			"body must end with an ellipsis when truncated",
		);
	});

	it("caps the entire body at 240 characters", () => {
		const longName = "x".repeat(500);
		const body = formatBody(
			freshStats({
				turns: 50,
				toolCalls: 999,
				errors: 50,
				uniqueTools: new Set(["a", "b", "c", "d", "e"]),
			}),
			longName,
		);
		assert.ok(body.length <= 240, `body length ${body.length} exceeds 240`);
	});
});

// ── wrapForMultiplexer ─────────────────────────────────────────────────

describe("wrapForMultiplexer", () => {
	it("returns the sequence unchanged when no multiplexer env is set", () => {
		const seq = `${ESC}]9;hello${BEL}`;
		assert.equal(wrapForMultiplexer(seq), seq);
	});

	it("wraps with DCS passthrough when TMUX is set", () => {
		setEnv({ TMUX: "/tmp/tmux-1000/default,12345,0" });
		const seq = `${ESC}]9;hello${BEL}`;
		const wrapped = wrapForMultiplexer(seq);
		// Every inner ESC byte is doubled; the leading ESC of the OSC sequence
		// is part of the payload and therefore doubled too.
		assert.equal(wrapped, `${ESC}Ptmux;${ESC}${ESC}]9;hello${BEL}${ST}`);
	});

	it("wraps with DCS passthrough when ZELLIJ is set", () => {
		setEnv({ ZELLIJ: "1" });
		const seq = `${ESC}]9;hello${BEL}`;
		assert.ok(wrapForMultiplexer(seq).startsWith(`${ESC}Ptmux;`));
	});

	it("wraps with DCS passthrough when ZELLIJ_SESSION_NAME is set", () => {
		setEnv({ ZELLIJ_SESSION_NAME: "my-session" });
		const seq = `${ESC}]9;hello${BEL}`;
		assert.ok(wrapForMultiplexer(seq).startsWith(`${ESC}Ptmux;`));
	});

	it("wraps with DCS passthrough when STY (GNU screen) is set", () => {
		setEnv({ STY: "12345.pts-0.host" });
		const seq = `${ESC}]9;hello${BEL}`;
		assert.ok(wrapForMultiplexer(seq).startsWith(`${ESC}Ptmux;`));
	});

	it("doubles every inner ESC byte inside the DCS payload", () => {
		setEnv({ TMUX: "1" });
		// OSC 99 ends with `ESC \` — both bytes need to be doubled.
		const seq = `${ESC}]99;i=1:d=0;Pi${ST}`;
		const wrapped = wrapForMultiplexer(seq);
		// ESC before `]99` doubled, ESC before `\` doubled, then DCS terminator added.
		assert.equal(
			wrapped,
			`${ESC}Ptmux;${ESC}${ESC}]99;i=1:d=0;Pi${ESC}${ESC}\\${ST}`,
		);
	});
});

// ── OSC writers ────────────────────────────────────────────────────────

describe("OSC writers", () => {
	it("notifyOSC777 writes the urxvt sequence verbatim", () => {
		const cap = captureStdout();
		try {
			notifyOSC777("Pi", "hello");
			assert.deepEqual(cap.chunks, [`${ESC}]777;notify;Pi;hello${BEL}`]);
		} finally {
			cap.restore();
		}
	});

	it("notifyOSC9 writes a single OSC 9 sequence", () => {
		const cap = captureStdout();
		try {
			notifyOSC9("Pi: hello");
			assert.deepEqual(cap.chunks, [`${ESC}]9;Pi: hello${BEL}`]);
		} finally {
			cap.restore();
		}
	});

	it("notifyOSC99 writes the two-part Kitty sequence", () => {
		const cap = captureStdout();
		try {
			notifyOSC99("Pi", "hello");
			assert.deepEqual(cap.chunks, [
				`${ESC}]99;i=1:d=0;Pi${ST}`,
				`${ESC}]99;i=1:p=body;hello${ST}`,
			]);
		} finally {
			cap.restore();
		}
	});

	it("wraps writes in DCS when TMUX is set", () => {
		const cap = captureStdout();
		setEnv({ TMUX: "1" });
		try {
			notifyOSC777("Pi", "hello");
			assert.equal(cap.chunks.length, 1);
			assert.ok(cap.chunks[0]?.startsWith(`${ESC}Ptmux;`));
			assert.ok(cap.chunks[0]?.endsWith(ST));
		} finally {
			cap.restore();
		}
	});
});

// ── isUnsupportedTerminal ──────────────────────────────────────────────

describe("isUnsupportedTerminal", () => {
	it("rejects Apple Terminal", () => {
		setEnv({ TERM_PROGRAM: "Apple_Terminal" });
		assert.equal(isUnsupportedTerminal(), true);
	});

	it("rejects Alacritty regardless of TERM_PROGRAM", () => {
		setEnv({ TERM: "alacritty" });
		assert.equal(isUnsupportedTerminal(), true);
	});

	it("rejects native win32 console when WT_SESSION is absent", () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		try {
			assert.equal(isUnsupportedTerminal(), true);
		} finally {
			Object.defineProperty(process, "platform", {
				value: "darwin",
				configurable: true,
			});
		}
	});

	it("allows win32 console when WT_SESSION is set (WSL / Windows Terminal)", () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		setEnv({ WT_SESSION: "{abc-def}" });
		try {
			assert.equal(isUnsupportedTerminal(), false);
		} finally {
			Object.defineProperty(process, "platform", {
				value: "darwin",
				configurable: true,
			});
		}
	});

	it("accepts a plain Linux environment", () => {
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});
		setEnv({ TERM_PROGRAM: "ghostty" });
		assert.equal(isUnsupportedTerminal(), false);
		Object.defineProperty(process, "platform", {
			value: "darwin",
			configurable: true,
		});
	});
});

// ── detectSender ───────────────────────────────────────────────────────

describe("detectSender", () => {
	it("returns null on Apple Terminal", () => {
		setEnv({ TERM_PROGRAM: "Apple_Terminal" });
		assert.equal(detectSender(), null);
	});

	it("returns null on Alacritty", () => {
		setEnv({ TERM: "alacritty" });
		assert.equal(detectSender(), null);
	});

	it("returns the OSC 99 sender inside Kitty", () => {
		setEnv({ KITTY_WINDOW_ID: "1" });
		const sender = detectSender();
		assert.ok(sender);
		const cap = captureStdout();
		try {
			sender!("Pi", "hello");
		} finally {
			cap.restore();
		}
		// OSC 99 ends with ST, not BEL.
		assert.ok(cap.chunks[0]?.includes(`${ESC}]99;i=1:d=0;Pi`));
	});

	it("returns the OSC 9 sender inside Ghostty", () => {
		setEnv({ TERM_PROGRAM: "ghostty" });
		const sender = detectSender();
		assert.ok(sender);
		const cap = captureStdout();
		try {
			sender!("Pi", "hello");
		} finally {
			cap.restore();
		}
		assert.deepEqual(cap.chunks, [`${ESC}]9;Pi: hello${BEL}`]);
	});

	it("returns the OSC 9 sender inside iTerm.app", () => {
		setEnv({ TERM_PROGRAM: "iTerm.app" });
		const sender = detectSender();
		assert.ok(sender);
		const cap = captureStdout();
		try {
			sender!("Pi", "hello");
		} finally {
			cap.restore();
		}
		assert.deepEqual(cap.chunks, [`${ESC}]9;Pi: hello${BEL}`]);
	});

	it("returns the OSC 9 sender when ITERM_SESSION_ID is set (overrides TERM_PROGRAM)", () => {
		setEnv({ ITERM_SESSION_ID: "w0t0p1:ABC" });
		const sender = detectSender();
		assert.ok(sender);
	});

	it("falls back to OSC 777 on WezTerm / rxvt-unicode / plain Linux", () => {
		setEnv({ TERM_PROGRAM: "WezTerm" });
		const sender = detectSender();
		assert.ok(sender);
		const cap = captureStdout();
		try {
			sender!("Pi", "hello");
		} finally {
			cap.restore();
		}
		assert.deepEqual(cap.chunks, [`${ESC}]777;notify;Pi;hello${BEL}`]);
	});
});

// ── Extension factory ─────────────────────────────────────────────────

interface Registration {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	commands: Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: ExtensionContext) => unknown;
		}
	>;
	notices: Array<{ message: string; level: string | undefined }>;
}

function setupFactory(): { reg: Registration; ctx: ExtensionContext } {
	const reg: Registration = {
		handlers: new Map(),
		commands: new Map(),
		notices: [],
	};

	const api = {
		on(
			event: string,
			handler: (event: unknown, ctx: ExtensionContext) => unknown,
		) {
			reg.handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			def: {
				description: string;
				handler: (args: string, ctx: ExtensionContext) => unknown;
			},
		) {
			reg.commands.set(name, def);
		},
	} as unknown as ExtensionAPI;

	factory(api);

	const ctx: ExtensionContext = {
		ui: {
			notify(message, level) {
				reg.notices.push({ message, level });
			},
		},
		sessionManager: {
			getSessionName: () => "test-session",
		},
	};

	return { reg, ctx };
}

describe("extension factory", () => {
	it("registers the expected lifecycle handlers", () => {
		const { reg } = setupFactory();
		assert.ok(reg.handlers.has("agent_start"));
		assert.ok(reg.handlers.has("turn_end"));
		assert.ok(reg.handlers.has("tool_execution_end"));
		assert.ok(reg.handlers.has("agent_settled"));
	});

	it("registers exactly one command named 'notify'", () => {
		const { reg } = setupFactory();
		assert.equal(reg.commands.size, 1);
		assert.ok(reg.commands.has("notify"));
		assert.match(reg.commands.get("notify")?.description ?? "", /OSC/i);
	});

	it("emits an OSC notification on agent_settled", () => {
		setEnv({ TERM_PROGRAM: "ghostty" });
		const cap = captureStdout();
		const { reg, ctx } = setupFactory();
		try {
			// Drive the lifecycle: agent_start → turn_end → tool calls → agent_settled.
			reg.handlers.get("agent_start")?.({}, ctx);
			reg.handlers.get("turn_end")?.({}, ctx);
			reg.handlers.get("tool_execution_end")?.({ toolName: "bash" }, ctx);
			reg.handlers.get("tool_execution_end")?.({ toolName: "bash" }, ctx);
			reg.handlers.get("tool_execution_end")?.({ toolName: "read" }, ctx);
			reg.handlers.get("tool_execution_end")?.(
				{ toolName: "edit", isError: true },
				ctx,
			);
			reg.handlers.get("agent_settled")?.({}, ctx);

			assert.equal(cap.chunks.length, 1);
			const out = cap.chunks[0] ?? "";
			assert.ok(
				out.startsWith(`${ESC}]9;`),
				`expected OSC 9 prefix, got ${JSON.stringify(out)}`,
			);
			// Ghostty's OSC 9 path: "Pi: <body>" — body must include the stats and session.
			assert.match(
				out,
				/\u2717 Pi \u00B7 1 turn \u00B7 4 tools \(3 unique\) \u00B7 1 error \u00B7 /,
			);
			assert.match(out, /\u00B7 test-session\x07/);
		} finally {
			cap.restore();
		}
	});

	it("falls back to a TUI notice when the terminal is unsupported", () => {
		setEnv({ TERM_PROGRAM: "Apple_Terminal" });
		const cap = captureStdout();
		const { reg, ctx } = setupFactory();
		try {
			reg.handlers.get("agent_start")?.({}, ctx);
			reg.handlers.get("agent_settled")?.({}, ctx);
			assert.deepEqual(cap.chunks, []);
			assert.equal(reg.notices.length, 1);
			assert.match(reg.notices[0]?.message ?? "", /OSC notifications unsupported/);
		} finally {
			cap.restore();
		}
	});

	it("/notify command defaults to 'Waiting for your input' when called with no args", () => {
		setEnv({ TERM_PROGRAM: "ghostty" });
		const cap = captureStdout();
		const { reg, ctx } = setupFactory();
		try {
			reg.commands.get("notify")?.handler("", ctx);
			assert.match(cap.chunks[0] ?? "", /Waiting for your input/);
		} finally {
			cap.restore();
		}
	});

	it("/notify command uses the supplied argument", () => {
		setEnv({ TERM_PROGRAM: "ghostty" });
		const cap = captureStdout();
		const { reg, ctx } = setupFactory();
		try {
			reg.commands.get("notify")?.handler("  custom message  ", ctx);
			assert.match(cap.chunks[0] ?? "", /custom message/);
		} finally {
			cap.restore();
		}
	});

	it("resets stats on agent_start so a second settled emits fresh numbers", () => {
		setEnv({ TERM_PROGRAM: "ghostty" });
		const cap = captureStdout();
		const { reg, ctx } = setupFactory();
		try {
			// First run.
			reg.handlers.get("agent_start")?.({}, ctx);
			reg.handlers.get("turn_end")?.({}, ctx);
			reg.handlers.get("turn_end")?.({}, ctx);
			reg.handlers.get("agent_settled")?.({}, ctx);
			cap.chunks.length = 0;

			// Second run.
			reg.handlers.get("agent_start")?.({}, ctx);
			reg.handlers.get("turn_end")?.({}, ctx);
			reg.handlers.get("agent_settled")?.({}, ctx);
			assert.match(cap.chunks[0] ?? "", /\u2713 Pi \u00B7 1 turn \u00B7 /);
		} finally {
			cap.restore();
		}
	});
});
