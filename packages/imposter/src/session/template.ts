/**
 * Payload templating, shared by the op timeline and the scenario runner.
 *
 * It lives in one module on purpose: ops and scenarios both emit onto the same
 * channels, so if they substituted differently the same template string would
 * mean two things depending on which layer ran it — the kind of quiet
 * divergence draft/IMPOSTER.md §2 exists to prevent.
 *
 * Supported forms:
 *   "$<scope>.<field>"  scoped lookup — `$op.tool`, `$stimulus.text`
 *   "$uuid" | "$uuid:name"  stable per run; the same name yields the same uuid,
 *                           which is what correlates a prompt_id across events
 *   "$now"              ISO timestamp at substitution time
 *   "$<binding>"        whole-string binding — `$sessionId`, `$cwd`
 */

export interface TemplateContext {
  /** `$<name>.<field>` lookups, e.g. `{ op: {...}, stimulus: {...} }`. */
  scopes?: Record<string, Record<string, unknown>>;
  /** Whole-string bindings, e.g. `{ $sessionId: '...' }`. */
  bindings?: Record<string, unknown>;
  /** Per-run uuid memo; callers own its lifetime so names stay stable. */
  uuids: Map<string, string>;
}

export function substitute(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('$uuid')) {
      const name = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
      let uuid = context.uuids.get(name);
      if (!uuid) {
        uuid = crypto.randomUUID();
        context.uuids.set(name, uuid);
      }
      return uuid;
    }
    if (value === '$now') return new Date().toISOString();
    if (value.startsWith('$') && value.includes('.')) {
      const separator = value.indexOf('.');
      const scopeName = value.slice(1, separator);
      const scope = context.scopes?.[scopeName];
      // An unknown scope is a literal, not an error: a persona may legitimately
      // template a dotted string the imposter does not own.
      if (scope) return scope[value.slice(separator + 1)];
    }
    if (context.bindings && value in context.bindings) return context.bindings[value];
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, context));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry, context)]),
    );
  }
  return value;
}
