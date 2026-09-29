import { z } from "zod";
import { TOKEN_PATTERN } from "../services/token.service.js";
import { BadRequestError } from "./http.js";

/** Emails are normalized so `Luiz@Example.com ` and `luiz@example.com` map to the same user and record. */
export const emailSchema = z
  .string({ error: "email is required" })
  .trim()
  .toLowerCase()
  .max(254, { error: "email is too long" })
  .pipe(z.email({ error: "email must be a valid email address" }));

export const loginRequestSchema = z.object({
  email: emailSchema,
});

export const verifyRequestSchema = z.object({
  email: emailSchema,
  token: z.string({ error: "token is required" }).regex(TOKEN_PATTERN, { error: "token has an invalid format" }),
});

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestError(
      "Invalid request",
      result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}
