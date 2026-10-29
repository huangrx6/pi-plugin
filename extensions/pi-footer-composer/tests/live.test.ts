import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveUsage } from '../live.ts';
import { emptySnapshot } from '../types.ts';
import { addMessage } from '../data.ts';
import footerExtension from '../index.ts';
import { defaultFooterConfig } from '../config.ts';

test('stream projections replace partial usage, never accumulate estimates into history', () => {
  const base = emptySnapshot(); base.context = { tokens: 100, contextWindow: 1000, percent: 10 };
  base.usage.output = 10;
  const live = createLiveUsage(); live.start();
  live.update({ type: 'thinking_delta', delta: '思考abcd' });
  const timing = { elapsedMs: 1500, generationMs: 1000 };
  const a = live.project(base, timing);
  assert.equal(a.usage.output, 13); assert.equal(a.steps, 1);
  assert.equal(a.context?.tokens, 103); assert.equal(a.live?.rate, 3); assert.equal(a.live?.estimated, true);
  assert.equal(base.usage.output, 10); assert.equal(base.steps, 0);
  assert.deepEqual(live.project(base, timing), a);
  live.update({ type: 'toolcall_delta', delta: 'abcd' }, { input: 20, output: 8, cacheRead: 80 });
  const b = live.project(base, timing);
  assert.equal(b.usage.output, 18); assert.equal(b.usage.input, 20); assert.equal(b.context?.tokens, 108); assert.equal(b.live?.estimated, false);
  live.update(undefined, { input: 20, output: 9, cacheRead: 80 });
  assert.equal(live.project(base, timing).usage.output, 19);
  live.reset(); addMessage(base, { role: 'assistant', usage: { input: 20, output: 9, cacheRead: 80 } });
  assert.equal(live.project(base, null), base); assert.equal(base.steps, 1); assert.equal(base.usage.output, 19);
  live.start(); live.update({ type: 'text_delta', delta: 'new' }); live.reset();
  assert.equal(live.project(base, timing), base);
});

test('live meter waits for a stable window, sanitizes unknown usage and preserves unknown context', () => {
  const live = createLiveUsage(), base = emptySnapshot(); live.start();
  live.update({ type: 'text_delta', delta: 'abcd' }, { input: NaN, output: Infinity, cacheRead: -1 });
  const s = live.project(base, { elapsedMs: 100, generationMs: 20 });
  assert.equal(s.live?.rate, null); assert.equal(s.context, null); assert.equal(s.usage.output, 1); assert.equal(s.usage.input, 0);
});

test('ticker keeps publishing after first content; completion and shutdown stop updates', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const handlers = new Map<string, Function>(); let now = 0, renders = 0, component: any;
  const entries: any[] = [];
  const ctx = { hasUI: true, mode: 'tui', model: { id: 'demo', contextWindow: 1000 },
    sessionManager: { getBranch: () => entries }, getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    ui: { notify() {}, select: async () => undefined, setFooter(factory: any) {
      component = factory({ mode: 'regular', requestRender() { renders++; } }, { fg: (_: string, text: string) => text }, { getExtensionStatuses: () => new Map() });
    } } };
  footerExtension({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand() {}, appendEntry: (customType: string, data: any) => entries.push({type:'custom',customType,data}) } as never,
    { now: () => now, configStore: { load: defaultFooterConfig, save() {} } });
  const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  emit('session_start'); emit('agent_start'); emit('message_end', { message: {role:'user'} });
  emit('before_provider_request'); emit('message_start', {message:{role:'assistant'}});
  now = 200; emit('message_update', {assistantMessageEvent:{type:'thinking_delta',delta:'x'.repeat(400)}});
  const firstRenders = renders;
  now = 1200; t.mock.timers.tick(250);
  assert.ok(renders > firstRenders); assert.match(component.render(160)[0], /≈100 tok\/s/);
  emit('message_update', {assistantMessageEvent:{type:'text_delta',delta:'x'.repeat(400)}});
  now = 2200; t.mock.timers.tick(250);
  assert.match(component.render(160)[0], /≈200 tok/);
  now = 2400; emit('message_end', {message:{role:'assistant',usage:{output:150}}});
  assert.doesNotMatch(component.render(160)[0], /≈/); assert.match(component.render(160)[0], /1 轮 1 步/);
  const doneRenders = renders; t.mock.timers.tick(1000); assert.equal(renders, doneRenders);
  emit('before_provider_request'); emit('session_shutdown');
  const shutdownRenders = renders; t.mock.timers.tick(1000); assert.equal(renders, shutdownRenders);
});
