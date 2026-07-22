export interface PaneAttachment {
  primary: string;
  mirrors: readonly string[];
}

interface MountedPane {
  id: string;
  session: { id: string };
}

export function buildPaneAttachments(
  panes: readonly MountedPane[],
  paneColors: ReadonlyMap<string, string>,
  activePaneId?: string,
): ReadonlyMap<string, PaneAttachment> {
  const colorsBySession = new Map<string, { paneId: string; color: string }[]>();

  for (const pane of panes) {
    const color = paneColors.get(pane.id);
    if (!color) continue;
    const attachments = colorsBySession.get(pane.session.id) ?? [];
    attachments.push({ paneId: pane.id, color });
    colorsBySession.set(pane.session.id, attachments);
  }

  const result = new Map<string, PaneAttachment>();
  for (const [sessionId, attachments] of colorsBySession) {
    const activeIndex = attachments.findIndex(({ paneId }) => paneId === activePaneId);
    const primaryIndex = activeIndex >= 0 ? activeIndex : 0;
    result.set(sessionId, {
      primary: attachments[primaryIndex].color,
      mirrors: attachments.filter((_, index) => index !== primaryIndex).map(({ color }) => color),
    });
  }

  return result;
}
