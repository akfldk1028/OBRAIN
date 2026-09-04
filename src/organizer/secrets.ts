export type SensitiveKind =
  | "api_key"
  | "private_key"
  | "oauth_token"
  | "password"
  | "oci_identifier"
  | "aws_access_key"
  | "github_token"
  | "jwt"
  | "personal_identifier";

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

const AWS_ACCESS_KEY = /\b(?:A3T[A-Z0-9]|AIDA|AIPA|AKIA|ANPA|ANVA|AROA|ASIA)[A-Z0-9]{16}\b/u;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{30,255})\b/u;
const JWT_CANDIDATE = /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_.-])/gu;
const RRN_CANDIDATE = /(?:^|\D)(\d{6})[- ]?(\d{7})(?!\d)/gu;
const CARD_CANDIDATE = /(?:^|\D)((?:\d[ -]?){12,18}\d)(?!\d)/gu;

function decodeJsonSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const decoded = Buffer.from(segment, "base64url");
    if (decoded.toString("base64url") !== segment.replace(/=+$/u, "")) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function containsJwt(line: string): boolean {
  for (const match of line.matchAll(JWT_CANDIDATE)) {
    const [headerSegment, payloadSegment, signatureSegment] = match[1]!.split(".");
    const header = decodeJsonSegment(headerSegment!);
    const payload = decodeJsonSegment(payloadSegment!);
    if (
      header
      && payload
      && typeof header.alg === "string"
      && header.alg.toLocaleLowerCase("en-US") !== "none"
      && Buffer.from(signatureSegment!, "base64url").length >= 8
    ) return true;
  }
  return false;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function containsKoreanResidentNumber(line: string): boolean {
  for (const match of line.matchAll(RRN_CANDIDATE)) {
    const digits = `${match[1]}${match[2]}`;
    const gender = Number(digits[6]);
    const century = gender === 1 || gender === 2 ? 1900 : gender === 3 || gender === 4 ? 2000 : undefined;
    if (century === undefined || !validDate(century + Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), Number(digits.slice(4, 6)))) continue;
    const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
    const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
    if ((11 - (sum % 11)) % 10 === Number(digits[12])) return true;
  }
  return false;
}

function recognizedCardIssuer(digits: string): boolean {
  if (/^4\d{12}(?:\d{3})?(?:\d{3})?$/u.test(digits)) return true;
  if (/^3[47]\d{13}$/u.test(digits)) return true;
  if (/^(?:5[1-5]\d{14}|2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:0\d|1\d|20))\d{12})$/u.test(digits)) return true;
  return /^(?:6011|65\d{2}|64[4-9]\d)\d{12}(?:\d{3})?$/u.test(digits)
    || /^35(?:2[89]|[3-8]\d)\d{12,15}$/u.test(digits);
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function containsPaymentCard(line: string): boolean {
  for (const match of line.matchAll(CARD_CANDIDATE)) {
    const digits = match[1]!.replace(/[ -]/gu, "");
    if (recognizedCardIssuer(digits) && passesLuhn(digits)) return true;
  }
  return false;
}

export function detectSensitiveContent(content: string): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    for (const [kind, pattern] of PATTERNS) {
      if (pattern.test(line)) findings.push({ kind, line: lineIndex + 1 });
    }
    if (AWS_ACCESS_KEY.test(line)) findings.push({ kind: "aws_access_key", line: lineIndex + 1 });
    if (GITHUB_TOKEN.test(line)) findings.push({ kind: "github_token", line: lineIndex + 1 });
    if (containsJwt(line)) findings.push({ kind: "jwt", line: lineIndex + 1 });
    if (containsKoreanResidentNumber(line) || containsPaymentCard(line)) {
      findings.push({ kind: "personal_identifier", line: lineIndex + 1 });
    }
  }
  return findings;
}
