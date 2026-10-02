import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

function submit(email: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.submit(screen.getByRole("button", { name: "Send magic link" }));
}

describe("LoginPage", () => {
  it("requests a link and tells the user to check their inbox", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ message: "ok" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage />);

    submit("luiz@example.com");

    expect(screen.getByRole("button", { name: "Sending…" })).toHaveProperty("disabled", true);
    expect(await screen.findByText("Check your inbox")).toBeTruthy();
    expect(screen.getByText("luiz@example.com")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/login",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "luiz@example.com" }) }),
    );
  });

  it("shows the API error and lets the user retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "Invalid request" }, { status: 400 })));
    render(<LoginPage />);

    submit("luiz@example.com");

    expect(await screen.findByText("Invalid request")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send magic link" })).toHaveProperty("disabled", false);
  });

  it("goes back to the form to use a different email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 202 })));
    render(<LoginPage />);
    submit("luiz@example.com");

    fireEvent.click(await screen.findByRole("button", { name: "Use a different email" }));

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  });
});
