import * as z from "zod/v4";

import type { ParticipantMcpConfig } from "./config.js";
import type { CompetitionClient } from "./competition-client.js";
import {
  type ChallengeDetail,
  type ChallengeSummary,
  type ScoreboardEntry,
  type SubmissionResult,
  submissionStatusSchema,
} from "./contracts.js";
import { McpServiceError } from "./errors.js";

const tagSchema = z.union([
  z.string(),
  z.object({ value: z.string() }).passthrough(),
]);

const challengeSummarySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    category: z.string(),
    value: z.number(),
    solves: z.number().int().nonnegative().nullable(),
    solved_by_me: z.boolean(),
    tags: z.array(tagSchema).default([]),
  })
  .passthrough();

const challengeDetailSchema = challengeSummarySchema.extend({
  description: z.string().default(""),
  files: z.array(z.string()).default([]),
  max_attempts: z.number().int().nonnegative().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
});

const scoreboardEntrySchema = z
  .object({
    pos: z.number().int().positive(),
    account_id: z.number().int().positive(),
    name: z.string(),
    score: z.number(),
    bracket_name: z.string().nullable().optional(),
  })
  .passthrough();

const attemptSchema = z
  .object({
    status: submissionStatusSchema,
    message: z.string(),
  })
  .passthrough();

function envelope<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
  });
}

function normalizeTags(tags: readonly z.infer<typeof tagSchema>[]): string[] {
  return tags.map((tag) => (typeof tag === "string" ? tag : tag.value));
}

function mapSummary(
  challenge: z.infer<typeof challengeSummarySchema>,
): ChallengeSummary {
  return {
    id: challenge.id,
    name: challenge.name,
    category: challenge.category,
    value: challenge.value,
    solves: challenge.solves,
    solvedByMe: challenge.solved_by_me,
    tags: normalizeTags(challenge.tags),
  };
}

function errorForStatus(status: number): McpServiceError {
  if (status === 401 || status === 403) {
    return new McpServiceError(
      "upstream_rejected_request",
      "The CTF service rejected the participant request.",
    );
  }
  if (status === 404) {
    return new McpServiceError(
      "upstream_not_found",
      "The requested challenge was not found.",
    );
  }
  if (status === 429) {
    return new McpServiceError(
      "upstream_rate_limited",
      "The CTF service is rate limiting requests.",
      true,
    );
  }
  return new McpServiceError(
    "upstream_rejected_request",
    "The CTF service returned an error.",
    status >= 500,
  );
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new McpServiceError(
      "upstream_response_too_large",
      "The CTF service returned too much data.",
    );
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new McpServiceError(
        "upstream_response_too_large",
        "The CTF service returned too much data.",
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export class CtfdClient implements CompetitionClient {
  readonly #config: ParticipantMcpConfig;
  readonly #fetch: typeof fetch;

  constructor(
    config: ParticipantMcpConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async listChallenges(): Promise<readonly ChallengeSummary[]> {
    const data = await this.#request(
      "api/v1/challenges",
      {},
      envelope(z.array(challengeSummarySchema)),
    );
    return data.data.map(mapSummary);
  }

  async getChallenge(challengeId: number): Promise<ChallengeDetail> {
    const data = await this.#request(
      `api/v1/challenges/${challengeId}`,
      {},
      envelope(challengeDetailSchema),
    );
    const challenge = data.data;
    return {
      ...mapSummary(challenge),
      description: challenge.description,
      files: challenge.files,
      maxAttempts: challenge.max_attempts === 0 ? null : challenge.max_attempts,
      attempts: challenge.attempts,
    };
  }

  async getScoreboard(): Promise<readonly ScoreboardEntry[]> {
    const data = await this.#request(
      "api/v1/scoreboard",
      {},
      envelope(z.array(scoreboardEntrySchema)),
    );
    return data.data.map((entry) => ({
      position: entry.pos,
      accountId: entry.account_id,
      name: entry.name,
      score: entry.score,
      bracketName: entry.bracket_name ?? null,
    }));
  }

  async submitFlag(
    challengeId: number,
    flag: string,
  ): Promise<SubmissionResult> {
    const data = await this.#request(
      "api/v1/challenges/attempt",
      {
        method: "POST",
        body: JSON.stringify({
          challenge_id: challengeId,
          submission: flag,
        }),
      },
      envelope(attemptSchema),
      true,
    );
    return data.data;
  }

  async #request<T extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: T,
    acceptStructuredErrorStatus = false,
  ): Promise<z.output<T>> {
    const url = new URL(path, this.#config.baseUrl);
    let response: Response;
    let body: string;
    try {
      response = await this.#fetch(url, {
        ...init,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Token ${this.#config.token}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        signal: AbortSignal.timeout(this.#config.timeoutMs),
      });
      body = await readBoundedBody(response, this.#config.maxResponseBytes);
    } catch (error) {
      if (error instanceof McpServiceError) {
        throw error;
      }
      const name =
        typeof error === "object" && error !== null && "name" in error
          ? String(error.name)
          : "";
      if (name === "AbortError" || name === "TimeoutError") {
        throw new McpServiceError(
          "upstream_timeout",
          "The CTF service timed out.",
          true,
        );
      }
      throw new McpServiceError(
        "upstream_unavailable",
        "The CTF service is unavailable.",
        true,
      );
    }

    if (!response.ok && !acceptStructuredErrorStatus) {
      throw errorForStatus(response.status);
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new McpServiceError(
        "invalid_upstream_response",
        "The CTF service returned an invalid response.",
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      if (!response.ok) {
        throw errorForStatus(response.status);
      }
      throw new McpServiceError(
        "invalid_upstream_response",
        "The CTF service returned an invalid response.",
      );
    }
    return parsed.data;
  }
}
