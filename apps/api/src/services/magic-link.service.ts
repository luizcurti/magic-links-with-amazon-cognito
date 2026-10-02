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
  /** Frontend route that receives `#email=…&token=…`. */
  callbackUrl?: string;
  ttlSeconds?: number;
  /** Minimum time between two links for one email; doubles with each unused link. */
  cooldownSeconds?: number;
  /** Ceiling of the growing cooldown. */
  maxCooldownSeconds?: number;
  now?: () => Date;
}

/** Origin of a queued request. */
export interface IssueOptions {
  /** Epoch seconds. A link created after this is never replaced. */
  requestedAt?: number;
  /** SQS message ID: its retry may replace its own undelivered link. */
  requestId?: string;
}

export type IssueResult =
  | { status: "SENT"; expiresAt: number }
  /** Inside the cooldown, or a parallel request won. */
  | { status: "COOLDOWN" }
  /** A link newer than the request exists. */
  | { status: "SUPERSEDED" };

export const DEFAULT_TTL_SECONDS = 10 * 60;
export const DEFAULT_COOLDOWN_SECONDS = 60;
export const DEFAULT_MAX_COOLDOWN_SECONDS = 15 * 60;
/** An unused streak resets after this long without a new link. */
export const STREAK_RESET_SECONDS = 60 * 60;
/** How long an item (and its streak) is kept. */
export const PURGE_AFTER_SECONDS = 24 * 60 * 60;

export interface CooldownPolicy {
  cooldownSeconds: number;
  maxCooldownSeconds: number;
}

export type IssueDecision =
  | { allowed: true; streak: number; replacingOwnUndelivered: boolean }
  | { allowed: false; status: "COOLDOWN" | "SUPERSEDED" };

/**
 * Whether a new link may be issued. The cooldown doubles with each unused
 * link (60 s, 120 s … up to the ceiling) and resets when a link is used or
 * after an hour without requests.
 */
export function decideIssue(
  previous: MagicLinkRecord | undefined,
  nowEpochSeconds: number,
  { requestedAt, requestId }: IssueOptions,
  { cooldownSeconds, maxCooldownSeconds }: CooldownPolicy,
): IssueDecision {
  if (!previous) return { allowed: true, streak: 0, replacingOwnUndelivered: false };
  const streak = previous.streak ?? 0;

  // Retry of the request that wrote this link, whose email never went out.
  if (requestId !== undefined && previous.requestId === requestId && previous.deliveredAt === undefined) {
    return { allowed: true, streak, replacingOwnUndelivered: true };
  }
  // A late request never replaces a newer link.
  if (requestedAt !== undefined && previous.createdAt > requestedAt) return { allowed: false, status: "SUPERSEDED" };
  if (previous.used) return { allowed: true, streak: 0, replacingOwnUndelivered: false };

  const idle = nowEpochSeconds - previous.createdAt;
  if (idle >= STREAK_RESET_SECONDS) return { allowed: true, streak: 0, replacingOwnUndelivered: false };
  if (idle < Math.min(cooldownSeconds * 2 ** streak, maxCooldownSeconds)) return { allowed: false, status: "COOLDOWN" };
  return { allowed: true, streak: streak + 1, replacingOwnUndelivered: false };
}

const toEpochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/** Checks a link: structure first, then the secret, then expiry and reuse. */
export function evaluateMagicLink(
  record: MagicLinkRecord | undefined,
  email: string,
  tokenHash: string,
  nowEpochSeconds: number,
): VerificationResult {
  if (!record) return "NOT_FOUND";
  // Defence in depth: the key is already derived from the email.
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
   * Issues a single-use link: only its hash is stored. Parallel requests
   * issue at most one link (optimistic concurrency).
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
      // Drop the undelivered link so the retry is not blocked by the cooldown.
      await this.repository.deleteUndelivered(email, tokenHash).catch(() => undefined);
      throw error;
    }

    // Best effort: stops a retry of this request from sending a second email.
    await this.repository.markDelivered(email, tokenHash, createdAt).catch(() => undefined);
    return { status: "SENT", expiresAt };
  }

  /** Read-only check, before any Cognito call. consumeMagicLink is the authority. */
  async checkMagicLink(email: string, token: string): Promise<VerificationResult> {
    if (!isValidTokenFormat(token)) return "INVALID_FORMAT";
    const record = await this.repository.findByEmail(email);
    return evaluateMagicLink(record, email, hashToken(token), toEpochSeconds(this.now()));
  }

  /** Validates and consumes a link; "VALID" only for the call that won the atomic update. */
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
