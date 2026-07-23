export interface LatestValueBatch<Value> {
  sequence: number;
  values: Value[];
}

/**
 * Keeps at most one delivered batch plus one latest pending value per key.
 * Producers can continue at full speed while a consumer is busy without
 * building an unbounded queue of obsolete snapshots.
 */
export class LatestValueQueue<Key, Value> {
  readonly #pending = new Map<Key, Value>();
  #inFlight: { sequence: number; entries: Map<Key, Value> } | undefined;
  #nextSequence = 1;

  enqueue(key: Key, value: Value): void {
    this.#pending.set(key, value);
  }

  delete(key: Key): boolean {
    return this.#pending.delete(key);
  }

  take(): LatestValueBatch<Value> | undefined {
    if (this.#inFlight || this.#pending.size === 0) return undefined;
    const entries = new Map(this.#pending);
    this.#pending.clear();
    const sequence = this.#nextSequence++;
    this.#inFlight = { sequence, entries };
    return { sequence, values: [...entries.values()] };
  }

  acknowledge(sequence: number): boolean {
    if (this.#inFlight?.sequence !== sequence) return false;
    this.#inFlight = undefined;
    return true;
  }

  /**
   * Releases an undelivered/incomplete batch after a renderer reload. Newer
   * pending values win over values from the interrupted batch.
   */
  retryInFlight(): void {
    if (!this.#inFlight) return;
    for (const [key, value] of this.#inFlight.entries) {
      if (!this.#pending.has(key)) this.#pending.set(key, value);
    }
    this.#inFlight = undefined;
  }

  get pendingSize(): number {
    return this.#pending.size;
  }

  get hasInFlight(): boolean {
    return Boolean(this.#inFlight);
  }
}
