import {
  sentryGlobalFunctionMiddleware,
  sentryGlobalRequestMiddleware,
} from "@sentry/tanstackstart-react";
import { createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => {
  const dsn = process.env.SENTRY_DSN_BACKEND;

  return {
    requestMiddleware: dsn ? [sentryGlobalRequestMiddleware] : [],
    functionMiddleware: dsn ? [sentryGlobalFunctionMiddleware] : [],
  };
});
