/**
 * Capture sanitiser — the privacy gate between raw evidence and committed
 * fixtures (draft/ADAPTING-AN-AGENT.md step 1, draft/IMPOSTER.md §9.6).
 *
 * SELF-CONTAINED by design, like model.ts: no relative imports, erasable
 * syntax only, so adapter-local `.mjs` scripts can import it under node type
 * stripping. That is also why it lives here rather than in an adapter — the
 * ENGINE is vendor-neutral and shared, so a hole closed for one vendor is
 * closed for all; only the RULES are vendor-specific, and adapters extend them.
 *
 * Two halves that must stay in lockstep: `sanitize` redacts, `check` detects.
 * Every redaction rule has a detection counterpart, and the audit gates on the
 * detector — a redactor without its inverse is how a leak ships looking clean.
 *
 * ── Why the defaults are strict ────────────────────────────────────────────
 * On 2026-08-07 this engine's ancestor processed a real codex JSON-RPC capture
 * and reported ZERO issues while leaving the prompt text, machine hostname,
 * userAgent, installationId and 19 verbatim thread UUIDs intact. It was safe
 * for claude mostly by accident of `sensitiveContainer`, which codex has no
 * equivalent of. The defaults below are therefore deliberately broad: a false
 * positive costs one fixture field, a false negative costs a public leak.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export interface SanitizerRules {
  /** Keys whose string values become stable pseudonyms. */
  idKey: RegExp;
  pathKey: RegExp;
  urlKey: RegExp;
  /** Keys whose values are free-form and therefore always redacted. */
  sensitiveTextKey: RegExp;
  /** Once inside, EVERYTHING is redacted unless it is a structural enum. */
  sensitiveContainer: RegExp;
  structuralEnumKey: RegExp;
  /** Values already in redacted form; passed through so sanitising is idempotent. */
  alreadyRedacted: RegExp;
  /** Value-level patterns redacted (and detected) regardless of key. */
  unsafeTextPatterns: RegExp[];
}

/**
 * A bare UUID in ANY field, whatever its key.
 *
 * Codex ids are UUIDv7, whose first 48 bits are a millisecond timestamp — one
 * decoded from a real capture gave back the exact wall-clock capture time. So a
 * UUID is not merely an identifier to alias, it is a clock to destroy, and
 * key-based rules miss the ones that appear under unexpected names.
 */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The same, unanchored. A UUID embedded in a longer string is just as much a
 * clock as a bare one — a real capture carried
 * `"rollout session_meta.session_id=019f5d86-… :: matches thread.sessionId=…"`
 * in a free-text diagnostic field, which the anchored form walked straight past.
 */
const EMBEDDED_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

