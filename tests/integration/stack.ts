import { execSync } from "node:child_process";

export interface StackOutputs {
  apiUrl: string;
  tableName: string;
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
    return { apiUrl: outputs.api_url.value, tableName: outputs.magic_links_table!.value };
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

export async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

interface SesMessage {
  Destination?: { ToAddresses?: string[] };
  Body?: { text_part?: string };
  Timestamp: string;
}

/** Polls LocalStack's SES capture endpoint for the newest magic link sent to `email`. */
export async function waitForMagicLink(email: string, after: Date, timeoutMs = 10_000): Promise<URL> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${LOCALSTACK_ENDPOINT}/_aws/ses`);
    const { messages = [] } = (await response.json()) as { messages?: SesMessage[] };

    const latest = messages
      .filter((m) => m.Destination?.ToAddresses?.includes(email) && new Date(m.Timestamp) >= after)
      .sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp))
      .at(-1);

    const link = latest?.Body?.text_part?.match(/https?:\/\/\S+token=[0-9a-f]{64}/)?.[0];
    if (link) return new URL(link);

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No magic link for ${email} within ${timeoutMs}ms`);
}

export const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
