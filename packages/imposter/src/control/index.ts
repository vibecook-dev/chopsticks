/**
 * The control channel (draft/IMPOSTER.md §5). `protocol` is the shared
 * vocabulary, `peer` the codec both ends run, and `client` the imposter's
 * dialer. The plane that answers lives in `apps/emulator` — it is the sole
 * consumer and not published API (§7.2).
 */

export * from './protocol.ts';
export * from './peer.ts';
export * from './client.ts';
