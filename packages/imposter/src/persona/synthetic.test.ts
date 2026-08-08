/**
 * The not-a-real-vendor contract check (draft/IMPOSTER.md §7.4).
 *
 * A persona contract validated against one vendor comes out shaped like that
 * vendor. `synthetic` exists to make that failure loud: its ASM is invented, and
 * every structural choice in it is deliberately unlike claude — different
 * channel names, no statusline at all, different argv flags, a different
 * envelope, and a different field carrying the event name.
 *
 * Nothing here is evidence of anything. If a change makes this file fail, the
 * fix is in the contract, not in the fixture.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { imposterBinPath } from '../cli/shims.ts';
import { createImposterSession, type BehaviorDocument } from '../session/session.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('synthetic');
const behavior = JSON.parse(
  readFileSync(join(personaDirectory('synthetic'), 'behavior', 'happy-turn.json'), 'utf8'),
) as BehaviorDocument;

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function session(log?: (message: string) => void) {
  const home = mkdtempSync(join(tmpdir(), 'chopsticks-synthetic-'));
  temporaries.push(home);
  return createImposterSession({
    persona,
    argv: ['--sid', 'synth-0001', '--label', 'contract-check'],
    env: { CHOPSTICKS_IMPOSTER_HOME: home },
    cwd: '/work',
    behavior,
    ...(log ? { log } : {}),
  });
}

describe('the synthetic persona', () => {
  it('loads an ASM that no adapter owns, because no vendor exists to own it', () => {
    expect(persona.document.asm.package).toBeUndefined();
    expect(persona.model.manifest.source).toMatch(/INVENTED/);
    expect(persona.model.events.every((event) => event.confidence === 'unverified')).toBe(true);
  });

  it('names its channels differently from claude, and has no statusline at all', () => {
    expect(persona.channels).toEqual(['argv', 'event', 'transcript']);
    expect(persona.channelFor('hook')).toBe('event');
    expect(persona.channelFor('statusline')).toBeUndefined();
  });

  it("reads its own argv flags, not claude's", () => {
    expect(persona.flagsFor('sessionId', '--session-id')).toEqual(['--sid']);
    expect(session().sessionId).toBe('synth-0001');
  });

  it('emits its own envelope and event-name field, with no claude keys anywhere', async () => {
    const live = session();
    await live.boot();
    const payloads = live.emitted.map((entry) => entry.payload!);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ sid: 'synth-0001', workdir: '/work' });
      expect(payload.kind).toBeTypeOf('string');
      expect(payload).not.toHaveProperty('session_id');
      expect(payload).not.toHaveProperty('hook_event_name');
      expect(payload).not.toHaveProperty('transcript_path');
    }
  });

  it('maps the shared op vocabulary onto its own event names', async () => {
    const live = session();
    await live.boot();
    await live.turn('what is this');
    expect(live.emitted.map((entry) => entry.event)).toEqual([
      'agent.boot',
      'agent.boot',
      'agent.prompt',
      'agent.action',
      'agent.action',
      'agent.reply',
      'agent.settled',
    ]);
    const reply = live.emitted.find((entry) => entry.event === 'agent.reply')!;
    expect(reply.payload).toMatchObject({ utterance: 'synthetic: acknowledged' });
  });

  it('refuses an off-model payload against its own schema', async () => {
    const live = session();
    await expect(live.emit('agent.reply', { utterance: 7, turn: 'x' })).rejects.toThrow(/utterance.*number/);
    await expect(live.emit('agent.reply', { turn: 'x' })).rejects.toThrow(/utterance/);
  });

  it("honours a channel drop addressed by the vendor's channel name", async () => {
    const messages: string[] = [];
    const live = session((message) => messages.push(message));
    await live.applyFault({ kind: 'channel-drop', channel: 'event' });
    expect(live.liveChannels).toEqual(['argv', 'transcript']);

    // The drop has to actually suppress delivery, not just hide the channel:
    // keyed by the imposter's internal `hook` name it silently did nothing here
    // before 2026-08-08, because this vendor calls that channel `event`.
    await live.emit('agent.boot', { label: 'after the drop' });
    expect(messages).toContain('dropped agent.boot: hook channel is disconnected');
  });

  it('runs a turn with no statusline channel configured', async () => {
    const live = session();
    await live.boot();
    await expect(live.turn('still fine')).resolves.toBeUndefined();
  });

  it('answers its own detection surface through the CLI', () => {
    const output = execFileSync(process.execPath, [imposterBinPath(), '--synthetic', '-V'], {
      encoding: 'utf8',
    });
    expect(output.trim()).toBe('synthetic 0.0.0 (not a real agent)');
  });
});
