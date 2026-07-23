import { describe, expect, it } from 'vitest';
import { validatedNativeOrder } from './native-tab-order.js';

describe('validatedNativeOrder', () => {
  it('accepts exactly one index for every native tab', () => {
    expect(validatedNativeOrder(3, [2, 0, 1])).toEqual([2, 0, 1]);
  });

  it('rejects incomplete, duplicated, and out-of-range native results', () => {
    expect(validatedNativeOrder(3, [0, 1])).toBeNull();
    expect(validatedNativeOrder(3, [0, 0, 2])).toBeNull();
    expect(validatedNativeOrder(3, [0, 1, 3])).toBeNull();
  });
});
