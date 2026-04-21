import * as Sentry from "@sentry/node";
import { env } from "../../src/env";

const SAMPLE_RATES = {
  development: { traces: 1.0 },
  production: { traces: 0.2 },
} as const;

let initialized = false;

export default () => {
  if (initialized || !env.SENTRY_DSN_BACKEND) {
    return;
  }

  initialized = true;

  const isDev = env.NODE_ENV === "development";
  const rates = isDev ? SAMPLE_RATES.development : SAMPLE_RATES.production;

  Sentry.init({
    dsn: env.SENTRY_DSN_BACKEND,
    environment: isDev ? "development" : "production",
    tracesSampleRate: rates.traces,
  });
};
