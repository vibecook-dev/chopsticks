#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const idKey = /(?:^id$|^uuid$|(?:^|_)(?:session|prompt|tool_use|agent|message|turn)_?id$)/i;
const pathKey =
  /(?:^|_)(?:cwd|path|file_path|transcript_path|agent_transcript_path|project_dir|current_dir|worktree_path|root)$|^(?:filePath|transcriptPath|agentTranscriptPath|projectDir|currentDir|worktreePath)$/i;
const urlKey = /(?:^|_)(?:url|uri)$/i;
const sensitiveTextKey =
  /(?:^|_)(?:prompt|message|last_assistant_message|command|output|error|content|old_string|new_string|query|response|title|token|secret|authorization|api_key|password|email|username|user_name|account_name|organization_name)$/i;
const sensitiveContainer = /^(?:tool_input|tool_response)$/i;
const structuralEnumKey = /^(?:type|kind|role|status|mode|behavior|destination)$/i;
const alreadyRedacted =
  /^(?:<redacted(?::[^>\r\n]+)?>|anon-[a-f0-9]{16}|\/workspace|\/workspace\/(?:CLAUDE\.md|redacted-(?:file|path)|transcripts\/anon-[a-f0-9]{16}\.jsonl)|https:\/\/example\.invalid\/(?:redacted)?)$/;
const unsafeTextPatterns = [
  /\/Users\/[^/\s"']+/,
  /\/home\/(?!user(?:\/|\b))[^/\s"']+/,
  /[A-Za-z]:\\Users\\[^\\\s"']+/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:sk|sess|pat|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/,
];

function jsonlFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...jsonlFiles(path));
    else if (entry.endsWith('.jsonl')) files.push(path);
  }
  return files.sort();
}

function alias(value) {
  if (/^anon-[a-f0-9]{16}$/.test(value)) return value;
  return `anon-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function safeStructuralEnum(value, key, insideSensitiveContainer) {
  return insideSensitiveContainer && structuralEnumKey.test(key) && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function sanitizeString(value, key, insideSensitiveContainer) {
  if (alreadyRedacted.test(value)) return value;
  if (idKey.test(key)) return alias(value);
  if (pathKey.test(key)) {
    if (/transcript/i.test(key)) return `/workspace/transcripts/${alias(value)}.jsonl`;
    if (key === 'cwd') return '/workspace';
    return `/workspace/${basename(value) === 'CLAUDE.md' ? 'CLAUDE.md' : 'redacted-file'}`;
  }
  if (urlKey.test(key)) return 'https://example.invalid/redacted';
  if (sensitiveTextKey.test(key) || (insideSensitiveContainer && !safeStructuralEnum(value, key, true))) {
    return `<redacted:${key || 'value'}>`;
  }
  const sanitized = value
    .replace(/\/Users\/[^/\s"']+(?:\/[^\s"']*)?/g, '/workspace/redacted-path')
    .replace(/\/home\/(?!user(?:\/|\b))[^/\s"']+(?:\/[^\s"']*)?/g, '/workspace/redacted-path')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+(?:\\[^\s"']*)?/g, 'C:\\workspace\\redacted-path')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<redacted-email>')
    .replace(/\b(?:sk|sess|pat|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/g, '<redacted-secret>');
  return sanitized;
}

function sanitize(value, key = '', insideSensitiveContainer = false) {
  if (typeof value === 'string') return sanitizeString(value, key, insideSensitiveContainer);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, key, insideSensitiveContainer));
  if (value !== null && typeof value === 'object') {
    const nextSensitive = insideSensitiveContainer || sensitiveContainer.test(key);
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey, nextSensitive)]),
    );
  }
  return value;
}

export function sanitizeCaptureDirectory(inputDirectory, outputDirectory = inputDirectory) {
  let lines = 0;
  const files = jsonlFiles(inputDirectory);
  for (const file of files) {
    const output = [];
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`${relative(inputDirectory, file)}:${index + 1} is not valid JSON`);
      }
      output.push(JSON.stringify(sanitize(parsed)));
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

function inspect(value, issues, location, key = '', insideSensitiveContainer = false) {
  if (typeof value === 'string') {
    if (unsafeTextPatterns.some((pattern) => pattern.test(value))) issues.push(`${location}: unsafe text at ${key}`);
    if (
      (idKey.test(key) ||
        pathKey.test(key) ||
        urlKey.test(key) ||
        sensitiveTextKey.test(key) ||
        (insideSensitiveContainer && !safeStructuralEnum(value, key, true))) &&
      !alreadyRedacted.test(value)
    ) {
      issues.push(`${location}: unsanitized sensitive field ${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspect(entry, issues, `${location}[${index}]`, key, insideSensitiveContainer));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const nextSensitive = insideSensitiveContainer || sensitiveContainer.test(key);
    for (const [childKey, child] of Object.entries(value)) {
      inspect(child, issues, `${location}.${childKey}`, childKey, nextSensitive);
    }
  }
}

export function checkCaptureDirectory(directory) {
  const issues = [];
  for (const file of jsonlFiles(directory)) {
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        inspect(JSON.parse(line), issues, `${relative(directory, file)}:${index + 1}`);
      } catch {
        // Parse failures are reported by the ASM audit, not duplicated here.
      }
    }
  }
  return issues;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  const directories = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  if ((check && directories.length !== 1) || (!check && ![1, 2].includes(directories.length))) {
    console.error('usage: node surface/sanitize-captures.mjs [--check] <input-directory> [output-directory]');
    process.exit(2);
  }
  if (check) {
    const issues = checkCaptureDirectory(directories[0]);
    for (const issue of issues) console.error(issue);
    if (issues.length > 0) process.exit(1);
    console.log('capture privacy check clean');
  } else {
    const result = sanitizeCaptureDirectory(directories[0], directories[1]);
    console.log(`sanitized ${result.lines} capture lines in ${result.files} files`);
  }
}
