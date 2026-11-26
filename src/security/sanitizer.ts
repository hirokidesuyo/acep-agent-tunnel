/** Result returned by {@link sanitizeForPublic}. */
export interface SanitizeResult<T> {
  sanitized: T;
  warnings: string[];
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  {
    name: "private_key",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "openai_or_sk_key",
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "google_api_key",
    regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "bearer_token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: "Bearer [REDACTED_SECRET]",
  },
  {
    name: "unix_home_path",
    regex: /(?<=^|[\s"'`=(\[{,;:])\/(?:Users|home)\/[^/\s"']+/g,
    replacement: "~",
  },
  {
    name: "windows_home_path",
    regex: /[A-Za-z]:\\Users\\[^\\\s"']+/g,
    replacement: "~",
  },
];

function sanitizeString(value: string, warnings: Set<string>): string {
  let result = value;
  for (const rule of SECRET_PATTERNS) {
    if (rule.regex.test(result)) {
      rule.regex.lastIndex = 0;
      result = result.replace(rule.regex, rule.replacement);
      warnings.add(`Redacted ${rule.name}`);
    }
    rule.regex.lastIndex = 0;
  }
  if (result.includes("~\\")) {
    result = result.replace(
      /~\\([^\s"']*)/g,
      (_, rest: string) => `~/${rest.replace(/\\/g, "/")}`,
    );
  }
  return result;
}

function walkAndSanitize(value: unknown, warnings: Set<string>): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, warnings);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkAndSanitize(item, warnings));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const sanitizedKey = sanitizeString(k, warnings);
      out[sanitizedKey] = walkAndSanitize(v, warnings);
    }
    return out;
  }
  return value;
}

/**
 * Recursively sanitizes strings within `data` for `public` mode channels by
 * redacting private keys, API keys, tokens, and user home directory paths.
 */
export function sanitizeForPublic<T>(data: T): SanitizeResult<T> {
  const warnings = new Set<string>();
  const sanitized = walkAndSanitize(data, warnings) as T;
  return {
    sanitized,
    warnings: Array.from(warnings),
  };
}
