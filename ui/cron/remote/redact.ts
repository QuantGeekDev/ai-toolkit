const SECRET_KEYS = /(?:authorization|api[_-]?key|secret|token|credential|access[_-]?id|signed[_-]?url)/i;
export const redactText = (value: string): string => {
  return value
    .replace(/\brp[as]_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\buser_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s]+/gi, '$1[REDACTED]');
};

export const redactValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map(item => redactValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : redactValue(item, seen);
  }
  return output;
};

export const safeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return redactText(error.message).slice(0, 1000);
  return redactText(String(error)).slice(0, 1000);
};
