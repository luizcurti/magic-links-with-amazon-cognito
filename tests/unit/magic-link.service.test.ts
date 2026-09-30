import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MagicLinkRecord,
  MagicLinkRepository,
  NewMagicLink,
} from "../../apps/api/src/repositories/magic-link.repository.js";
import type { EmailSender, MagicLinkEmail } from "../../apps/api/src/services/email.service.js";
import { evaluateMagicLink, MagicLinkService } from "../../apps/api/src/services/magic-link.service.js";
import { hashToken } from "../../apps/api/src/services/token.service.js";

const EMAIL = "luiz@example.com";
const NOW = new Date("2026-01-01T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;

/** In-memory repository that mimics the DynamoDB conditional write semantics. */
class InMemoryRepository {
  items = new Map<string, MagicLinkRecord>();

  async save(link: NewMagicLink, cooldownStart: number, requestedAt?: number): Promise<boolean> {
    const previous = this.items.get(link.email);
    if (previous && !previous.used && previous.createdAt > cooldownStart) return false;
    if (previous && requestedAt !== undefined && previous.createdAt > requestedAt) return false;
    this.items.set(link.email, { pk: `EMAIL#${link.email}`, ...link, used: false });
    return true;
  }

  async deleteUndelivered(email: string, tokenHash: string) {
    const item = this.items.get(email);
    if (item && !item.used && item.tokenHash === tokenHash) this.items.delete(email);
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
  failure: Error | undefined;
  async sendMagicLink(email: MagicLinkEmail) {
    if (this.failure) throw this.failure;
    this.sent.push(email);
  }
  lastToken(): string {
    const link = this.sent.at(-1)?.magicLink;
    return new URLSearchParams(new URL(link!).hash.slice(1)).get("token")!;
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
      await expect(service.requestMagicLink(EMAIL)).resolves.toEqual({ status: "SENT", expiresAt: NOW_S + 600 });

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
      expect(email?.magicLink).toMatch(
        /^http:\/\/localhost:5173\/auth\/callback#email=luiz%40example\.com&token=[0-9a-f]{64}$/,
      );
    });

    it("refuses to issue links when it has no way to deliver them", async () => {
      const verifyOnly = new MagicLinkService({ repository: repository as unknown as MagicLinkRepository });
      await expect(verifyOnly.requestMagicLink(EMAIL)).rejects.toThrow("needs an emailSender and callbackUrl");
      expect(repository.items.size).toBe(0);
    });
  });

  describe("delivery failure", () => {
    it("drops the undelivered link, so a retry sends a new one instead of hitting the cooldown", async () => {
      emailSender.failure = new Error("SES is down");
      await expect(service.requestMagicLink(EMAIL)).rejects.toThrow("SES is down");
      expect(repository.items.size).toBe(0);

      emailSender.failure = undefined;
      await expect(service.requestMagicLink(EMAIL)).resolves.toMatchObject({ status: "SENT" });
      expect(emailSender.sent).toHaveLength(1);
    });
  });

  describe("cooldown (email-bombing protection)", () => {
    it("sends nothing for a second request inside the window and keeps the first link valid", async () => {
      await service.requestMagicLink(EMAIL);
      const firstToken = emailSender.lastToken();

      now = new Date(NOW.getTime() + 59_000);
      await expect(service.requestMagicLink(EMAIL)).resolves.toEqual({ status: "COOLDOWN" });

      expect(emailSender.sent).toHaveLength(1);
      await expect(service.consumeMagicLink(EMAIL, firstToken)).resolves.toBe("VALID");
    });

    it("issues a new link once the window has passed", async () => {
      await service.requestMagicLink(EMAIL);

      now = new Date(NOW.getTime() + 60_000);
      await expect(service.requestMagicLink(EMAIL)).resolves.toMatchObject({ status: "SENT" });
      expect(emailSender.sent).toHaveLength(2);
    });

    it("does not block a user who already used their link", async () => {
      await service.requestMagicLink(EMAIL);
      await service.consumeMagicLink(EMAIL, emailSender.lastToken());

      await expect(service.requestMagicLink(EMAIL)).resolves.toMatchObject({ status: "SENT" });
    });

    it("a late request never replaces a link issued after it was made", async () => {
      // Request A at 12:00:00 fails and is retried by SQS; meanwhile request B
      // (12:00:10) delivered a link. A's retry lands well past the cooldown.
      const requestA = NOW_S;
      now = new Date(NOW.getTime() + 10_000);
      await service.requestMagicLink(EMAIL, NOW_S + 10);
      const linkB = emailSender.lastToken();

      now = new Date(NOW.getTime() + 130_000);
      await expect(service.requestMagicLink(EMAIL, requestA)).resolves.toEqual({ status: "COOLDOWN" });

      expect(emailSender.sent).toHaveLength(1);
      await expect(service.consumeMagicLink(EMAIL, linkB)).resolves.toBe("VALID");
    });

    it("a request made after the previous link still gets a new one once the cooldown allows", async () => {
      await service.requestMagicLink(EMAIL, NOW_S);
      now = new Date(NOW.getTime() + 61_000);
      await expect(service.requestMagicLink(EMAIL, NOW_S + 61)).resolves.toMatchObject({ status: "SENT" });
    });

    it("a user who used their link can ask for another within the same second", async () => {
      await service.requestMagicLink(EMAIL, NOW_S);
      await service.consumeMagicLink(EMAIL, emailSender.lastToken());
      await expect(service.requestMagicLink(EMAIL, NOW_S)).resolves.toMatchObject({ status: "SENT" });
    });

    it("applies per email, not globally", async () => {
      await service.requestMagicLink(EMAIL);
      await expect(service.requestMagicLink("other@example.com")).resolves.toMatchObject({ status: "SENT" });
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

    it("can be checked without being consumed", async () => {
      await service.requestMagicLink(EMAIL);
      const token = emailSender.lastToken();

      await expect(service.checkMagicLink(EMAIL, token)).resolves.toBe("VALID");
      await expect(service.checkMagicLink(EMAIL, "0".repeat(64))).resolves.toBe("TOKEN_MISMATCH");
      await expect(service.checkMagicLink(EMAIL, "nope")).resolves.toBe("INVALID_FORMAT");
      await expect(service.consumeMagicLink(EMAIL, token)).resolves.toBe("VALID");
      await expect(service.checkMagicLink(EMAIL, token)).resolves.toBe("ALREADY_USED");
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
      now = new Date(NOW.getTime() + 61_000);
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
