import * as Sentry from "@sentry/browser";
import { env } from "~/env";

const SAMPLE_RATES = {
  development: {
    traces: 1.0,
    replaysSession: 0,
    replaysOnError: 1.0,
  },
  production: {
    traces: 0.2,
    replaysSession: 0.1,
    replaysOnError: 1.0,
  },
} as const;

let initialized = false;

export function initializeSentry() {
  if (initialized || !env.VITE_PUBLIC_SENTRY_DSN_WEB) {
    return;
  }

  initialized = true;

  const isDev = import.meta.env.DEV;
  const rates = isDev ? SAMPLE_RATES.development : SAMPLE_RATES.production;

  Sentry.init({
    dsn: env.VITE_PUBLIC_SENTRY_DSN_WEB,
    environment: isDev ? "development" : "production",
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    tracesSampleRate: rates.traces,
    replaysSessionSampleRate: rates.replaysSession,
    replaysOnErrorSampleRate: rates.replaysOnError,
  });
}
