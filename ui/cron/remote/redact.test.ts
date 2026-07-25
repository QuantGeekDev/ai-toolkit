import { describe, expect, it } from 'vitest';
import { redactText, redactValue, safeErrorMessage } from './redact';

describe('remote secret redaction', () => {
  it('redacts RunPod, bearer, and signed URL credentials', () => {
    const text = redactText(
      `${'rpa_'}1234567890abcdefghijkl ${'rps_'}abcdefghijklmnopqrst ${'user_'}abcdefghijklmnopqrst Bearer abcdefghijklmnopqrstuvwxyz?x=1&X-Amz-Signature=secret-value`,
    );
    expect(text).not.toContain('rpa_1234567890');
    expect(text).not.toContain('rps_abcdefghijkl');
    expect(text).not.toContain('user_abcdefghijkl');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('secret-value');
    expect(text).toContain('Bearer [REDACTED]');
    expect(text).toContain('X-Amz-Signature=[REDACTED]');
  });

  it('redacts secret-shaped object keys and handles cycles', () => {
    const value: any = { endpoint: 'safe', apiKey: 'secret', nested: {} };
    value.nested.parent = value;
    expect(redactValue(value)).toEqual({ endpoint: 'safe', apiKey: '[REDACTED]', nested: { parent: '[Circular]' } });
    expect(safeErrorMessage(new Error(`bad rpa_${'a'.repeat(32)}`))).toBe('bad [REDACTED]');
  });
});
