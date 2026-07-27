import crypto from 'crypto';

const decodeMaster = (master: string) => Buffer.from(master, 'base64');

export const deriveWorkspaceSecret = (master: string, workspaceId: string, purpose: string): Buffer =>
  Buffer.from(
    crypto.hkdfSync('sha256', decodeMaster(master), Buffer.from(workspaceId), Buffer.from(`aitk-comfy:${purpose}`), 32),
  );

export const deriveControllerToken = (master: string, workspaceId: string): string =>
  deriveWorkspaceSecret(master, workspaceId, 'controller').toString('base64url');

export const signOpenAssertion = (
  master: string,
  workspaceId: string,
  now = new Date(),
): { assertion: string; expiresAt: Date } => {
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      workspaceId,
      nonce: crypto.randomBytes(24).toString('base64url'),
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    }),
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', deriveWorkspaceSecret(master, workspaceId, 'browser'))
    .update(payload)
    .digest('base64url');
  return { assertion: `${payload}.${signature}`, expiresAt };
};
