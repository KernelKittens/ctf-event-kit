import * as z from "zod/v4";

export const challengeIdSchema = z.number().int().positive();
export const flagSchema = z.string().min(1).max(512);

export const paginationSchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(25),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface ChallengeSummary {
  readonly id: number;
  readonly name: string;
  readonly category: string;
  readonly value: number;
  readonly solves: number | null;
  readonly solvedByMe: boolean;
  readonly tags: readonly string[];
}

export interface ChallengeDetail extends ChallengeSummary {
  readonly description: string;
  readonly files: readonly string[];
  readonly maxAttempts: number | null;
  readonly attempts: number;
}

export interface ScoreboardEntry {
  readonly position: number;
  readonly accountId: number;
  readonly name: string;
  readonly score: number;
  readonly bracketName: string | null;
}

export const submissionStatusSchema = z.enum([
  "correct",
  "incorrect",
  "partial",
  "already_solved",
  "ratelimited",
  "paused",
  "authentication_required",
]);

export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export interface SubmissionResult {
  readonly status: SubmissionStatus;
  readonly message: string;
}
