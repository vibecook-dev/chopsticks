import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPersona, personaDirectory } from './load.ts';
import { OP_NAMES } from './types.ts';

describe('loadPersona', () => {
  it('loads the claude persona against the adapter-owned ASM', () => {
    const persona = loadPersona('claude');
    expect(persona.vendor).toBe('claude');
    // Version comes from the ASM manifest, never from persona.json — the
    // captured model is the single source of vendor truth (§3.3).
    expect(persona.version).toBe('2.1.207');
    expect(persona.channels).toEqual(['argv', 'hook', 'transcript', 'statusline', 'terminal']);
  });

  it('exposes ASM payload validation over the full wire payload, envelope included', () => {
    const persona = loadPersona('claude');
    // `validate` sees exactly what hits the bridge: the session merges its
    // envelope (session_id/transcript_path/cwd) and the emitter appends
    // hook_event_name, so a payload missing them is genuinely off-model.
    const envelope = {
      session_id: 's',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      hook_event_name: 'Notification',
    };
    expect(
      persona.validate('Notification', { ...envelope, message: 'fine', notification_type: 'x', prompt_id: 'p' }),
    ).toEqual([]);
    expect(persona.validate('Notification', { ...envelope, message: 42 })).toContain(
      'field "message" is number, expected string',
    );
    expect(persona.validate('Notification', { message: 'fine' })).toContain('missing required field "session_id"');
  });

  it('reads argv flag aliases out of detection.json rather than hardcoding them', () => {
    const persona = loadPersona('claude');
    expect(persona.flagsFor('name', '--name')).toEqual(['-n', '--name']);
    expect(persona.flagsFor('sessionId', '--session-id')).toEqual(['--session-id']);
    expect(persona.flagsFor('resume', '--resume')).toEqual(['--resume']);
    // Unknown keys fall back rather than throwing: a persona may reference a
    // flag a given vendor version does not advertise.
    expect(persona.flagsFor('nonesuch', '--fallback')).toEqual(['--fallback']);
  });

  it('binds every op it declares to a channel the ASM knows', () => {
    const persona = loadPersona('claude');
    for (const [op, bindings] of Object.entries(persona.ops)) {
      expect(OP_NAMES).toContain(op);
      for (const binding of bindings) {
        if (binding.channel === 'hook') expect(persona.schemaFor(binding.event!)).toBeDefined();
      }
    }
    // session.ready is the driver's boot-finished signal; without it a spawned
    // session never reaches `ready`.
    expect(persona.ops['session.ready']).toBeDefined();
  });

  it('declares boot ops that all exist in the ops document', () => {
    const persona = loadPersona('claude');
    for (const invocation of persona.document.boot) {
      expect(persona.ops[invocation.op], `boot op ${invocation.op} is unmapped`).toBeDefined();
    }
  });

  it('resolves personas by name only, rejecting traversal', () => {
    expect(() => personaDirectory('../../etc')).toThrow(/lowercase letters/);
    expect(() => personaDirectory('Claude')).toThrow(/lowercase letters/);
  });
});

describe('loadPersona validation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-persona-'));
    mkdirSync(join(dir, 'broken'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (persona: unknown, ops: unknown): string => {
    writeFileSync(join(dir, 'broken', 'persona.json'), JSON.stringify(persona));
    writeFileSync(join(dir, 'broken', 'ops.json'), JSON.stringify(ops));
    return join(dir, 'broken');
  };

  const validPersona = {
    vendor: 'broken',
    asm: { package: '@vibecook/chopsticks-adapter-claude', path: 'surface/model/claude@2.1.207' },
    shimNames: ['broken'],
    envelope: { session_id: '$sessionId' },
    eventNameField: 'hook_event_name',
    boot: [],
  };

  it('rejects an op bound to a hook event the ASM has never seen', () => {
    const directory = write(validPersona, {
      'turn.end': [{ channel: 'hook', event: 'NoSuchHookEvent', with: {} }],
    });
    expect(() => loadPersona('broken', { directory })).toThrow(/not in the ASM/);
  });

  it('rejects an unknown op name', () => {
    const directory = write(validPersona, { 'turn.teleport': [{ channel: 'hook', event: 'Stop' }] });
    expect(() => loadPersona('broken', { directory })).toThrow(/unknown op/);
  });

  it('rejects a persona whose declared vendor does not match its directory', () => {
    const directory = write({ ...validPersona, vendor: 'somethingelse' }, {});
    expect(() => loadPersona('broken', { directory })).toThrow(/declares vendor/);
  });
});
