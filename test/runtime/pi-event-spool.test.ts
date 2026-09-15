import assert from 'node:assert/strict';
import test from 'node:test';
import { PI_EVENT_MAX_BYTES, PiEventSpool } from '../../src/runtime/pi/event-spool.js';

type Entry = { source: string; sourceIdentity: string; bytes: Buffer };
const fakeJournal = (entries: Entry[]) => ({ append: async (input: { source: string; sourceIdentity: string; bytes: Uint8Array }) => { entries.push({ source: input.source, sourceIdentity: input.sourceIdentity, bytes: Buffer.from(input.bytes) }); return { ref: `raw:sha256:${entries.length}`, hash: `sha256:${entries.length}`, mediaType: 'application/json' }; } });
const update = (delta: string) => ({ type: 'message_update', message: { role: 'assistant', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, content: [{ type: 'thinking', thinking: delta }] }, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta, partial: { ignored: true } } });

test('Pi event spool preserves ordered delta updates in bounded batches without cumulative snapshots', async () => {
  const entries: Entry[] = []; const spool = new PiEventSpool(fakeJournal(entries) as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 64 * 1024, maxEvents: 64, maxQueuedBatches: 64 });
  for (let index = 0; index < 1400; index += 1) spool.record(update(String.fromCharCode(97 + index % 26)) as never);
  spool.record({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } } as never);
  await spool.drain();
  const batches = entries.filter(entry => entry.source === 'pi.event').map(entry => JSON.parse(entry.bytes.toString('utf8')));
  const events = batches.flatMap(batch => batch.events);
  assert.equal(events.length, 1401);
  assert.deepEqual(events.map((entry: { sequence: number }) => entry.sequence), Array.from({ length: 1401 }, (_, index) => index + 1));
  assert.equal(events[0].event.assistantMessageEvent.partial, undefined);
  assert.equal(events[0].event.assistantMessageEvent.delta, 'a');
  assert.equal(spool.state.queuedBatches, 0); assert.equal(spool.state.overflow, undefined);
});

test('Pi event spool makes an overfull durable queue explicit instead of silently dropping a tail', async () => {
  const entries: Entry[] = []; let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const journal = { append: async (input: { source: string; sourceIdentity: string; bytes: Uint8Array }) => { await blocked; entries.push({ source: input.source, sourceIdentity: input.sourceIdentity, bytes: Buffer.from(input.bytes) }); return { ref: 'raw:sha256:1', hash: 'sha256:1', mediaType: 'application/json' }; } };
  const spool = new PiEventSpool(journal as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 4096, maxEvents: 1, maxQueuedBatches: 2 });
  spool.record(update('a') as never); spool.record(update('b') as never);
  assert.ok(spool.state.overflow); release();
  await assert.rejects(spool.drain(), /durable batch limit/);
  assert.ok(entries.some(entry => entry.source === 'pi.event.overflow'));
});

test('Pi event spool makes an oversized single event an explicit unknown tail', async () => {
  const entries: Entry[] = []; const spool = new PiEventSpool(fakeJournal(entries) as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 64, maxEvents: 64, maxQueuedBatches: 2 });
  spool.record(update('x'.repeat(PI_EVENT_MAX_BYTES)) as never);
  await assert.rejects(spool.drain(), /byte limit/);
  assert.equal(entries.filter(entry => entry.source === 'pi.event').length, 0);
  assert.equal(entries.filter(entry => entry.source === 'pi.event.overflow').length, 1);
});

test('Pi event spool retains a complete terminal message larger than the batch limit', async () => {
  const entries: Entry[] = []; const spool = new PiEventSpool(fakeJournal(entries) as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 64, maxEvents: 1, maxQueuedBatches: 2 });
  const text = 't'.repeat(128 * 1024);
  spool.record({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } } as never);
  await spool.drain();
  const batch = JSON.parse(entries.find(entry => entry.source === 'pi.event')!.bytes.toString('utf8'));
  assert.equal(batch.events[0].event.message.content[0].text, text);
  assert.equal(spool.state.overflow, undefined);
});

test('Pi event spool snapshots an event at observation and preserves a buffered valid prefix before overflow', async () => {
  const entries: Entry[] = []; const spool = new PiEventSpool(fakeJournal(entries) as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 4096, maxEvents: 64, maxQueuedBatches: 2 });
  const observed = update('a') as { assistantMessageEvent: { delta: string }; message: { content: Array<{ thinking: string }> } } & Parameters<PiEventSpool['record']>[0];
  spool.record(observed); observed.assistantMessageEvent.delta = 'mutated'; observed.message.content[0].thinking = 'mutated';
  spool.record(update('x'.repeat(PI_EVENT_MAX_BYTES)) as never);
  await assert.rejects(spool.drain(), /single-event byte limit/);
  const prefix = JSON.parse(entries.find(entry => entry.source === 'pi.event')!.bytes.toString('utf8'));
  assert.equal(prefix.events[0].sequence, 1); assert.equal(prefix.events[0].event.assistantMessageEvent.delta, 'a');
  const overflow = JSON.parse(entries.find(entry => entry.source === 'pi.event.overflow')!.bytes.toString('utf8'));
  assert.equal(overflow.firstUnpersistedSequence, 2);
});

test('Pi event spool reserves space for a buffered prefix and its unknown-tail marker', async () => {
  const entries: Entry[] = []; let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const journal = { append: async (input: { source: string; sourceIdentity: string; bytes: Uint8Array }) => { await blocked; entries.push({ source: input.source, sourceIdentity: input.sourceIdentity, bytes: Buffer.from(input.bytes) }); return { ref: `raw:sha256:${entries.length}`, hash: `sha256:${entries.length}`, mediaType: 'application/json' }; } };
  const spool = new PiEventSpool(journal as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 4096, maxEvents: 2, maxQueuedBatches: 3 });
  spool.record(update('a') as never); assert.ok(spool.state.queuedBatches <= 3);
  spool.record(update('b') as never); assert.ok(spool.state.queuedBatches <= 3);
  spool.record(update('c') as never); assert.ok(spool.state.queuedBatches <= 3);
  spool.record({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } } as never); assert.ok(spool.state.queuedBatches <= 3);
  release(); await assert.rejects(spool.drain(), /durable batch limit/);
  assert.ok(entries.every((_, index) => index < 3));
  const events = entries.filter(entry => entry.source === 'pi.event').flatMap(entry => JSON.parse(entry.bytes.toString('utf8')).events);
  assert.deepEqual(events.map((entry: { sequence: number }) => entry.sequence), [1, 2, 3]);
  const marker = JSON.parse(entries.find(entry => entry.source === 'pi.event.overflow')!.bytes.toString('utf8'));
  assert.equal(marker.firstUnpersistedSequence, 4);
});
