import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExpectedLink,
  MagicLinkRecord,
  MagicLinkRepository,
  NewMagicLink,
} from "../../apps/api/src/repositories/magic-link.repository.js";
import type { EmailSender, MagicLinkEmail } from "../../apps/api/src/services/email.service.js";
import {
  decideIssue,
  evaluateMagicLink,
  MagicLinkService,
  STREAK_RESET_SECONDS,
} from "../../apps/api/src/services/magic-link.service.js";
import { hashToken } from "../../apps/api/src/services/token.service.js";

const EMAIL = "luiz@example.com";
const NOW = new Date("2026-01-01T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;

/** In-memory repository that mimics the DynamoDB conditional write semantics. */
class InMemoryRepository {
  items = new Map<string, MagicLinkRecord>();

  deleteFailure: Error | undefined;

  async save(link: NewMagicLink, expected: ExpectedLink | undefined): Promise<boolean> {
    const current = this.items.get(link.email);
    const unchanged =
      expected === undefined
        ? current === undefined
        : current !== undefined &&
          current.tokenHash === expected.tokenHash &&
          current.used === expected.used &&
          !(expected.undelivered && current.deliveredAt !== undefined);
    if (!unchanged) return false;
    this.items.set(link.email, { pk: `EMAIL#${link.email}`, ...link, used: false });
    return true;
  }

  async markDelivered(email: string, tokenHash: string, now: number) {
    const item = this.items.get(email);
    if (item?.tokenHash === tokenHash) item.deliveredAt = now;
  }

  async deleteUndelivered(email: string, tokenHash: string) {
    if (this.deleteFailure) throw this.deleteFailure;
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

    it("if even the rollback fails, the retry of the same request replaces its own undelivered link", async () => {
      emailSender.failure = new Error("SES is down");
      repository.deleteFailure = new Error("DynamoDB is down");
      await expect(service.requestMagicLink(EMAIL, { requestId: "msg-1" })).rejects.toThrow("SES is down");
      expect(repository.items.size).toBe(1); // the undelivered link is still there

      emailSender.failure = undefined;
      repository.deleteFailure = undefined;
      now = new Date(NOW.getTime() + 5_000); // well inside the cooldown
      await expect(service.requestMagicLink(EMAIL, { requestId: "msg-1" })).resolves.toMatchObject({ status: "SENT" });
      await expect(service.consumeMagicLink(EMAIL, emailSender.lastToken())).resolves.toBe("VALID");
    });

    it("another request does not get that privilege", async () => {
      emailSender.failure = new Error("SES is down");
      repository.deleteFailure = new Error("DynamoDB is down");
      await expect(service.requestMagicLink(EMAIL, { requestId: "msg-1" })).rejects.toThrow();

      emailSender.failure = undefined;
      await expect(service.requestMagicLink(EMAIL, { requestId: "msg-2" })).resolves.toEqual({ status: "COOLDOWN" });
    });

    it("a retry after a successful send (the worker died afterwards) sends nothing twice", async () => {
      await service.requestMagicLink(EMAIL, { requestId: "msg-1" });
      now = new Date(NOW.getTime() + 5_000);

      await expect(service.requestMagicLink(EMAIL, { requestId: "msg-1" })).resolves.toEqual({ status: "COOLDOWN" });
      expect(emailSender.sent).toHaveLength(1);
    });

    it("still reports the send as done when recording the delivery fails", async () => {
      vi.spyOn(repository, "markDelivered").mockRejectedValueOnce(new Error("DynamoDB is down"));
      await expect(service.requestMagicLink(EMAIL)).resolves.toMatchObject({ status: "SENT" });
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
      await service.requestMagicLink(EMAIL, { requestedAt: NOW_S + 10 });
      const linkB = emailSender.lastToken();

      now = new Date(NOW.getTime() + 130_000);
      await expect(service.requestMagicLink(EMAIL, { requestedAt: requestA })).resolves.toEqual({
        status: "SUPERSEDED",
      });

      expect(emailSender.sent).toHaveLength(1);
      await expect(service.consumeMagicLink(EMAIL, linkB)).resolves.toBe("VALID");
    });

    it("a request made after the previous link still gets a new one once the cooldown allows", async () => {
      await service.requestMagicLink(EMAIL, { requestedAt: NOW_S });
      now = new Date(NOW.getTime() + 61_000);
      await expect(service.requestMagicLink(EMAIL, { requestedAt: NOW_S + 61 })).resolves.toMatchObject({
        status: "SENT",
      });
    });

    it("a user who used their link can ask for another within the same second", async () => {
      await service.requestMagicLink(EMAIL, { requestedAt: NOW_S });
      await service.consumeMagicLink(EMAIL, emailSender.lastToken());
      await expect(service.requestMagicLink(EMAIL, { requestedAt: NOW_S })).resolves.toMatchObject({ status: "SENT" });
    });

    it("grows with each unused link: 60 s, 120 s, 240 s …, so a flood gets few emails through", async () => {
      const sentAfter = async (seconds: number) => {
        now = new Date(now.getTime() + seconds * 1000);
        return (await service.requestMagicLink(EMAIL)).status;
      };

      expect(await sentAfter(0)).toBe("SENT"); // streak 0
      expect(await sentAfter(60)).toBe("SENT"); // waited 60 s → streak 1
      expect(await sentAfter(119)).toBe("COOLDOWN"); // needs 120 s now
      expect(await sentAfter(1)).toBe("SENT"); // 120 s → streak 2
      expect(await sentAfter(239)).toBe("COOLDOWN");
      expect(await sentAfter(1)).toBe("SENT"); // 240 s
    });

    it("an attacker requesting nonstop gets at most a handful of emails an hour through", async () => {
      for (let second = 0; second < 3600; second += 5) {
        now = new Date(NOW.getTime() + second * 1000);
        await service.requestMagicLink(EMAIL);
      }
      // 0, 60, 180, 420, 900, 1800, 2700 (then capped at 15 min)
      expect(emailSender.sent.length).toBeLessThanOrEqual(7);
    });

    it("resets once a link is used", async () => {
      await service.requestMagicLink(EMAIL);
      now = new Date(NOW.getTime() + 60_000);
      await service.requestMagicLink(EMAIL); // streak 1
      await service.consumeMagicLink(EMAIL, emailSender.lastToken());

      await expect(service.requestMagicLink(EMAIL)).resolves.toMatchObject({ status: "SENT" });
      now = new Date(NOW.getTime() + 120_000);
      await expect(service.requestMagicLink(EMAIL)).resolves.toMatchObject({ status: "SENT" }); // back to 60 s
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
    purgeAt: NOW_S + 86_400,
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

describe("decideIssue", () => {
  const policy = { cooldownSeconds: 60, maxCooldownSeconds: 900 };
  const record = (overrides: Partial<MagicLinkRecord> = {}): MagicLinkRecord => ({
    pk: `EMAIL#${EMAIL}`,
    email: EMAIL,
    tokenHash: "h",
    createdAt: NOW_S,
    expiresAt: NOW_S + 600,
    used: false,
    purgeAt: NOW_S + 86_400,
    ...overrides,
  });

  it("allows the first link", () => {
    expect(decideIssue(undefined, NOW_S, {}, policy)).toEqual({
      allowed: true,
      streak: 0,
      replacingOwnUndelivered: false,
    });
  });

  it("treats items written before streaks existed as streak 0", () => {
    expect(decideIssue(record(), NOW_S + 60, {}, policy)).toMatchObject({ allowed: true, streak: 1 });
  });

  it("caps the cooldown", () => {
    expect(decideIssue(record({ streak: 20 }), NOW_S + 899, {}, policy)).toMatchObject({ allowed: false });
    expect(decideIssue(record({ streak: 20 }), NOW_S + 900, {}, policy)).toMatchObject({ allowed: true, streak: 21 });
  });

  it("forgets an unused streak after an hour without requests", () => {
    expect(decideIssue(record({ streak: 6 }), NOW_S + STREAK_RESET_SECONDS, {}, policy)).toMatchObject({
      allowed: true,
      streak: 0,
    });
  });

  it("lets a retry replace its own undelivered link, keeping the streak", () => {
    expect(decideIssue(record({ streak: 3, requestId: "m" }), NOW_S + 1, { requestId: "m" }, policy)).toEqual({
      allowed: true,
      streak: 3,
      replacingOwnUndelivered: true,
    });
  });

  it("does not let a retry replace its own link once it was delivered", () => {
    const delivered = record({ requestId: "m", deliveredAt: NOW_S });
    expect(decideIssue(delivered, NOW_S + 1, { requestId: "m" }, policy)).toEqual({
      allowed: false,
      status: "COOLDOWN",
    });
  });

  it("never lets a late request replace a newer link, even a used one", () => {
    expect(decideIssue(record({ used: true }), NOW_S + 999, { requestedAt: NOW_S - 1 }, policy)).toEqual({
      allowed: false,
      status: "SUPERSEDED",
    });
  });
});
