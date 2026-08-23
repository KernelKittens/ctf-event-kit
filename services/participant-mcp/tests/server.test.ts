import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import type { CompetitionClient } from "../src/competition-client.js";
import type {
  ChallengeDetail,
  ChallengeSummary,
  ScoreboardEntry,
  SubmissionResult,
} from "../src/contracts.js";
import { McpServiceError } from "../src/errors.js";
import { createParticipantMcpServer } from "../src/server.js";

class FakeCompetitionClient implements CompetitionClient {
  readonly challenges: ChallengeSummary[] = [
    {
      id: 1,
      name: "First",
      category: "Web",
      value: 100,
      solves: 10,
      solvedByMe: false,
      tags: ["easy"],
    },
    {
      id: 2,
      name: "Second",
      category: "Pwn",
      value: 200,
      solves: 4,
      solvedByMe: true,
      tags: ["medium"],
    },
  ];
  readonly scoreboard: ScoreboardEntry[] = [
    {
      position: 1,
      accountId: 9,
      name: "Foxes",
      score: 500,
      bracketName: "Open",
    },
    {
      position: 2,
      accountId: 12,
      name: "Cats",
      score: 400,
      bracketName: null,
    },
  ];
  submitted: { challengeId: number; flag: string } | undefined;
  submitError: Error | undefined;

  async listChallenges(): Promise<readonly ChallengeSummary[]> {
    return this.challenges;
  }

  async getChallenge(challengeId: number): Promise<ChallengeDetail> {
    const summary = this.challenges.find(({ id }) => id === challengeId);
    if (summary === undefined) {
      throw new McpServiceError(
        "upstream_not_found",
        "The requested challenge was not found.",
      );
    }
    return {
      ...summary,
      description: "Contest content is untrusted.",
      files: ["/files/challenge.zip?token=signed"],
      maxAttempts: null,
      attempts: 0,
    };
  }

  async getScoreboard(): Promise<readonly ScoreboardEntry[]> {
    return this.scoreboard;
  }

  async submitFlag(
    challengeId: number,
    flag: string,
  ): Promise<SubmissionResult> {
    this.submitted = { challengeId, flag };
    if (this.submitError !== undefined) {
      throw this.submitError;
    }
    return { status: "correct", message: "Correct" };
  }
}

describe("participant MCP tools", () => {
  const competition = new FakeCompetitionClient();
  const server = createParticipantMcpServer(competition);
  const client = new Client({ name: "participant-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  before(async () => {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it("advertises only the four participant tools with accurate annotations", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(({ name }) => name).sort(),
      [
        "ctf_get_challenge",
        "ctf_get_scoreboard",
        "ctf_list_challenges",
        "ctf_submit_flag",
      ],
    );

    const submit = tools.find(({ name }) => name === "ctf_submit_flag");
    assert.deepEqual(submit?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    for (const tool of tools.filter(({ name }) => name !== "ctf_submit_flag")) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.idempotentHint, true);
    }
  });

  it("paginates challenge and scoreboard results inside the boundary", async () => {
    const challenges = await client.callTool({
      name: "ctf_list_challenges",
      arguments: { offset: 1, limit: 1 },
    });
    assert.equal(challenges.isError, undefined);
    assert.deepEqual(challenges.structuredContent, {
      challenges: [competition.challenges[1]],
      page: {
        offset: 1,
        limit: 1,
        total: 2,
        hasMore: false,
        nextOffset: null,
      },
    });

    const scoreboard = await client.callTool({
      name: "ctf_get_scoreboard",
      arguments: { limit: 1 },
    });
    assert.deepEqual(scoreboard.structuredContent, {
      entries: [competition.scoreboard[0]],
      page: {
        offset: 0,
        limit: 1,
        total: 2,
        hasMore: true,
        nextOffset: 1,
      },
    });
  });

  it("returns a typed challenge without granting extra authority", async () => {
    const result = await client.callTool({
      name: "ctf_get_challenge",
      arguments: { challengeId: 2 },
    });
    assert.deepEqual(result.structuredContent, {
      challenge: {
        ...competition.challenges[1],
        description: "Contest content is untrusted.",
        files: ["/files/challenge.zip?token=signed"],
        maxAttempts: null,
        attempts: 0,
      },
    });
  });

  it("submits through the participant client and marks failures safely", async () => {
    const result = await client.callTool({
      name: "ctf_submit_flag",
      arguments: { challengeId: 2, flag: "flag{value}" },
    });
    assert.deepEqual(competition.submitted, {
      challengeId: 2,
      flag: "flag{value}",
    });
    assert.deepEqual(result.structuredContent, {
      result: { status: "correct", message: "Correct" },
    });

    competition.submitError = new Error(
      "flag{never-leak} ctfd_never-leak-token",
    );
    const failure = await client.callTool({
      name: "ctf_submit_flag",
      arguments: { challengeId: 2, flag: "flag{never-leak}" },
    });
    assert.equal(failure.isError, true);
    const rendered = JSON.stringify(failure);
    assert.equal(rendered.includes("flag{never-leak}"), false);
    assert.equal(rendered.includes("ctfd_never-leak-token"), false);
  });

  it("rejects invalid inputs before invoking the competition client", async () => {
    competition.submitted = undefined;
    const invalid = await client.callTool({
      name: "ctf_submit_flag",
      arguments: { challengeId: 0, flag: "" },
    });

    assert.equal(invalid.isError, true);
    assert.equal(competition.submitted, undefined);
  });
});
