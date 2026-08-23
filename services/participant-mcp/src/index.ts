import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { CtfdClient } from "./ctfd-client.js";
import { createParticipantMcpServer } from "./server.js";

try {
  const competition = new CtfdClient(loadConfig());
  serveStdio(() => createParticipantMcpServer(competition), {
    onerror: () => {
      process.stderr.write("Participant MCP transport error.\n");
    },
  });
} catch {
  process.stderr.write("Participant MCP failed to start.\n");
  process.exitCode = 1;
}
