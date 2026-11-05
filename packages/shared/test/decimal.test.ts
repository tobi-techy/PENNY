import { describe, expect, test } from 'bun:test';
import {
  addDecimal,
  compareDecimal,
  DecimalError,
  formatUsd,
  fromBaseUnits,
  subDecimal,
  toBaseUnits,
} from '../src/index.ts';

describe('toBaseUnits', () => {
  test('USDC (6dp)', () => {
    expect(toBaseUnits('0', 6)).toBe(0n);
    expect(toBaseUnits('12.5', 6)).toBe(12_500_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('1000000', 6)).toBe(1_000_000_000_000n);
  });
  test('NEAR (24dp) has no float drift', () => {
    expect(toBaseUnits('1', 24)).toBe(10n ** 24n);
    expect(toBaseUnits('0.1', 24)).toBe(10n ** 23n);
    expect(toBaseUnits('123456789.123456', 24)).toBe(123456789123456000000000000000000n);
  });
  test('rejects bad input', () => {
    for (const bad of ['', '-1', '1.', '.5', '1e3', '1.1234567', ' 1', '1,000', 'NaN', '0x10']) {
      expect(() => toBaseUnits(bad, 6)).toThrow(DecimalError);
    }
    expect(() => toBaseUnits('1.5', 0)).toThrow(DecimalError);
    expect(() => toBaseUnits('1', -1)).toThrow(DecimalError);
  });
});

describe('fromBaseUnits', () => {
  test('round trips', () => {
    for (const s of ['0', '1', '12.5', '0.000001', '999999.999999']) {
      expect(fromBaseUnits(toBaseUnits(s, 6), 6)).toBe(s);
      expect(fromBaseUnits(toBaseUnits(s, 24), 24)).toBe(s);
    }
  });
  test('rejects negatives', () => {
    expect(() => fromBaseUnits(-1n, 6)).toThrow(DecimalError);
  });
  test('decimals 0', () => {
    expect(fromBaseUnits(42n, 0)).toBe('42');
  });
});

describe('arithmetic and display', () => {
  test('compare/add/sub', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('2', '10')).toBe(-1);
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(subDecimal('100', '0.000001')).toBe('99.999999');
    expect(() => subDecimal('1', '2')).toThrow(DecimalError);
  });
  test('formatUsd', () => {
    expect(formatUsd('50')).toBe('$50.00');
    expect(formatUsd('0.125')).toBe('$0.13');
    expect(formatUsd('1234567.5')).toBe('$1,234,567.50');
    expect(formatUsd(1n)).toBe('$0.00');
  });
});
