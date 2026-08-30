import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MachineCodec, encodeRequest } from '../src/daemon/protocol.ts';

/** Collect everything a codec emits while feeding it chunks. */
function drain(chunks: string[]) {
  const codec = new MachineCodec();
  const events: any[] = [];
  const responses: any[] = [];
  const raw: string[] = [];
  codec.on('event', (e) => events.push(e));
  codec.on('response', (r) => responses.push(r));
  codec.on('raw', (l) => raw.push(l));
  for (const c of chunks) codec.push(c);
  return { events, responses, raw };
}

test('messages are unwrapped from their single-element array envelope', () => {
  const { events } = drain(['[{"event":"daemon.connected","params":{"version":"0.6.1"}}]\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'daemon.connected');
  assert.equal(events[0].params.version, '0.6.1');
});

test('parses the real captured daemon transcript', () => {
  const transcript = readFileSync('test/fixtures/daemon-devices.txt', 'utf8');
  const { events, responses } = drain([transcript]);

  const added = events.filter((e) => e.event === 'device.added');
  assert.equal(added.length, 5);
  const iphone = added.find((e) => e.params.name === 'iPhone 17 Pro')!;
  assert.equal(iphone.params.id, '48F0A0D1-0CEC-4781-B73B-BE0F494DD23D');
  assert.equal(iphone.params.platformType, 'ios');
  // capabilities drive what the HUD and the MCP screenshot tool may offer
  assert.equal(iphone.params.capabilities.hotReload, true);
  assert.equal(iphone.params.capabilities.screenshot, true);

  // `[{"id":2}]` is a valid success response carrying no result field
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 2);
  assert.equal(responses[0].error, undefined);
});

test('reassembles a message split across chunk boundaries', () => {
  const { events } = drain(['[{"event":"app.st', 'arted","params":{"appId"', ':"xyz"}}]\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'app.started');
  assert.equal(events[0].params.appId, 'xyz');
});

test('emits nothing until a line is terminated', () => {
  const codec = new MachineCodec();
  const seen: any[] = [];
  codec.on('event', (e) => seen.push(e));
  codec.push('[{"event":"app.started","params":{}}]');
  assert.equal(seen.length, 0, 'an unterminated line must stay buffered');
  codec.push('\n');
  assert.equal(seen.length, 1);
});

test('non-protocol output is surfaced as raw, never crashes the parser', () => {
  const { events, raw } = drain([
    'Launching lib/main.dart on iPhone 17 Pro...\n',
    '[{"event":"app.start","params":{"appId":"a1"}}]\n',
    'Warning: something unstructured\n',
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual(raw, ['Launching lib/main.dart on iPhone 17 Pro...', 'Warning: something unstructured']);
});

test('a line that looks like JSON but is malformed is raw, not fatal', () => {
  const { events, raw } = drain(['[{"event":"broken", \n', '[{"event":"app.started","params":{}}]\n']);
  assert.equal(events.length, 1);
  assert.equal(raw.length, 1);
});

test('encodeRequest produces the array envelope the daemon expects', () => {
  const line = encodeRequest(7, 'app.restart', { appId: 'a1', fullRestart: false });
  assert.equal(line, '[{"id":7,"method":"app.restart","params":{"appId":"a1","fullRestart":false}}]');
  assert.deepEqual(JSON.parse(line)[0].params.fullRestart, false);
});

test('handles CRLF line endings', () => {
  const { events } = drain(['[{"event":"app.started","params":{}}]\r\n']);
  assert.equal(events.length, 1);
});
