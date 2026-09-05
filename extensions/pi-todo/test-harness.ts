/**
 * Test harness shared by index.test.ts.
 *
 * Provides a minimal ExtensionAPI / ExtensionContext stub that captures
 * every registration the factory makes, lets the test invoke captured
 * command handlers + lifecycle handlers, and asserts on
 * ctx.ui.notify / ui.setWidget side-effects.
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

export interface WidgetCall {
	key: string;
	value: unknown;
	options?: { placement?: string };
	rendered?: string[][];
}

export type CustomImpl = (
	factory: (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
		done: (result: unknown) => void,
	) => unknown,
	options: unknown,
) => Promise<unknown>;

export const widgetCalls: WidgetCall[] = [];

/** Captured tool registrations (for tool-def regression tests). */
export const toolDefs: Array<Record<string, unknown>> = [];

const handlers = new Map<
	string,
	(args: unknown, ctx: ExtensionContext) => unknown
>();

/** P4-C1: lifecycle handler registry (session_start / compact / tree /
 *  shutdown / tool_execution_end). Keyed by event name. */
type LifecycleHandler = (event: unknown, ctx: unknown) => Promise<void> | void;
const lifecycleHandlers = new Map<string, LifecycleHandler>();

let interactive = true;

export const sessionId = "test-session";

interface Harness {
	api: ExtensionAPI;
	ctx: ExtensionContext;
	handlers: Map<string, (args: unknown, ctx: ExtensionContext) => unknown>;
	sessionId: string;
	setInteractive(value: boolean): void;
	setCustom(impl: CustomImpl | undefined): void;
	triggerLifecycle(
		event: string,
		payload: unknown,
		ctx?: unknown,
	): Promise<void> | void;
}

function buildHarness(): Harness {
	// SAFETY: the harness implements exactly the ExtensionAPI methods the
	// factory (index.ts) calls: registerTool, registerCommand, and on.
	// The cast keeps the literal shape narrow without forcing every
	// unused ExtensionAPI method to be stubbed.
	const api = {
		registerTool(def: unknown) {
			toolDefs.push(def as Record<string, unknown>);
		},
		registerCommand(
			name: string,
			def: { handler: (args: unknown, ctx: ExtensionContext) => unknown },
		) {
			handlers.set(name, def.handler);
		},
		on(event: string, handler: unknown) {
			lifecycleHandlers.set(event, handler as LifecycleHandler);
		},
	} as unknown as ExtensionAPI;

	// SAFETY: same idea — only the ExtensionContext fields touched by the
	// /todos handler + lifecycle hooks are present (hasUI,
	// sessionManager.getSessionId, ui.notify and ui.setWidget).
	// Missing fields are intentional (harness is for tests, not the full API).
	const ctx = {
		hasUI: interactive,
		sessionManager: {
			getSessionId: () => sessionId,
		},
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level });
			},
			setWidget(key: string, value: unknown, options?: { placement?: string }) {
				// If the widget factory returns a renderable object with
				// `render(width)`, capture each rendered output for the
				// test to assert on.
				let rendered: string[][] | undefined;
				if (typeof value === "function") {
					const tui = { requestRender: () => {} };
					const produced = (value as (tui: unknown) => unknown)(tui);
					if (
						produced &&
						typeof (produced as { render?: unknown }).render === "function"
					) {
						// Capture render at the registered width 80 (overlay
						// default). Tests that need other widths construct
						// their own harness.
						rendered = [(produced as { render: (w: number) => string[] }).render(80)];
					}
				}
				widgetCalls.push({ key, value, options, rendered });
			},
		},
		// SAFETY: this object implements exactly the ExtensionContext surface
		// the extension touches (hasUI / sessionManager / ui.notify /
		// ui.setWidget); the double cast only bridges the partial shape to the
		// full interface for the tests.
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
		triggerLifecycle(
			event: string,
			payload: unknown,
			ctx?: unknown,
		): Promise<void> | void {
			const handler = lifecycleHandlers.get(event);
			if (!handler) {
				throw new Error(`no lifecycle handler registered for "${event}"`);
			}
			return handler(payload, ctx ?? ctx);
		},
		setCustom(impl: CustomImpl | undefined) {
			const ui = (ctx as unknown as { ui: Record<string, unknown> }).ui;
			if (impl) ui.custom = impl;
			else delete ui.custom;
		},
	};
}

export const commandRegistry: Harness = buildHarness();

export function resetHarness(): void {
	notices.length = 0;
	widgetCalls.length = 0;
	toolDefs.length = 0;
	handlers.clear();
	lifecycleHandlers.clear();
	interactive = true;
	(commandRegistry.ctx as { hasUI: boolean }).hasUI = true;
	delete (commandRegistry.ctx as unknown as { ui: Record<string, unknown> }).ui.custom;
	__resetState();
}
