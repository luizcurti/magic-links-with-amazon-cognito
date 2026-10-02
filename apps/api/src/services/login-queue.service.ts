import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

export interface LoginRequest {
  email: string;
  /** Epoch seconds: a late delivery never replaces a newer link. */
  requestedAt: number;
}

/** Queues sign-in requests for the send-magic-link worker. */
export class LoginQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async enqueue(request: LoginRequest): Promise<void> {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(request) }));
  }
}
