# KernelKittens CTF Participant MCP

Participant-only MCP access for CTFd events. It wraps four CTFd participant routes and does not connect directly to the CTFd database.

## Tools

- `ctf_list_challenges`: list challenges visible to the participant token
- `ctf_get_challenge`: get one visible challenge and its signed file links
- `ctf_get_scoreboard`: read the public scoreboard
- `ctf_submit_flag`: submit one flag through CTFd's normal participant path

Flag submission is marked non-idempotent. A blind retry can consume an attempt or hit CTFd's rate limit.

## Security boundary

The MCP client cannot choose the upstream host or supply a credential in a tool call. Both come from the process environment. Remote upstreams require HTTPS. HTTP is available only for localhost testing with an explicit switch.

The adapter strips CTFd templates, scripts, rendered views, OAuth IDs, and team-member details. It caps upstream responses at 1 MiB, sets a 10 second request deadline, validates JSON, and converts internal failures into safe tool errors. Flags and access tokens are never written to logs or error responses.

Challenge descriptions and downloaded files are untrusted contest content. MCP hosts should keep their normal prompt-injection and file-execution protections enabled.

## Run

Requires Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npm run build
CTF_API_BASE_URL=https://ctf.example.com \
CTF_API_TOKEN=ctfd_replace_with_participant_token \
node dist/src/index.js
```

The process speaks MCP on stdin and stdout. Do not print application logs to stdout.

## MCP host configuration

Use the compiled entry point as a stdio server and provide the two required environment variables through the host's secret configuration.

```json
{
  "command": "node",
  "args": ["/absolute/path/to/services/participant-mcp/dist/src/index.js"],
  "env": {
    "CTF_API_BASE_URL": "https://ctf.example.com",
    "CTF_API_TOKEN": "ctfd_replace_with_participant_token"
  }
}
```

Do not commit the real participant token. Each bot or participant should receive the narrowest token supported by the event.

## Verify

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

`npm test` compiles the service, runs the unit suite, and launches the compiled process through the official MCP client for a stdio smoke test.

## Scope

This service exposes participant actions only. Staff, administrative, and event-management operations are outside its scope.
