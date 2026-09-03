export type SensitiveKind =
  | "api_key"
  | "private_key"
  | "oauth_token"
  | "password"
  | "oci_identifier";

export interface SensitiveFinding {
  kind: SensitiveKind;
  line: number;
}

const PATTERNS: ReadonlyArray<readonly [SensitiveKind, RegExp]> = [
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i],
  ["api_key", /\bsk-[A-Za-z0-9_-]{16,}\b/],
  [
    "oauth_token",
    /(?:\b(?:access|refresh|oauth|id|bearer)[_-]?token\s*[:=]\s*\S+|\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}(?=\s|$))/i,
  ],
  ["password", /\b(?:password|passphrase)\s*[:=]\s*\S+/i],
  [
    "oci_identifier",
    /\bocid1\.[a-z]+\.[a-z0-9.-]+\.\.?[a-z0-9-]{8,}\b/i,
  ],
];

export function detectSensitiveContent(content: string): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    for (const [kind, pattern] of PATTERNS) {
      if (pattern.test(line)) findings.push({ kind, line: lineIndex + 1 });
    }
  }
  return findings;
}
