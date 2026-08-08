import { describe, expect, it } from 'vitest';
import { createPasteDecoder, type PasteOperation } from './terminal.ts';

describe('createPasteDecoder submit detection', () => {
  it('treats a newline as submit, because a pty in canonical mode rewrites \\r', () => {
    const operations: Array<{ text: string; submit: boolean }> = [];
    const decoder = createPasteDecoder((operation) => operations.push(operation));
    // Exactly what the adapter writes, after ICRNL has been through it.
    decoder.feed('\x1b[200~summarise the repo\x1b[201~\n');
    expect(operations).toEqual([{ text: 'summarise the repo', submit: true }]);
  });

  it('still treats a raw carriage return as submit', () => {
    const operations: Array<{ text: string; submit: boolean }> = [];
    const decoder = createPasteDecoder((operation) => operations.push(operation));
    decoder.feed('\x1b[200~hi\x1b[201~\r');
    expect(operations).toEqual([{ text: 'hi', submit: true }]);
  });

  it('does not mistake a newline INSIDE the paste for submit', () => {
    const operations: Array<{ text: string; submit: boolean }> = [];
    const decoder = createPasteDecoder((operation) => operations.push(operation));
    decoder.feed('\x1b[200~two\nlines\x1b[201~');
    decoder.flush();
    expect(operations).toEqual([{ text: 'two\nlines', submit: false }]);
  });
});

describe('createPasteDecoder', () => {
  it('decodes a paste followed by Enter as submitted', () => {
    const pastes: PasteOperation[] = [];
    const decoder = createPasteDecoder((operation) => pastes.push(operation));
    decoder.feed('\x1b[200~hello world\x1b[201~\r');
    expect(pastes).toEqual([{ text: 'hello world', submit: true }]);
  });

  it('decodes paste-only (no Enter) after the hold timer', async () => {
    const pastes: PasteOperation[] = [];
    const decoder = createPasteDecoder((operation) => pastes.push(operation), undefined, 5);
    decoder.feed('\x1b[200~staged\x1b[201~');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pastes).toEqual([{ text: 'staged', submit: false }]);
  });

  it('handles pastes split across chunks and Enter in a later chunk', () => {
    const pastes: PasteOperation[] = [];
    const decoder = createPasteDecoder((operation) => pastes.push(operation), undefined, 50);
    decoder.feed('\x1b[200~hel');
    decoder.feed('lo\x1b[201~');
    decoder.feed('\r');
    expect(pastes).toEqual([{ text: 'hello', submit: true }]);
  });

  it('passes plain input through separately', () => {
    const pastes: PasteOperation[] = [];
    const input: string[] = [];
    const decoder = createPasteDecoder(
      (operation) => pastes.push(operation),
      (text) => input.push(text),
      5,
    );
    decoder.feed('ls -la');
    expect(pastes).toEqual([]);
    expect(input.join('')).toBe('ls -la');
  });

  it('flush releases a held paste as unsubmitted', () => {
    const pastes: PasteOperation[] = [];
    const decoder = createPasteDecoder((operation) => pastes.push(operation), undefined, 10_000);
    decoder.feed('\x1b[200~abandoned\x1b[201~');
    expect(pastes).toEqual([]);
    decoder.flush();
    expect(pastes).toEqual([{ text: 'abandoned', submit: false }]);
  });
});
