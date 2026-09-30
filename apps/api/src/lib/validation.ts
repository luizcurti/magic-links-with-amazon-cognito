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

/** Cognito refresh tokens are encrypted JWTs of roughly 1.7 KB. */
export const logoutRequestSchema = z.object({
  refreshToken: z
    .string({ error: "refreshToken is required" })
    .min(1, { error: "refreshToken is required" })
    .max(8192, { error: "refreshToken is too long" }),
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