export const defaultRules: SanitizerRules = {
  // Trailing-`Id` catches camelCase (threadId, itemId, callId, installationId,
  // clientUserMessageId) without listing them; `(?:^|_)id$` keeps snake_case
  // and refuses to match words that merely end in "id" such as `valid`.
  idKey: /(?:^|_)(?:uu)?id$|[a-z0-9]Id$/,
  pathKey:
    /(?:^|_)(?:cwd|path|file_path|transcript_path|agent_transcript_path|project_dir|current_dir|worktree_path|root|home)$|^(?:filePath|transcriptPath|agentTranscriptPath|projectDir|currentDir|worktreePath|codexHome|rolloutPath)$/i,
  urlKey: /(?:^|_)(?:url|uri)$/i,
  // Three groups: claude's original free-text keys; codex's free-text keys
  // (`text`/`delta`/`agentText` are where prompts and model output actually
  // live over JSON-RPC); and host/environment fingerprints — `userAgent` alone
  // leaked OS version, arch AND terminal emulator, and `serverName` was the
  // machine hostname, which contained the operator's real first name.
  sensitiveTextKey: new RegExp(
    [
      // claude / generic free text
      '(?:^|_)(?:prompt|message|last_assistant_message|command|output|error|content',
      '|old_string|new_string|query|response|title|token|secret|authorization|api_key',
      '|password|email|username|user_name|account_name|organization_name)$',
      // codex free text — where prompts and model output actually live
      '|^(?:text|delta|agentText|summary|preview|patch|diff|aggregatedOutput|results',
      '|commandLine|argv|instructions|instructionSources|rejection)$',
      // host / environment fingerprints
      '|^(?:userAgent|serverName|hostname|host|machineName|terminal)$',
    ].join(''),
    'i',
  ),
  sensitiveContainer: /^(?:tool_input|tool_response)$/i,
  structuralEnumKey: /^(?:type|kind|role|status|mode|behavior|destination)$/i,
  alreadyRedacted:
    /^(?:<redacted(?::[^>\r\n]+)?>|anon-[a-f0-9]{16}|a11a5ed0[0-9a-f-]*|[a-z]+_a11a5ed0[0-9a-f]*|\/workspace|\/workspace\/(?:CLAUDE\.md|redacted-(?:file|path)|transcripts\/[A-Za-z0-9_-]+\.jsonl)|https:\/\/example\.invalid\/(?:redacted)?)$/,
  unsafeTextPatterns: [
    /\/Users\/[^/\s"']+/,
    /\/home\/(?!user(?:\/|\b))[^/\s"']+/,
    /[A-Za-z]:\\Users\\[^\\\s"']+/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:sk|sess|pat|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/,
    // macOS per-user temp roots embed a user-specific hash.
    /\/(?:private\/)?var\/folders\/[^\s"']+/,
    // SLUG-ENCODED home paths. Claude derives project directory names by
    // replacing every non-alphanumeric character with `-`, so `/Users/alice`
    // becomes `-Users-alice-`. A real capture carried
    // `/private/tmp/…/-Users-alice-Projects-…` which every `/Users/`
    // pattern above walks straight past — the slashes are gone.
    /-(?:Users|home)-[A-Za-z0-9_.]+-/,
    // Bearer/JWT-shaped credentials the `sk-|ghp-` list misses entirely.
    /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  ],
};

/** Extend the defaults with additional vendor-specific keys or value patterns. */
export function extendRules(
  extra: Partial<Record<'idKey' | 'pathKey' | 'sensitiveTextKey' | 'sensitiveContainer', RegExp>> & {
    unsafeTextPatterns?: RegExp[];
  },
  base: SanitizerRules = defaultRules,
): SanitizerRules {
  const merge = (a: RegExp, b: RegExp | undefined): RegExp =>
    b === undefined ? a : new RegExp(`${a.source}|${b.source}`, a.flags.includes('i') ? 'i' : '');
  return {
    ...base,
    idKey: merge(base.idKey, extra.idKey),
    pathKey: merge(base.pathKey, extra.pathKey),
    sensitiveTextKey: merge(base.sensitiveTextKey, extra.sensitiveTextKey),
    sensitiveContainer: merge(base.sensitiveContainer, extra.sensitiveContainer),
    unsafeTextPatterns: [...base.unsafeTextPatterns, ...(extra.unsafeTextPatterns ?? [])],
  };
}

function jsonlFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...jsonlFiles(path));
    else if (entry.endsWith('.jsonl')) files.push(path);
  }
  return files.sort();
}

/**
 * The detector also reads plain `.json`, which the redactor deliberately does
 * not: rewriting those would reformat hand-maintained documents. The asymmetry
 * is intentional — a capture directory once held a `*-shapes.json` companion
 * carrying a full home path that a `.jsonl`-only scan never looked at, so the
 * DETECTOR must be broader than the redactor even where it can only complain.
 */
function jsonDocuments(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...jsonDocuments(path));
    else if (entry.endsWith('.json')) files.push(path);
  }
  return files.sort();
}

/**
 * Value-keyed, NOT key-keyed: one entity gets one pseudonym across every line
 * and every field, so request↔response correlation and thread joins survive
 * sanitisation. A transcript whose ids stop matching is unreplayable, which
 * makes it useless as a fixture. Do not "harden" this into a per-key salt.
 */
/**
 * Hex-safe marker identifying an id this function already produced.
 *
 * Needed because format-preserving output is indistinguishable from real input
 * by shape alone — claude's own session ids are v4 UUIDs, so "looks like a v4"
 * cannot mean "already redacted". Without the marker `alias(alias(x))` would
 * re-hash and every re-sanitisation would churn every id, which breaks both
 * idempotence and cross-fixture correlation.
 */
const ALIAS_MARKER = 'a11a5ed0';

