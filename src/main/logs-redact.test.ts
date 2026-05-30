import { describe, expect, it } from 'vitest';
import { redactSecrets } from './logs-redact';

describe('redactSecrets', () => {
  it('masks Anthropic / OpenAI sk- keys', () => {
    expect(redactSecrets('key=sk-ant-api03-AbCdEf0123456789ZyXwVu rest')).toContain(
      '«redacted:api-key»',
    );
    expect(redactSecrets('sk-AbCdEf0123456789ZyXwVuTs')).toBe('«redacted:api-key»');
  });

  it('masks GitHub and Slack tokens', () => {
    expect(redactSecrets('ghp_0123456789abcdefABCDEF0123456789abcd')).toBe(
      '«redacted:github-token»',
    );
    expect(redactSecrets('github_pat_11ABCDEF0123456789_abcdefghij')).toContain(
      '«redacted:github-token»',
    );
    expect(redactSecrets('xoxb-1234567890-abcdefghijkl')).toBe('«redacted:slack-token»');
  });

  it('masks AWS access-key ids', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('«redacted:aws-key»');
  });

  it('keeps the scheme but masks a bearer token', () => {
    const out = redactSecrets('Authorization: Bearer abcDEF123.ghiJKL456-mnoPQR');
    expect(out).toBe('Authorization: Bearer «redacted:bearer»');
  });

  it('masks a JWT', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4';
    expect(redactSecrets(`token ${jwt} end`)).toBe('token «redacted:jwt» end');
  });

  it('masks the value of a secret-named assignment, keeping the name', () => {
    expect(redactSecrets('API_KEY=supersecretvalue123')).toBe('API_KEY=«redacted:secret»');
    expect(redactSecrets('export DB_PASSWORD: "hunter2hunter2"')).toContain(
      'DB_PASSWORD: «redacted:secret»',
    );
  });

  it('masks a PEM private-key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\nDEF456\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`before\n${pem}\nafter`)).toBe('before\n«redacted:private-key»\nafter');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Running make format; 42 files changed, build OK at 12:01.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('is idempotent — re-running does not double-mask', () => {
    const once = redactSecrets('API_KEY=supersecretvalue123');
    expect(redactSecrets(once)).toBe(once);
  });
});
