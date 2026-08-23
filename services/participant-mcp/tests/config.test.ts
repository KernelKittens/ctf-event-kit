import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const token = "ctfd_test_token";

  it("requires a base URL and participant token", () => {
    assert.throws(() => loadConfig({}), /CTF_API_BASE_URL/);
    assert.throws(
      () => loadConfig({ CTF_API_BASE_URL: "https://ctf.example.test" }),
      /CTF_API_TOKEN/,
    );
  });

  it("normalizes a secure base URL", () => {
    const config = loadConfig({
      CTF_API_BASE_URL: "https://ctf.example.test/",
      CTF_API_TOKEN: token,
    });

    assert.equal(config.baseUrl.href, "https://ctf.example.test/");
    assert.equal(config.token, token);
    assert.equal(config.timeoutMs, 10_000);
    assert.equal(config.maxResponseBytes, 1_048_576);
  });

  it("rejects insecure remote upstreams", () => {
    assert.throws(
      () =>
        loadConfig({
          CTF_API_BASE_URL: "http://ctf.example.test",
          CTF_API_TOKEN: token,
          CTF_API_ALLOW_INSECURE_LOCALHOST: "true",
        }),
      /HTTPS/,
    );
  });

  it("requires an explicit switch for insecure localhost", () => {
    const env = {
      CTF_API_BASE_URL: "http://127.0.0.1:8000",
      CTF_API_TOKEN: token,
    };

    assert.throws(() => loadConfig(env), /localhost/);
    const config = loadConfig({
      ...env,
      CTF_API_ALLOW_INSECURE_LOCALHOST: "true",
    });
    assert.equal(config.baseUrl.href, "http://127.0.0.1:8000/");
  });

  it("rejects credentials and paths in the base URL", () => {
    assert.throws(
      () =>
        loadConfig({
          CTF_API_BASE_URL: "https://user:pass@ctf.example.test",
          CTF_API_TOKEN: token,
        }),
      /credentials/,
    );
    assert.throws(
      () =>
        loadConfig({
          CTF_API_BASE_URL: "https://ctf.example.test/prefix",
          CTF_API_TOKEN: token,
        }),
      /origin/,
    );
  });
});
