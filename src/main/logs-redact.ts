/**
 * Mask obvious secret shapes in a log slice before it leaves the machine.
 *
 * CLI-safe by construction (no `electron`, no `@xterm/*`) — it is a pure string
 * transform reached from the `condash logs read/tail --redact` path. The intent
 * is the privacy gate of the terminal-monitor design: doing the masking once,
 * where condash already owns the logs, beats every downstream consumer
 * reinventing it before its own API call.
 *
 * Deliberately conservative — it targets high-precision secret shapes (provider
 * key prefixes, bearer tokens, JWTs, secret-named assignments, PEM private-key
 * blocks). It does NOT touch emails, IPs, or generic long strings: over-eager
 * masking would corrupt ordinary terminal output and erode trust in the flag.
 */

/** Replacement for a matched secret. The `kind` is a coarse hint, not the
 * value, so a reader can see *that* something was masked and roughly what. */
function mask(kind: string): string {
  return `«redacted:${kind}»`;
}

/** One precision rule: a global regex + the kind label it masks to. Rules whose
 * value sits in a capture group keep the surrounding text (e.g. the env-var
 * name) and mask only the group. */
interface RedactRule {
  re: RegExp;
  kind: string;
  /** When set, mask only this 1-based capture group, keeping the rest. */
  group?: number;
}

const RULES: RedactRule[] = [
  // PEM private-key blocks — match first so inner base64 isn't half-masked.
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    kind: 'private-key',
  },
  // Provider API-key prefixes (Anthropic/OpenAI sk-, GitHub gh*_/pat, Slack xox).
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, kind: 'api-key' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, kind: 'api-key' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, kind: 'github-token' },
  { re: /\bgh[opusr]_[A-Za-z0-9]{20,}/g, kind: 'github-token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, kind: 'slack-token' },
  // AWS access-key ids.
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, kind: 'aws-key' },
  // Authorization: Bearer <token> (mask the token, keep the scheme).
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, kind: 'bearer', group: 1 },
  // JWTs — three base64url segments.
  { re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, kind: 'jwt' },
  // NAME=VALUE / NAME: VALUE where NAME looks secret — mask the value only.
  {
    re: /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*\s*[=:]\s*)(['"]?)[^\s'"]{6,}\2/gi,
    kind: 'secret',
    group: 1,
  },
];

/**
 * Return `text` with recognised secret shapes replaced by `«redacted:kind»`.
 * Idempotent in practice: the placeholder contains no character that any rule
 * matches, so re-running never double-masks.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (_match, ...groups) => {
      if (rule.group === undefined) return mask(rule.kind);
      // Keep the leading capture (scheme / NAME=), mask the rest.
      const prefix = groups[rule.group - 1] as string;
      return `${prefix}${mask(rule.kind)}`;
    });
  }
  return out;
}
