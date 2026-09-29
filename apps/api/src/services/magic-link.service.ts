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
  /** Frontend route that receives `?email=...&token=...`. */
  callbackUrl?: string;
  ttlSeconds?: number;
  /** Minimum time between two links for the same email, against email bombing. */
  cooldownSeconds?: number;
  now?: () => Date;
}

export type IssueResult = { status: "SENT"; expiresAt: number } | { status: "COOLDOWN" };

export const DEFAULT_TTL_SECONDS = 10 * 60;
export const DEFAULT_COOLDOWN_SECONDS = 60;

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
  private readonly cooldownSeconds: number;
  private readonly now: () => Date;

  constructor(options: MagicLinkServiceOptions) {
    this.repository = options.repository;
    this.emailSender = options.emailSender;
    this.callbackUrl = options.callbackUrl;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.cooldownSeconds = options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Issues a new single-use link. The plaintext token exists only in memory
   * and in the email; the database only ever sees its hash.
   *
   * Within the cooldown window nothing is stored or sent, so a flood of
   * requests for someone else's address produces at most one email.
   */
  async requestMagicLink(email: string): Promise<IssueResult> {
    if (!this.emailSender || !this.callbackUrl) {
      throw new Error("MagicLinkService needs an emailSender and callbackUrl to issue links");
    }

    const token = generateToken();
    const createdAt = toEpochSeconds(this.now());
    const expiresAt = createdAt + this.ttlSeconds;

    const saved = await this.repository.save(
      { email, tokenHash: hashToken(token), createdAt, expiresAt },
      createdAt - this.cooldownSeconds,
    );
    if (!saved) return { status: "COOLDOWN" };

    await this.emailSender.sendMagicLink({
      to: email,
      magicLink: buildMagicLink(this.callbackUrl, email, token),
      expiresInMinutes: Math.round(this.ttlSeconds / 60),
    });

    return { status: "SENT", expiresAt };
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
