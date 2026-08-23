import type {
  ChallengeDetail,
  ChallengeSummary,
  ScoreboardEntry,
  SubmissionResult,
} from "./contracts.js";

export interface CompetitionClient {
  listChallenges(): Promise<readonly ChallengeSummary[]>;
  getChallenge(challengeId: number): Promise<ChallengeDetail>;
  getScoreboard(): Promise<readonly ScoreboardEntry[]>;
  submitFlag(challengeId: number, flag: string): Promise<SubmissionResult>;
}
