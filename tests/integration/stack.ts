import { execSync } from "node:child_process";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

export interface StackOutputs {
  apiUrl: string;
  tableName: string;
  userPoolId: string;
  clientId: string;
  loginQueueUrl: string;
  apiId: string;
}

export const LOCALSTACK_ENDPOINT = process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";

/** Reads Terraform outputs; returns undefined when the stack is not deployed. */
export function loadStack(): StackOutputs | undefined {
  try {
    const raw = execSync("terraform -chdir=infrastructure/terraform output -json", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const outputs = JSON.parse(raw) as Record<string, { value: string }>;
    if (!outputs.api_url) return undefined;
    return {
      apiUrl: outputs.api_url.value,
      tableName: outputs.magic_links_table!.value,
      userPoolId: outputs.user_pool_id!.value,
      clientId: outputs.user_pool_client_id!.value,
      loginQueueUrl: outputs.login_queue_url!.value,
      apiId: outputs.api_id!.value,
    };
  } catch {
    return undefined;
  }
}

export async function isLocalStackUp(): Promise<boolean> {
  try {
    const response = await fetch(`${LOCALSTACK_ENDPOINT}/_localstack/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, string> };
}

interface SesMessage {
  Destination?: { ToAddresses?: string[] };
  Body?: { text_part?: string };
  Timestamp: string;
}

/** LocalStack reports UTC timestamps without a zone suffix, which Date would read as local time. */
const sentAt = (message: SesMessage): number =>
  Date.parse(/Z|[+-]\d\d:\d\d$/.test(message.Timestamp) ? message.Timestamp : `${message.Timestamp}Z`);

async function sesMessages(): Promise<SesMessage[]> {
  const response = await fetch(`${LOCALSTACK_ENDPOINT}/_aws/ses`);
  const { messages = [] } = (await response.json()) as { messages?: SesMessage[] };
  return messages;
}

/** Number of emails LocalStack SES captured for `email`. */
export async function countEmails(email: string): Promise<number> {
  return (await sesMessages()).filter((m) => m.Destination?.ToAddresses?.includes(email)).length;
}

const magicLinkIn = (message: SesMessage | undefined) =>
  message?.Body?.text_part?.match(/https?:\/\/\S+token=[0-9a-f]{64}/)?.[0];

/** The newest magic link already delivered to `email`, if any. */
export async function latestMagicLink(email: string): Promise<string | undefined> {
  const messages = (await sesMessages()).filter((m) => m.Destination?.ToAddresses?.includes(email));
  return magicLinkIn(messages.sort((a, b) => sentAt(a) - sentAt(b)).at(-1));
}

/**
 * Polls LocalStack's SES capture endpoint for the newest magic link sent to
 * `email`. Emails are sent asynchronously (SQS worker), so pass the link that
 * was already there before the request as `previous` to wait for a new one.
 */
export async function waitForMagicLink(
  email: string,
  after: Date,
  timeoutMs = 10_000,
  previous?: string,
): Promise<URL> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const latest = (await sesMessages())
      .filter((m) => m.Destination?.ToAddresses?.includes(email) && sentAt(m) >= after.getTime())
      .sort((a, b) => sentAt(a) - sentAt(b))
      .at(-1);

    const link = magicLinkIn(latest);
    if (link && link !== previous) return new URL(link);

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No magic link for ${email} within ${timeoutMs}ms`);
}

/** Email and token travel in the link's fragment: `…/auth/callback#email=…&token=…`. */
export const linkParams = (link: URL) => new URLSearchParams(link.hash.slice(1));

export const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

const sqs = new SQSClient({
  endpoint: LOCALSTACK_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

/**
 * Waits until the login queue is empty: nothing waiting and nothing in flight.
 * SQS deletes a message only after the worker returned successfully, so by
 * then every email the queued requests were going to send has been sent, and
 * "no extra email" can be asserted for real instead of after an arbitrary sleep.
 * Several consecutive empty reads are required, as the counts are approximate.
 */
export async function waitForQueueDrained(queueUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let emptyReads = 0;

  while (Date.now() < deadline) {
    const { Attributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    const pending =
      Number(Attributes.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0);
    emptyReads = pending === 0 ? emptyReads + 1 : 0;
    if (emptyReads >= 3) return;

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`The login queue was not drained within ${timeoutMs}ms`);
}
