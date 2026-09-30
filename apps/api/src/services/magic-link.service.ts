import type { MagicLinkRecord, MagicLinkRepository } from "../repositories/magic-link.repository.js";
import type { EmailSender } from "./email.service.js";
import { buildMagicLink, generateToken, hashesMatch, hashToken, isValidTokenFormat } from "./token.service.js";

export type VerificationResult =
  | "VALID"
  | "INVALID_FORMAT"
  | "NOT_FOUND"
  | "EMAIL_MISMATCH"
  | "TOKEN_MISMATCH"
  | "EXPIRED"
  | "ALREADY_USED";

export interface MagicLinkServiceOptions {
  repository: MagicLinkRepository;
  emailSender?: EmailSender;
  /** Frontend route that receives `#email=...&token=...`. */
  callbackUrl?: string;
  ttlSeconds?: number;
  /** Minimum time between two links for the same email, against email bombing. Doubles with each unused link. */
  cooldownSeconds?: number;
  /** Ceiling of the growing cooldown. */
  maxCooldownSeconds?: number;
  now?: () => Date;
}

/** Where a request for a link came from, when it went through the queue. */
export interface IssueOptions {
  /** Epoch seconds: when the user asked. A link created after that is never replaced. */
  requestedAt?: number;
  /** ID of the queued request (SQS message), so a retry of it may replace its own undelivered link. */
  requestId?: string;
}

export type IssueResult =
  | { status: "SENT"; expiresAt: number }
  /** Too soon after the previous unused link, or another request won the race. */
  | { status: "COOLDOWN" }
  /** A link newer than this request already exists. */
  | { status: "SUPERSEDED" };

export const DEFAULT_TTL_SECONDS = 10 * 60;
export const DEFAULT_COOLDOWN_SECONDS = 60;
export const DEFAULT_MAX_COOLDOWN_SECONDS = 15 * 60;
/** After this long without a new link, an unused streak is forgotten. */
export const STREAK_RESET_SECONDS = 60 * 60;
/** How long an item (and its streak) is kept after it was written. */
export const PURGE_AFTER_SECONDS = 24 * 60 * 60;

export interface CooldownPolicy {
  cooldownSeconds: number;
  maxCooldownSeconds: number;
}

export type IssueDecision =
  | { allowed: true; streak: number; replacingOwnUndelivered: boolean }
  | { allowed: false; status: "COOLDOWN" | "SUPERSEDED" };

/**
 * Whether a new link may be issued, given the current item. Pure, so every
 * rule is unit-testable. The cooldown grows with each link issued in a row
 * without one being used (60 s, 120 s, 240 s … up to the ceiling): someone
 * flooding another person's address gets a handful of emails an hour
 * through, not sixty. Using a link, or an hour without requests, resets it.
 */
export function decideIssue(
  previous: MagicLinkRecord | undefined,
  nowEpochSeconds: number,
  { requestedAt, requestId }: IssueOptions,
  { cooldownSeconds, maxCooldownSeconds }: CooldownPolicy,
): IssueDecision {
  if (!previous) return { allowed: true, streak: 0, replacingOwnUndelivered: false };
  const streak = previous.streak ?? 0;

  // A retry of the request that wrote this link, whose email never went out
  // (SES and the rollback both failed): it must be able to try again.
  if (requestId !== undefined && previous.requestId === requestId && previous.deliveredAt === undefined) {
    return { allowed: true, streak, replacingOwnUndelivered: true };
  }
  // A request that reaches the worker late must not replace a newer link.
  if (requestedAt !== undefined && previous.createdAt > requestedAt) return { allowed: false, status: "SUPERSEDED" };
  if (previous.used) return { allowed: true, streak: 0, replacingOwnUndelivered: false };

  const idle = nowEpochSeconds - previous.createdAt;
  if (idle >= STREAK_RESET_SECONDS) return { allowed: true, streak: 0, replacingOwnUndelivered: false };
  if (idle < Math.min(cooldownSeconds * 2 ** streak, maxCooldownSeconds)) return { allowed: false, status: "COOLDOWN" };
  return { allowed: true, streak: streak + 1, replacingOwnUndelivered: false };
}

const toEpochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/**
 * Pure decision logic, kept separate from I/O so every rule is unit-testable.
 * Order matters: cheap structural checks first, then the secret comparison,
 * then state (expiry / reuse).
 */
