import assert from 'node:assert/strict';
import test from 'node:test';
import { PiEventSpool } from '../../src/runtime/pi/event-spool.js';

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
  const spool = new PiEventSpool(journal as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 4096, maxEvents: 1, maxQueuedBatches: 1 });
  spool.record(update('a') as never); spool.record(update('b') as never);
  assert.ok(spool.state.overflow); release();
  await assert.rejects(spool.drain(), /durable batch limit/);
  assert.ok(entries.some(entry => entry.source === 'pi.event.overflow'));
});

test('Pi event spool makes an oversized single event an explicit unknown tail', async () => {
  const entries: Entry[] = []; const spool = new PiEventSpool(fakeJournal(entries) as never, { commandId: 'command', attemptId: 'attempt', sessionId: 'session' }, { maxBytes: 64, maxEvents: 64, maxQueuedBatches: 1 });
  spool.record(update('x'.repeat(256)) as never);
  await assert.rejects(spool.drain(), /byte limit/);
  assert.equal(entries.filter(entry => entry.source === 'pi.event').length, 0);
  assert.equal(entries.filter(entry => entry.source === 'pi.event.overflow').length, 1);
});
