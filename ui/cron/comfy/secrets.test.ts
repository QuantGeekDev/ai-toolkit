import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { deriveControllerToken, deriveWorkspaceSecret, signOpenAssertion } from './secrets';

describe('workspace key derivation', () => {
  const master = Buffer.alloc(32, 3).toString('base64');

  it('uses isolated purpose keys', () => {
    expect(deriveControllerToken(master, 'workspace-a')).not.toBe(
      deriveWorkspaceSecret(master, 'workspace-a', 'browser').toString('base64url'),
    );
    expect(deriveControllerToken(master, 'workspace-a')).not.toBe(deriveControllerToken(master, 'workspace-b'));
  });

  it('signs a five-minute assertion without embedding the master secret', () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const { assertion, expiresAt } = signOpenAssertion(master, 'workspace-a', now);
    const [payload, signature] = assertion.split('.');
    const expected = crypto
      .createHmac('sha256', deriveWorkspaceSecret(master, 'workspace-a', 'browser'))
      .update(payload)
      .digest('base64url');
    expect(signature).toBe(expected);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toMatchObject({
      v: 1,
      workspaceId: 'workspace-a',
      iat: 1785153600,
      exp: 1785153900,
    });
    expect(expiresAt.toISOString()).toBe('2026-07-27T12:05:00.000Z');
    expect(assertion).not.toContain(master);
  });
});
