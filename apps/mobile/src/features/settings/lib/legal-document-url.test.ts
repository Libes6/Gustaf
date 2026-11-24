import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl, LEGAL_URL } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each(["https://example.com/legal", "javascript:alert(1)"])(
    "rejects a URL outside the legal-document allowlist: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(false);
    },
  );

  it("accepts only Gustaf's own legal pages", () => {
    expect(LEGAL_URL).toMatch(/^https:\/\/github\.com\/Libes6\/Gustaf\//u);
    expect(isLegalDocumentUrl(LEGAL_URL)).toBe(true);
    expect(isLegalDocumentUrl("https://t3.codes/legal")).toBe(false);
  });
});
