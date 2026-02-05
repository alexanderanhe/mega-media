const required = [
  "MONGODB_URI",
  "JWT_SECRET",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

type RequiredKey = (typeof required)[number];

let cachedEnv: Record<string, string | undefined> | null = null;

export function getEnv() {
  if (cachedEnv) return cachedEnv;
  const env = process.env;
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  cachedEnv = {
    ...env,
    JWT_EXPIRES_IN: env.JWT_EXPIRES_IN ?? "15m",
    R2_REGION: env.R2_REGION ?? "auto",
    NODE_ENV: env.NODE_ENV ?? "development",
  };
  return cachedEnv;
}

export function requireEnvValue(key: RequiredKey): string {
  const env = getEnv();
  const value = env[key];
  if (!value) throw new Error(`Missing env ${key}`);
  return value;
}
