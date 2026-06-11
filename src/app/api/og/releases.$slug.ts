import { createFileRoute } from "@tanstack/react-router";
import { getReleaseOgResponse } from "~/server/og/releaseResponse";

export const Route = createFileRoute("/api/og/releases/$slug")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        getReleaseOgResponse(params.slug, new URL(request.url).origin),
    },
  },
});
