import { describe, expect, it } from 'vitest';
import { buildPaneAttachments } from './pane-attachments.js';

const panes = [
  { id: 'pane-a', session: { id: 'shared-session' } },
  { id: 'pane-b', session: { id: 'shared-session' } },
  { id: 'pane-c', session: { id: 'other-session' } },
] as const;
const paneColors = new Map([
  ['pane-a', '#f00'],
  ['pane-b', '#0f0'],
  ['pane-c', '#00f'],
]);

describe('pane attachments', () => {
  it('uses the active pane color as the primary ring and keeps mirrors in pane order', () => {
    expect(buildPaneAttachments(panes, paneColors, 'pane-b').get('shared-session')).toEqual({
      primary: '#0f0',
      mirrors: ['#f00'],
    });
  });

  it('uses the first attachment when that session is not selected', () => {
    const attachments = buildPaneAttachments(panes, paneColors, 'pane-c');
    expect(attachments.get('shared-session')).toEqual({ primary: '#f00', mirrors: ['#0f0'] });
    expect(attachments.get('other-session')).toEqual({ primary: '#00f', mirrors: [] });
  });
});
