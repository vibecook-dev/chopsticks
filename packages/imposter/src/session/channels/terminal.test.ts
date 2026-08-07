import { describe, expect, it } from 'vitest';
import { createPasteDecoder, type PasteOperation } from './terminal.ts';

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
