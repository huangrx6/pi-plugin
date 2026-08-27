/**
 * Test harness shared by index.test.ts.
 *
 * Provides a minimal ExtensionAPI / ExtensionContext stub that captures
 * every registration the factory makes, lets the test invoke captured
 * command handlers, and asserts on ctx.ui.notify side-effects.
 *
 * This file exists ONLY to keep the test surface focused. The factory
 * (index.ts) is not modified; it sees an object that quacks like the
 * real ExtensionAPI.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { __resetState } from "./store.ts";

// ── Captured state ──────────────────────────────────────────────────────

export const notices: Array<{ message: string; level: string | undefined }> =
	[];

const handlers = new Map<
	string,
	(args: unknown, ctx: ExtensionContext) => unknown
>();
let interactive = true;

export const sessionId = "test-session";

interface Harness {
	api: ExtensionAPI;
	ctx: ExtensionContext;
	handlers: Map<string, (args: unknown, ctx: ExtensionContext) => unknown>;
	sessionId: string;
	setInteractive(value: boolean): void;
}

function buildHarness(): Harness {
	// SAFETY: the harness implements exactly the ExtensionAPI methods the
	// factory (index.ts) calls during /todos command parsing: registerTool,
	// registerCommand, and on. Other ExtensionAPI members are not exercised
	// by these tests; the cast keeps the literal shape narrow without
	// forcing every unused method to be stubbed.
	const api = {
		registerTool(_def: unknown) {
			/* not exercised by /todos parsing tests */
		},
		registerCommand(
			name: string,
			def: { handler: (args: unknown, ctx: ExtensionContext) => unknown },
		) {
			handlers.set(name, def.handler);
		},
		on(_event: string, _handler: unknown) {
			/* not exercised here */
		},
	} as unknown as ExtensionAPI;

	// SAFETY: same idea — only the ExtensionContext fields touched by the
	// /todos handler are present (hasUI, sessionManager.getSessionId,
	// ui.notify). The factory's other lifecycle handlers aren't invoked
	// in these tests, so missing fields are intentional.
	const ctx = {
		hasUI: interactive,
		sessionManager: {
			getSessionId: () => sessionId,
		},
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	return {
		api,
		ctx,
		handlers,
		sessionId,
		setInteractive(value: boolean) {
			interactive = value;
			(ctx as { hasUI: boolean }).hasUI = value;
		},
	};
}

export const commandRegistry: Harness = buildHarness();

export function resetHarness(): void {
	notices.length = 0;
	handlers.clear();
	interactive = true;
	(commandRegistry.ctx as { hasUI: boolean }).hasUI = true;
	__resetState();
}