export function evaluateMagicLink(
  record: MagicLinkRecord | undefined,
  email: string,
  tokenHash: string,
  nowEpochSeconds: number,
): VerificationResult {
  if (!record) return "NOT_FOUND";
  // Cannot happen while the key is derived from the email; kept as defence in
  // depth, so a token is never checked against another address's item.
  if (record.email !== email) return "EMAIL_MISMATCH";
  if (!hashesMatch(record.tokenHash, tokenHash)) return "TOKEN_MISMATCH";
  if (record.used) return "ALREADY_USED";
  if (record.expiresAt <= nowEpochSeconds) return "EXPIRED";
  return "VALID";
}

export class MagicLinkService {
  private readonly repository: MagicLinkRepository;
  private readonly emailSender: EmailSender | undefined;
  private readonly callbackUrl: string | undefined;
  private readonly ttlSeconds: number;
  private readonly cooldown: CooldownPolicy;
  private readonly now: () => Date;

  constructor(options: MagicLinkServiceOptions) {
    this.repository = options.repository;
    this.emailSender = options.emailSender;
    this.callbackUrl = options.callbackUrl;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.cooldown = {
      cooldownSeconds: options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
      maxCooldownSeconds: options.maxCooldownSeconds ?? DEFAULT_MAX_COOLDOWN_SECONDS,
    };
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Issues a new single-use link. The plaintext token exists only in memory
   * and in the email; the database only ever sees its hash.
   *
   * Nothing is stored or sent within the cooldown (see decideIssue), or when a
   * link newer than the request already exists. The decision is written with
   * optimistic concurrency, so parallel requests issue at most one link.
   */
  async requestMagicLink(email: string, options: IssueOptions = {}): Promise<IssueResult> {
    if (!this.emailSender || !this.callbackUrl) {
      throw new Error("MagicLinkService needs an emailSender and callbackUrl to issue links");
    }

    const createdAt = toEpochSeconds(this.now());
    const previous = await this.repository.findByEmail(email);
    const decision = decideIssue(previous, createdAt, options, this.cooldown);
    if (!decision.allowed) return { status: decision.status };

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = createdAt + this.ttlSeconds;
    const saved = await this.repository.save(
      {
        email,
        tokenHash,
        createdAt,
        expiresAt,
        streak: decision.streak,
        requestId: options.requestId,
        purgeAt: createdAt + Math.max(PURGE_AFTER_SECONDS, this.ttlSeconds),
      },
      previous && {
        tokenHash: previous.tokenHash,
        used: previous.used,
        undelivered: decision.replacingOwnUndelivered,
      },
    );
    if (!saved) return { status: "COOLDOWN" };

    try {
      await this.emailSender.sendMagicLink({
        to: email,
        magicLink: buildMagicLink(this.callbackUrl, email, token),
        expiresInMinutes: Math.round(this.ttlSeconds / 60),
      });
    } catch (error) {
      // Nobody received this link: drop it, so another request is not held back
      // by the cooldown. If even that fails, the retry of this same request
      // replaces the link itself (decideIssue), so the user still gets an email.
      await this.repository.deleteUndelivered(email, tokenHash).catch(() => undefined);
      throw error;
    }

    // Lets a retry of this request (the worker died after sending) see that
    // the email went out, instead of sending a second one. Best effort: if it
    // fails, such a retry just sends a fresh link.
    await this.repository.markDelivered(email, tokenHash, createdAt).catch(() => undefined);
    return { status: "SENT", expiresAt };
  }

  /**
   * Read-only check, without consuming the link. Lets the API turn away bad
   * links before creating a Cognito user or spending Cognito auth quota; the
   * atomic consume in consumeMagicLink remains the only authority.
   */
  async checkMagicLink(email: string, token: string): Promise<VerificationResult> {
    if (!isValidTokenFormat(token)) return "INVALID_FORMAT";
    const record = await this.repository.findByEmail(email);
    return evaluateMagicLink(record, email, hashToken(token), toEpochSeconds(this.now()));
  }

  /**
   * Validates a token and, if valid, consumes it so it can never be reused.
   * Only returns "VALID" when this call won the atomic conditional update.
   */
  async consumeMagicLink(email: string, token: string): Promise<VerificationResult> {
    if (!isValidTokenFormat(token)) return "INVALID_FORMAT";

    const tokenHash = hashToken(token);
    const nowEpochSeconds = toEpochSeconds(this.now());
    const record = await this.repository.findByEmail(email);

    const result = evaluateMagicLink(record, email, tokenHash, nowEpochSeconds);
    if (result !== "VALID") return result;

    const consumed = await this.repository.markAsUsed(email, tokenHash, nowEpochSeconds);
    return consumed ? "VALID" : "ALREADY_USED";
  }
}
