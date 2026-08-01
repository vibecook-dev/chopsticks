import { describe, expect, it } from 'vitest';
import { allocateWorkspaceSlot } from './workspace-slots.js';

describe('allocateWorkspaceSlot', () => {
  it('hands the same slot back once a window releases it', () => {
    const first = allocateWorkspaceSlot([]);
    const second = allocateWorkspaceSlot([first]);
    expect(first).toBe('godview-tab-0');
    expect(second).toBe('godview-tab-1');
    // Closing the first window frees its slot; reopening restores that layout.
    expect(allocateWorkspaceSlot([second])).toBe(first);
  });

  it('never collides with a live window', () => {
    const live = ['godview-tab-0', 'godview-tab-1', 'godview-tab-3'];
    expect(allocateWorkspaceSlot(live)).toBe('godview-tab-2');
    expect(allocateWorkspaceSlot([...live, 'godview-tab-2'])).toBe('godview-tab-4');
  });

  it('ignores identities it did not mint', () => {
    expect(allocateWorkspaceSlot(['1a2b3c', 'godview-tab-', 'godview-tab-x', 'godview-tab--1'])).toBe('godview-tab-0');
  });
});
