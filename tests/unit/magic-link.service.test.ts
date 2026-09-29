import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicLinkRecord, MagicLinkRepository, NewMagicLink } from "../../apps/api/src/repositories/magic-link.repository.js";
import type { EmailSender, MagicLinkEmail } from "../../apps/api/src/services/email.service.js";
import { evaluateMagicLink, MagicLinkService } from "../../apps/api/src/services/magic-link.service.js";
import { hashToken } from "../../apps/api/src/services/token.service.js";

const EMAIL = "luiz@example.com";
const NOW = new Date("2026-01-01T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;

/** In-memory repository that mimics the DynamoDB conditional update semantics. */
class InMemoryRepository {
  items = new Map<string, MagicLinkRecord>();

  async save(link: NewMagicLink): Promise<MagicLinkRecord> {
    const record = { pk: `EMAIL#${link.email}`, ...link, used: false };
    this.items.set(link.email, record);
    return record;
  }

  async findByEmail(email: string) {
    const item = this.items.get(email);
    return item && { ...item };
  }

  async markAsUsed(email: string, tokenHash: string, now: number) {
    const item = this.items.get(email);
    if (!item || item.used || item.tokenHash !== tokenHash || item.expiresAt <= now) return false;
    item.used = true;
    item.usedAt = now;
    return true;
  }
}

class CapturingEmailSender implements EmailSender {
  sent: MagicLinkEmail[] = [];
  async sendMagicLink(email: MagicLinkEmail) {
    this.sent.push(email);
  }
  lastToken(): string {
    const link = this.sent.at(-1)?.magicLink;
    return new URL(link!).searchParams.get("token")!;
  }
}

describe("MagicLinkService", () => {
  let repository: InMemoryRepository;
  let emailSender: CapturingEmailSender;
  let now: Date;
  let service: MagicLinkService;

  beforeEach(() => {
    repository = new InMemoryRepository();
    emailSender = new CapturingEmailSender();
    now = NOW;
    service = new MagicLinkService({
      repository: repository as unknown as MagicLinkRepository,
      emailSender,
      callbackUrl: "http://localhost:5173/auth/callback",
      ttlSeconds: 600,
      now: () => now,
    });
  });

  describe("requestMagicLink", () => {
    it("stores only the token hash, never the plaintext token", async () => {
      await service.requestMagicLink(EMAIL);

      const token = emailSender.lastToken();
      const record = repository.items.get(EMAIL)!;

      expect(record.tokenHash).toBe(hashToken(token));
      expect(JSON.stringify(record)).not.toContain(token);
    });

    it("sets expiry, TTL and single-use state", async () => {
      const { expiresAt } = await service.requestMagicLink(EMAIL);

      expect(expiresAt).toBe(NOW_S + 600);
      expect(repository.items.get(EMAIL)).toMatchObject({
        pk: `EMAIL#${EMAIL}`,
        email: EMAIL,
        createdAt: NOW_S,
        expiresAt: NOW_S + 600,
        used: false,
      });
    });

    it("emails a link that points to the frontend callback", async () => {
      await service.requestMagicLink(EMAIL);

      const [email] = emailSender.sent;
      expect(email?.to).toBe(EMAIL);
      expect(email?.expiresInMinutes).toBe(10);
      expect(email?.magicLink).toMatch(/^http:\/\/localhost:5173\/auth\/callback\?email=luiz%40example\.com&token=[0-9a-f]{64}$/);
    });
  });

  describe("consumeMagicLink", () => {
    it("accepts a valid token exactly once", async () => {
      await service.requestMagicLink(EMAIL);
      const token = emailSender.lastToken();

      await expect(service.consumeMagicLink(EMAIL, token)).resolves.toBe("VALID");
      await expect(service.consumeMagicLink(EMAIL, token)).resolves.toBe("ALREADY_USED");
    });

    it("rejects an expired token", async () => {
      await service.requestMagicLink(EMAIL);
      const token = emailSender.lastToken();

      now = new Date(NOW.getTime() + 601_000);
      await expect(service.consumeMagicLink(EMAIL, token)).resolves.toBe("EXPIRED");
    });

    it("rejects an invalid token", async () => {
      await service.requestMagicLink(EMAIL);
      await expect(service.consumeMagicLink(EMAIL, "0".repeat(64))).resolves.toBe("TOKEN_MISMATCH");
    });

    it("rejects malformed tokens without touching the database", async () => {
      const spy = vi.spyOn(repository, "findByEmail");
      await expect(service.consumeMagicLink(EMAIL, "not-a-token")).resolves.toBe("INVALID_FORMAT");
      expect(spy).not.toHaveBeenCalled();
    });

    it("rejects a token presented for a different email", async () => {
      await service.requestMagicLink(EMAIL);
      const token = emailSender.lastToken();

      await expect(service.consumeMagicLink("attacker@example.com", token)).resolves.toBe("NOT_FOUND");
    });

    it("invalidates the previous link when a new one is requested", async () => {
      await service.requestMagicLink(EMAIL);
      const firstToken = emailSender.lastToken();
      await service.requestMagicLink(EMAIL);
      const secondToken = emailSender.lastToken();

      await expect(service.consumeMagicLink(EMAIL, firstToken)).resolves.toBe("TOKEN_MISMATCH");
      await expect(service.consumeMagicLink(EMAIL, secondToken)).resolves.toBe("VALID");
    });

    it("lets only one of two concurrent requests win", async () => {
      await service.requestMagicLink(EMAIL);
      const token = emailSender.lastToken();

      const results = await Promise.all([
        service.consumeMagicLink(EMAIL, token),
        service.consumeMagicLink(EMAIL, token),
      ]);
      expect(results.sort()).toEqual(["ALREADY_USED", "VALID"]);
    });
  });
});

describe("evaluateMagicLink", () => {
  const hash = hashToken("secret");
  const record: MagicLinkRecord = {
    pk: `EMAIL#${EMAIL}`,
    email: EMAIL,
    tokenHash: hash,
    createdAt: NOW_S,
    expiresAt: NOW_S + 600,
    used: false,
  };

  it.each([
    ["valid", record, EMAIL, hash, NOW_S, "VALID"],
    ["missing record", undefined, EMAIL, hash, NOW_S, "NOT_FOUND"],
    ["email mismatch", record, "other@example.com", hash, NOW_S, "EMAIL_MISMATCH"],
    ["token mismatch", record, EMAIL, hashToken("wrong"), NOW_S, "TOKEN_MISMATCH"],
    ["already used", { ...record, used: true }, EMAIL, hash, NOW_S, "ALREADY_USED"],
    ["expired at the boundary", record, EMAIL, hash, NOW_S + 600, "EXPIRED"],
  ] as const)("%s", (_label, input, email, tokenHash, now, expected) => {
    expect(evaluateMagicLink(input, email, tokenHash, now)).toBe(expected);
  });
});
