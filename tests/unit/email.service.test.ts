import { describe, expect, it } from "vitest";
import { renderHtml, renderText } from "../../apps/api/src/services/email.service.js";

describe("email templates", () => {
  const link = "http://localhost:5173/auth/callback?email=a%40b.com&token=abc";

  it("includes the link and expiry in the text body", () => {
    const text = renderText(link, 10);
    expect(text).toContain(link);
    expect(text).toContain("expires in 10 minutes");
  });

  it("escapes the link in the HTML body", () => {
    const html = renderHtml(`${link}"><script>`, 10);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;token=abc&quot;&gt;&lt;script&gt;");
  });
});
