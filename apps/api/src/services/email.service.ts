import { SendEmailCommand, type SESClient } from "@aws-sdk/client-ses";

export interface MagicLinkEmail {
  to: string;
  magicLink: string;
  expiresInMinutes: number;
}

export interface EmailSender {
  sendMagicLink(email: MagicLinkEmail): Promise<void>;
}

export class SesEmailService implements EmailSender {
  constructor(
    private readonly ses: SESClient,
    private readonly fromAddress: string,
  ) {}

  async sendMagicLink({ to, magicLink, expiresInMinutes }: MagicLinkEmail): Promise<void> {
    await this.ses.send(
      new SendEmailCommand({
        Source: this.fromAddress,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: "Your magic login link", Charset: "UTF-8" },
          Body: {
            Text: { Data: renderText(magicLink, expiresInMinutes), Charset: "UTF-8" },
            Html: { Data: renderHtml(magicLink, expiresInMinutes), Charset: "UTF-8" },
          },
        },
      }),
    );
  }
}

export function renderText(magicLink: string, expiresInMinutes: number): string {
  return [
    "Hi!",
    "",
    "Click the link below to sign in:",
    "",
    magicLink,
    "",
    `This link expires in ${expiresInMinutes} minutes and can only be used once.`,
    "If you did not request it, you can safely ignore this email.",
  ].join("\n");
}

export function renderHtml(magicLink: string, expiresInMinutes: number): string {
  const href = escapeHtml(magicLink);
  return `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
    <p>Hi!</p>
    <p>Click the button below to sign in:</p>
    <p><a href="${href}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;">Sign in</a></p>
    <p style="font-size: 13px; color: #555;">Or paste this URL into your browser:<br>${href}</p>
    <p style="font-size: 13px; color: #555;">This link expires in ${expiresInMinutes} minutes and can only be used once.
    If you did not request it, you can safely ignore this email.</p>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
