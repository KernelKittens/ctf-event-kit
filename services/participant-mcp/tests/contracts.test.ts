import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  challengeIdSchema,
  flagSchema,
  paginationSchema,
} from "../src/contracts.js";

describe("public input contracts", () => {
  it("accepts positive integer challenge IDs only", () => {
    assert.equal(challengeIdSchema.parse(1), 1);
    for (const value of [0, -1, 1.5, "1"]) {
      assert.equal(challengeIdSchema.safeParse(value).success, false);
    }
  });

  it("bounds flags without trimming meaningful characters", () => {
    assert.equal(flagSchema.parse(" flag{value} "), " flag{value} ");
    assert.equal(flagSchema.safeParse("").success, false);
    assert.equal(flagSchema.safeParse("x".repeat(513)).success, false);
  });

  it("sets safe pagination defaults and limits", () => {
    assert.deepEqual(paginationSchema.parse({}), { offset: 0, limit: 25 });
    assert.deepEqual(paginationSchema.parse({ offset: 10, limit: 50 }), {
      offset: 10,
      limit: 50,
    });
    assert.equal(paginationSchema.safeParse({ offset: -1 }).success, false);
    assert.equal(paginationSchema.safeParse({ limit: 51 }).success, false);
  });
});