export function alias(value: string): string {
  if (/^anon-[a-f0-9]{16}$/.test(value)) return value;
  if (value.startsWith(ALIAS_MARKER) || value.includes(`_${ALIAS_MARKER}`)) return value;
  const digest = createHash('sha256').update(value).digest('hex');

  // SHAPE-FAITHFUL by requirement, not preference: ADAPTING-AN-AGENT step 1
  // asks for fixtures that preserve types and formats, and downstream tests
  // legitimately assert that a claude session_id looks like a UUID and a
  // tool_use_id starts with `toolu_`. Flattening every id to `anon-…` destroys
  // exactly the surface knowledge the capture exists to record.
  if (BARE_UUID.test(value)) {
    // Emitted as v4 (version nibble 4, variant 8-b) NEVER v7, because v7's
    // leading 48 bits are a millisecond timestamp — reproducing the input's
    // version would re-introduce the clock this function exists to destroy.
    const variant = '89ab'[parseInt(digest[16]!, 16) % 4];
    return `${ALIAS_MARKER}-${digest.slice(0, 4)}-4${digest.slice(5, 8)}-${variant}${digest.slice(9, 12)}-${digest.slice(12, 24)}`;
  }

  // Vendor-prefixed ids (`toolu_…`, `msg_…`, `agent_…`) keep prefix and length.
  const prefixed = /^([a-z]+_)(.+)$/.exec(value);
  if (prefixed) {
    const [, prefix, body] = prefixed;
    const marked = `${ALIAS_MARKER}${digest}`;
    return `${prefix}${marked.slice(0, Math.max(body!.length, ALIAS_MARKER.length))}`;
  }

  return `anon-${digest.slice(0, 16)}`;
}

function safeStructuralEnum(value: string, key: string, rules: SanitizerRules): boolean {
  return rules.structuralEnumKey.test(key) && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function sanitizeString(value: string, key: string, inContainer: boolean, rules: SanitizerRules): string {
  if (rules.alreadyRedacted.test(value)) return value;
  if (rules.idKey.test(key) || BARE_UUID.test(value)) return alias(value);
  if (rules.pathKey.test(key)) {
    if (/transcript/i.test(key)) {
      // Alias the BASENAME, not the whole path. A transcript is named after the
      // id that owns it — session_id for a session, agent_id for a subagent —
      // and the adapter joins on exactly that. Hashing the whole string would
      // give the path a pseudonym unrelated to the id's, silently breaking the
      // join the fixture exists to demonstrate. Using the basename rather than
      // a uuid match keeps this working for non-uuid ids too (claude's
      // agent_id is a bare 17-char hex string).
      // Alias the id TOKENS inside the basename and keep everything around
      // them: claude names a session transcript `<uuid>.jsonl` but a subagent's
      // `agent-<agent_id>.jsonl`, so aliasing the whole stem would break the
      // agent join while fixing the session one.
      const stem = basename(value).replace(/\.[A-Za-z0-9]+$/, '');
      const joined = stem
        .replace(EMBEDDED_UUID, (match) => alias(match))
        .replace(/(?<![0-9a-f])[0-9a-f]{16,}(?![0-9a-f])/gi, (match) => alias(match));
      return `/workspace/transcripts/${joined.length > 0 ? joined : alias(value)}.jsonl`;
    }
    if (key === 'cwd') return '/workspace';
    return `/workspace/${basename(value) === 'CLAUDE.md' ? 'CLAUDE.md' : 'redacted-file'}`;
  }
  if (rules.urlKey.test(key)) return 'https://example.invalid/redacted';
  if (rules.sensitiveTextKey.test(key) || (inContainer && !safeStructuralEnum(value, key, rules))) {
    return `<redacted:${key || 'value'}>`;
  }
  let sanitized = value
    // Embedded ids are aliased rather than blanked, so correlation survives
    // even inside free-text diagnostics. `alias` is value-keyed, so the same
    // uuid yields the same pseudonym here as when it appears bare under a key.
    .replace(EMBEDDED_UUID, (match) => alias(match))
    .replace(/-(?:Users|home)-[A-Za-z0-9_.]+-/g, '-Users-<redacted>-')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '/workspace/redacted-path')
    .replace(/\/Users\/[^/\s"']+(?:\/[^\s"']*)?/g, '/workspace/redacted-path')
    .replace(/\/home\/(?!user(?:\/|\b))[^/\s"']+(?:\/[^\s"']*)?/g, '/workspace/redacted-path')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+(?:\\[^\s"']*)?/g, 'C:\\workspace\\redacted-path')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<redacted-email>')
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g, '<redacted-secret>.')
    .replace(/\b(?:sk|sess|pat|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/g, '<redacted-secret>');
  return sanitized;
}

function sanitizeValue(value: unknown, key: string, inContainer: boolean, rules: SanitizerRules): unknown {
  if (typeof value === 'string') return sanitizeString(value, key, inContainer, rules);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, key, inContainer, rules));
  if (value !== null && typeof value === 'object') {
    const nextInContainer = inContainer || rules.sensitiveContainer.test(key);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        sanitizeValue(child, childKey, nextInContainer, rules),
      ]),
    );
  }
  return value;
}

