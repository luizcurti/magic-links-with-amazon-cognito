import { execSync } from "node:child_process";

export interface StackOutputs {
  apiUrl: string;
  tableName: string;
  userPoolId: string;
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

/** Polls LocalStack's SES capture endpoint for the newest magic link sent to `email`. */
export async function waitForMagicLink(email: string, after: Date, timeoutMs = 10_000): Promise<URL> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const latest = (await sesMessages())
      .filter((m) => m.Destination?.ToAddresses?.includes(email) && sentAt(m) >= after.getTime())
      .sort((a, b) => sentAt(a) - sentAt(b))
      .at(-1);

    const link = latest?.Body?.text_part?.match(/https?:\/\/\S+token=[0-9a-f]{64}/)?.[0];
    if (link) return new URL(link);

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No magic link for ${email} within ${timeoutMs}ms`);
}

export const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
