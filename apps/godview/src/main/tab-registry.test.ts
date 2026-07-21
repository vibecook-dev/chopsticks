import { describe, expect, it } from 'vitest';
import { GodviewTabRegistry } from './tab-registry.js';

describe('GodviewTabRegistry', () => {
  it('isolates session ownership and tab order by native group', () => {
    const registry = new GodviewTabRegistry<object>();
    const first = {};
    const second = {};
    const otherWindow = {};
    registry.add(first, 'first', 'group-a');
    registry.add(second, 'second', 'group-a');
    registry.add(otherWindow, 'other', 'group-b');
    registry.updateSessions(second, ['session-2']);

    expect(registry.group('group-a').map((record) => record.id)).toEqual(['first', 'second']);
    expect(registry.tabAt(first, 9)?.id).toBe('second');
    expect(registry.get(second)?.sessionIds).toEqual(new Set(['session-2']));
    expect(registry.get(otherWindow)?.sessionIds).toEqual(new Set());
  });

  it('removes only the closed tab', () => {
    const registry = new GodviewTabRegistry<object>();
    const first = {};
    const second = {};
    registry.add(first, 'first', 'group');
    registry.add(second, 'second', 'group');

    expect(registry.delete(first)?.id).toBe('first');
    expect(registry.group('group').map((record) => record.id)).toEqual(['second']);
  });
});
