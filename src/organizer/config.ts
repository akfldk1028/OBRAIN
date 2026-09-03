const officialBaseUrls = new Set([
  "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
]);

type OrganizerEnvironment =
  | { provider: "disabled" }
  | { provider: "dashscope"; apiKey: string; baseUrl: string; model: string };

type Environment = Readonly<Record<string, string | undefined>>;

function requiredEnvironmentValue(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set when ORGANIZER_PROVIDER=dashscope`);
  return value;
}

export function loadOrganizerEnvironment(env: Environment): OrganizerEnvironment {
  const provider = env.ORGANIZER_PROVIDER?.trim() || "disabled";
  if (provider === "disabled") return { provider };
  if (provider !== "dashscope") {
    throw new Error('ORGANIZER_PROVIDER must be "disabled" or "dashscope"');
  }

  const apiKey = requiredEnvironmentValue(env, "DASHSCOPE_API_KEY");
  const baseUrl = requiredEnvironmentValue(env, "DASHSCOPE_BASE_URL");
  if (!officialBaseUrls.has(baseUrl)) {
    throw new Error("DASHSCOPE_BASE_URL must be an official DashScope HTTPS URL");
  }
  const model = requiredEnvironmentValue(env, "DASHSCOPE_MODEL");

  const result = { provider, baseUrl, model } as OrganizerEnvironment & { provider: "dashscope" };
  Object.defineProperty(result, "apiKey", { value: apiKey });
  return result;
}
