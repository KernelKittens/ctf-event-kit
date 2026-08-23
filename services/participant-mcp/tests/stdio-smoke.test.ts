import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

it("serves the compiled participant MCP over stdio", async () => {
  const token = "ctfd_stdio_secret";
  let observedAuthorization = "";
  const upstream = createServer((request, response) => {
    observedAuthorization = request.headers.authorization ?? "";
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/challenges") {
      response.end(
        JSON.stringify({
          success: true,
          data: [
            {
              id: 1,
              name: "Stdio Warmup",
              category: "Web",
              value: 50,
              solves: 2,
              solved_by_me: false,
              tags: [],
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ error: token }));
  });

  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address !== null && typeof address === "object");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/index.js"],
    cwd: process.cwd(),
    env: {
      CTF_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      CTF_API_TOKEN: token,
      CTF_API_ALLOW_INSECURE_LOCALHOST: "true",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);

    const listed = await client.callTool({
      name: "ctf_list_challenges",
      arguments: {},
    });
    assert.deepEqual(listed.structuredContent, {
      challenges: [
        {
          id: 1,
          name: "Stdio Warmup",
          category: "Web",
          value: 50,
          solves: 2,
          solvedByMe: false,
          tags: [],
        },
      ],
      page: {
        offset: 0,
        limit: 25,
        total: 1,
        hasMore: false,
        nextOffset: null,
      },
    });
    assert.equal(observedAuthorization, `Token ${token}`);

    const failure = await client.callTool({
      name: "ctf_get_scoreboard",
      arguments: {},
    });
    assert.equal(failure.isError, true);
    assert.equal(JSON.stringify(failure).includes(token), false);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  assert.equal(stderr.includes(token), false);
});
