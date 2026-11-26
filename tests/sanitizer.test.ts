import { describe, it, expect } from "vitest";
import { sanitizeForPublic } from "../src/security/sanitizer.js";

describe("sanitizeForPublic", () => {
  it("masks API keys, tokens, private keys, and user home paths", () => {
    const input = {
      summary: "Use key sk-1234567890abcdefghij and token ghp_abcdef1234567890",
      path: "/Users/alice/secret-repo/config.json",
      nested: {
        winPath: "C:\\Users\\alice\\project\\env",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      },
    };

    const { sanitized, warnings } = sanitizeForPublic(input);

    expect(sanitized.summary).not.toContain("sk-1234567890abcdefghij");
    expect(sanitized.summary).not.toContain("ghp_abcdef1234567890");
    expect(sanitized.summary).toContain("[REDACTED_SECRET]");
    expect(sanitized.path).toBe("~/secret-repo/config.json");
    expect(sanitized.nested.winPath).toBe("~/project/env");
    expect(sanitized.nested.pem).toBe("[REDACTED_PRIVATE_KEY]");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("masks Bearer tokens, Google API keys, and /home paths across arrays", () => {
    const input = {
      headers: ["Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"],
      googleKey: "AIzaSyDummyKey1234567890abcdef",
      linuxPath: "/home/devuser/workspace/app.ts",
      count: 42,
      ok: true,
      empty: null,
    };

    const { sanitized, warnings } = sanitizeForPublic(input);

    expect(sanitized.headers[0]).toBe("Authorization: Bearer [REDACTED_SECRET]");
    expect(sanitized.googleKey).toBe("[REDACTED_SECRET]");
    expect(sanitized.linuxPath).toBe("~/workspace/app.ts");
    expect(sanitized.count).toBe(42);
    expect(sanitized.ok).toBe(true);
    expect(sanitized.empty).toBeNull();
    expect(warnings).toEqual([
      "Redacted bearer_token",
      "Redacted google_api_key",
      "Redacted unix_home_path",
    ]);
  });

  it("leaves safe technical strings untouched with zero warnings", () => {
    const input = {
      summary: "Pass --flash-attn and use Q4_K_M quantization",
      args: ["--threads", "8"],
    };

    const { sanitized, warnings } = sanitizeForPublic(input);
    expect(sanitized).toEqual(input);
    expect(warnings).toEqual([]);
  });

  it("sanitizes object keys containing secrets or home paths", () => {
    const input = {
      "/Users/alice/secret-dir": "value",
      "token sk-1234567890abcdefghij": "ok",
    };

    const { sanitized, warnings } = sanitizeForPublic(input);
    expect(sanitized).toEqual({
      "~/secret-dir": "value",
      "token [REDACTED_SECRET]": "ok",
    });
    expect(warnings).toContain("Redacted unix_home_path");
    expect(warnings).toContain("Redacted openai_or_sk_key");
  });

  it("preserves URLs containing /home/ or /Users/ in their path", () => {
    const input = {
      docs: "https://example.com/home/dashboard",
      profile: "https://example.com/Users/alice/settings",
      portUrl: "http://localhost:8080/Users/alice",
    };

    const { sanitized, warnings } = sanitizeForPublic(input);
    expect(sanitized).toEqual(input);
    expect(warnings).toEqual([]);
  });
});
