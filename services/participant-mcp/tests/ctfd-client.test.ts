import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ParticipantMcpConfig } from "../src/config.js";
import { CtfdClient } from "../src/ctfd-client.js";
import { McpServiceError } from "../src/errors.js";

const config: ParticipantMcpConfig = {
  baseUrl: new URL("https://ctf.example.test/"),
  token: "ctfd_secret_token",
  timeoutMs: 1_000,
  maxResponseBytes: 1_024,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CtfdClient", () => {
  it("lists visible challenges and strips CTFd rendering internals", async () => {
    let requestedUrl = "";
    let authorization = "";
    let redirect: RequestRedirect | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      redirect = init?.redirect;
      return jsonResponse({
        success: true,
        data: [
          {
            id: 7,
            type: "standard",
            name: "Warmup",
            value: 100,
            solves: 3,
            solved_by_me: false,
            category: "Web",
            tags: [{ value: "easy" }],
            template: "private template",
            script: "private script",
          },
        ],
      });
    };

    const client = new CtfdClient(config, fetchImpl);
    const challenges = await client.listChallenges();

    assert.equal(requestedUrl, "https://ctf.example.test/api/v1/challenges");
    assert.equal(authorization, "Token ctfd_secret_token");
    assert.equal(redirect, "error");
    assert.deepEqual(challenges, [
      {
        id: 7,
        name: "Warmup",
        category: "Web",
        value: 100,
        solves: 3,
        solvedByMe: false,
        tags: ["easy"],
      },
    ]);
    assert.equal("template" in challenges[0]!, false);
    assert.equal("script" in challenges[0]!, false);
  });

  it("gets a challenge through the participant route", async () => {
    let requestedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        success: true,
        data: {
          id: 7,
          name: "Warmup",
          category: "Web",
          value: 100,
          description: "Find the flag.",
          solves: null,
          solved_by_me: true,
          tags: ["easy"],
          files: ["/files/warmup.zip?token=signed"],
          max_attempts: 0,
          attempts: 1,
          template: "private template",
          script: "private script",
          view: "private rendered view",
        },
      });
    };

    const challenge = await new CtfdClient(config, fetchImpl).getChallenge(7);

    assert.equal(requestedUrl, "https://ctf.example.test/api/v1/challenges/7");
    assert.deepEqual(challenge, {
      id: 7,
      name: "Warmup",
      category: "Web",
      value: 100,
      description: "Find the flag.",
      solves: null,
      solvedByMe: true,
      tags: ["easy"],
      files: ["/files/warmup.zip?token=signed"],
      maxAttempts: null,
      attempts: 1,
    });
  });

  it("maps the public scoreboard without member or OAuth details", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        success: true,
        data: [
          {
            pos: 1,
            account_id: 9,
            account_url: "/teams/9",
            account_type: "team",
            oauth_id: "private",
            name: "Foxes",
            score: 500,
            bracket_id: 2,
            bracket_name: "Open",
            members: [{ id: 42, name: "hidden from MCP" }],
          },
        ],
      });

    const scoreboard = await new CtfdClient(config, fetchImpl).getScoreboard();

    assert.deepEqual(scoreboard, [
      {
        position: 1,
        accountId: 9,
        name: "Foxes",
        score: 500,
        bracketName: "Open",
      },
    ]);
  });

  it("submits flags and preserves meaningful non-200 attempt results", async () => {
    let requestBody = "";
    let requestMethod = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body);
      requestMethod = init?.method ?? "";
      return jsonResponse(
        {
          success: true,
          data: {
            status: "ratelimited",
            message: "Try again in 12 seconds.",
          },
        },
        429,
      );
    };

    const result = await new CtfdClient(config, fetchImpl).submitFlag(
      7,
      "flag{secret}",
    );

    assert.equal(requestMethod, "POST");
    assert.deepEqual(JSON.parse(requestBody), {
      challenge_id: 7,
      submission: "flag{secret}",
    });
    assert.deepEqual(result, {
      status: "ratelimited",
      message: "Try again in 12 seconds.",
    });
  });

  it("rejects oversized and malformed upstream responses", async () => {
    const oversized: typeof fetch = async () =>
      new Response("x".repeat(1_025), {
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      () => new CtfdClient(config, oversized).listChallenges(),
      (error: unknown) =>
        error instanceof McpServiceError &&
        error.code === "upstream_response_too_large",
    );

    const malformed: typeof fetch = async () =>
      jsonResponse({ success: true, data: [{ id: "not-a-number" }] });
    await assert.rejects(
      () => new CtfdClient(config, malformed).listChallenges(),
      (error: unknown) =>
        error instanceof McpServiceError &&
        error.code === "invalid_upstream_response",
    );
  });

  it("never exposes tokens or submitted flags in adapter failures", async () => {
    const flag = "flag{do-not-leak}";
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`${config.token} ${flag}`);
    };

    await assert.rejects(
      () => new CtfdClient(config, fetchImpl).submitFlag(7, flag),
      (error: unknown) => {
        assert.ok(error instanceof McpServiceError);
        assert.equal(error.code, "upstream_unavailable");
        assert.equal(error.message.includes(config.token), false);
        assert.equal(error.message.includes(flag), false);
        return true;
      },
    );
  });
});
