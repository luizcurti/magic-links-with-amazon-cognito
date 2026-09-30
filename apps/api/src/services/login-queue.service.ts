import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

export interface LoginRequest {
  email: string;
  /** Epoch seconds: when the user asked, so a late delivery never replaces a newer link. */
  requestedAt: number;
}

/**
 * Hands sign-in requests to the send-magic-link worker. POST /login does
 * nothing else, so it answers in the same time whether the email is new,
 * known, or inside its cooldown, and an SES outage is retried by SQS instead
 * of failing the request.
 */
export class LoginQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async enqueue(request: LoginRequest): Promise<void> {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(request) }));
  }
}
