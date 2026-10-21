// Prints the emails captured by LocalStack SES, newest last.
//   node scripts/emails.mjs            -> all emails
//   node scripts/emails.mjs --link     -> only the latest magic link
//   node scripts/emails.mjs --to a@b.c -> filter by recipient
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    link: { type: "boolean", default: false },
    to: { type: "string" },
    endpoint: { type: "string", default: process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566" },
  },
});

const response = await fetch(`${values.endpoint}/_aws/ses`);
if (!response.ok) {
  console.error(`LocalStack SES endpoint returned ${response.status}. Is LocalStack running?`);
  process.exit(1);
}

const { messages = [] } = await response.json();
const emails = messages
  .filter((m) => !values.to || m.Destination?.ToAddresses?.includes(values.to.toLowerCase()))
  .sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp));

if (values.link) {
  const text = emails.at(-1)?.Body?.text_part ?? "";
  const link = text.match(/https?:\/\/\S+token=[0-9a-f]{64}/)?.[0];
  if (!link) {
    console.error("No magic link found. Request one with: make login EMAIL=you@example.com");
    process.exit(1);
  }
  console.log(link);
} else if (emails.length === 0) {
  console.log("No emails captured yet.");
} else {
  for (const email of emails) {
    console.log("─".repeat(72));
    console.log(`Date:    ${email.Timestamp}`);
    console.log(`From:    ${email.Source}`);
    console.log(`To:      ${email.Destination?.ToAddresses?.join(", ")}`);
    console.log(`Subject: ${email.Subject}`);
    console.log("");
    console.log(email.Body?.text_part ?? "(no text body)");
  }
}