/** Sanitise one already-parsed capture record. Exposed for unit tests. */
export function sanitizeRecord(record: unknown, rules: SanitizerRules = defaultRules): unknown {
  return sanitizeValue(record, '', false, rules);
}

export interface SanitizeResult {
  files: number;
  lines: number;
}

export function sanitizeCaptureDirectory(
  inputDirectory: string,
  outputDirectory: string = inputDirectory,
  rules: SanitizerRules = defaultRules,
): SanitizeResult {
  let lines = 0;
  const files = jsonlFiles(inputDirectory);
  for (const file of files) {
    const output: string[] = [];
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`${relative(inputDirectory, file)}:${index + 1} is not valid JSON`);
      }
      output.push(JSON.stringify(sanitizeValue(parsed, '', false, rules)));
      lines += 1;
    }
    const target = join(outputDirectory, relative(inputDirectory, file));
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.sanitizing`;
    writeFileSync(temporary, `${output.join('\n')}\n`, { mode: 0o644 });
    renameSync(temporary, target);
  }
  return { files: files.length, lines };
}

function inspect(
  value: unknown,
  issues: string[],
  location: string,
  key: string,
  inContainer: boolean,
  rules: SanitizerRules,
): void {
  if (typeof value === 'string') {
    if (rules.unsafeTextPatterns.some((pattern) => pattern.test(value))) {
      issues.push(`${location}: unsafe text at ${key}`);
    }
    // `String.match` with a /g regex does not carry lastIndex between calls,
    // unlike `RegExp.test`; using `.test` here would skip every other hit.
    if (value.replace(new RegExp(ALIAS_MARKER + '[0-9a-f-]*', 'g'), '').match(EMBEDDED_UUID)) {
      issues.push(`${location}: raw UUID at ${key} (UUIDv7 encodes capture wall-clock time)`);
    }
    if (
      (rules.idKey.test(key) ||
        rules.pathKey.test(key) ||
        rules.urlKey.test(key) ||
        rules.sensitiveTextKey.test(key) ||
        (inContainer && !safeStructuralEnum(value, key, rules))) &&
      !rules.alreadyRedacted.test(value)
    ) {
      issues.push(`${location}: unsanitized sensitive field ${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspect(entry, issues, `${location}[${index}]`, key, inContainer, rules));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const nextInContainer = inContainer || rules.sensitiveContainer.test(key);
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      inspect(child, issues, `${location}.${childKey}`, childKey, nextInContainer, rules);
    }
  }
}

/**
 * Detect inside ONE file, `.jsonl` (per line) or `.json` (whole document).
 *
 * Exists so a caller can drive the scan from `git ls-files` rather than from
 * the filesystem: the gate's job is to stop a leak reaching a COMMIT, and a
 * gitignored local artefact failing the build is noise. `label` names the file
 * in the resulting issues.
 */
export function checkCaptureFile(path: string, label = path, rules: SanitizerRules = defaultRules): string[] {
  const issues: string[] = [];
  const contents = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    for (const [index, line] of contents.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        inspect(JSON.parse(line), issues, `${label}:${index + 1}`, '', false, rules);
      } catch {
        // Parse failures are reported by the ASM audit, not duplicated here.
      }
    }
    return issues;
  }
  try {
    inspect(JSON.parse(contents), issues, label, '', false, rules);
  } catch {
    // Not a JSON document we can inspect.
  }
  return issues;
}

/** Detect what the sanitiser should have removed. The audit gates on this. */
export function checkCaptureDirectory(directory: string, rules: SanitizerRules = defaultRules): string[] {
  const issues: string[] = [];
  for (const file of jsonlFiles(directory)) {
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        inspect(JSON.parse(line), issues, `${relative(directory, file)}:${index + 1}`, '', false, rules);
      } catch {
        // Parse failures are reported by the ASM audit, not duplicated here.
      }
    }
  }
  for (const file of jsonDocuments(directory)) {
    try {
      inspect(JSON.parse(readFileSync(file, 'utf8')), issues, relative(directory, file), '', false, rules);
    } catch {
      // Not a JSON document we can inspect; the audit reports parse failures.
    }
  }
  return issues;
}

/** Detect inside one parsed record. Exposed so tests can assert on a leak directly. */
export function checkRecord(record: unknown, rules: SanitizerRules = defaultRules): string[] {
  const issues: string[] = [];
  inspect(record, issues, '<record>', '', false, rules);
  return issues;
}
