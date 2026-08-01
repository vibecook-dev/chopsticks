/**
 * Stable per-window identity for the Ghosttea workspace document.
 *
 * Ghosttea persists a window's pane layout under a caller-supplied storage key
 * and, at load, drops any pane whose session is no longer live. Godview used to
 * mint a fresh UUID per window, so that key never survived a window closing:
 * the saved layout was orphaned, and the claim-existing-sessions fallback then
 * rebuilt one pane per live session instead of the arrangement the user had.
 *
 * Slots are the smallest free index rather than a remembered id, which keeps
 * them stable across an application restart by construction — the same N
 * windows reuse the same N keys — so abandoned documents cannot accumulate.
 */
export const WORKSPACE_SLOT_PREFIX = 'godview-tab-';

/** Lowest index not held by a live window, so concurrent windows never share a document. */
export function allocateWorkspaceSlot(liveSlotIds: Iterable<string>): string {
  const taken = new Set<number>();
  for (const slotId of liveSlotIds) {
    if (!slotId.startsWith(WORKSPACE_SLOT_PREFIX)) continue;
    // Digits only: Number('') is 0, which would silently reserve the first slot.
    const suffix = slotId.slice(WORKSPACE_SLOT_PREFIX.length);
    if (/^\d+$/.test(suffix)) taken.add(Number(suffix));
  }
  let index = 0;
  while (taken.has(index)) index += 1;
  return `${WORKSPACE_SLOT_PREFIX}${index}`;
}
