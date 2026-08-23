export interface ParticipantMcpConfig {
  readonly baseUrl: URL;
  readonly token: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseBaseUrl(value: string, allowInsecureLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CTF_API_BASE_URL must be a valid URL");
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("CTF_API_BASE_URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("CTF_API_BASE_URL must be an origin without a path, query, or fragment");
  }

  const isLocalhost = LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol === "http:") {
    if (!isLocalhost || !allowInsecureLocalhost) {
      throw new Error(
        isLocalhost
          ? "HTTP localhost requires CTF_API_ALLOW_INSECURE_LOCALHOST=true"
          : "CTF_API_BASE_URL must use HTTPS",
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error("CTF_API_BASE_URL must use HTTPS");
  }

  return url;
}

export function loadConfig(env: Environment = process.env): ParticipantMcpConfig {
  const baseUrlValue = required(env, "CTF_API_BASE_URL");
  const token = required(env, "CTF_API_TOKEN");
  const allowInsecureLocalhost =
    env.CTF_API_ALLOW_INSECURE_LOCALHOST === "true";

  return {
    baseUrl: parseBaseUrl(baseUrlValue, allowInsecureLocalhost),
    token,
    timeoutMs: 10_000,
    maxResponseBytes: 1_048_576,
  };
}
