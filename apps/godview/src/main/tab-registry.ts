export interface GodviewTabRecord<Window extends object> {
  id: string;
  groupId: string;
  window: Window;
  sessionIds: Set<string>;
  activeCwd: string | undefined;
}

/** Tracks native tab order and which terminal sessions each window owns. */
export class GodviewTabRegistry<Window extends object> {
  readonly #byWindow = new Map<Window, GodviewTabRecord<Window>>();

  add(window: Window, id: string, groupId: string): GodviewTabRecord<Window> {
    const record = { id, groupId, window, sessionIds: new Set<string>(), activeCwd: undefined };
    this.#byWindow.set(window, record);
    return record;
  }

  get(window: Window): GodviewTabRecord<Window> | undefined {
    return this.#byWindow.get(window);
  }

  delete(window: Window): GodviewTabRecord<Window> | undefined {
    const record = this.#byWindow.get(window);
    this.#byWindow.delete(window);
    return record;
  }

  records(): GodviewTabRecord<Window>[] {
    return [...this.#byWindow.values()];
  }

  group(groupId: string): GodviewTabRecord<Window>[] {
    return this.records().filter((record) => record.groupId === groupId);
  }

  updateSessions(window: Window, sessionIds: readonly string[]): void {
    const record = this.#byWindow.get(window);
    if (record) record.sessionIds = new Set(sessionIds);
  }

  updateActiveCwd(window: Window, cwd: string | undefined): void {
    const record = this.#byWindow.get(window);
    if (record) record.activeCwd = cwd;
  }

  tabAt(window: Window, oneBasedIndex: number): GodviewTabRecord<Window> | undefined {
    const current = this.#byWindow.get(window);
    if (!current) return undefined;
    const group = this.group(current.groupId);
    if (!group.length) return undefined;
    return group[Math.min(Math.max(oneBasedIndex, 1), group.length) - 1];
  }
}
