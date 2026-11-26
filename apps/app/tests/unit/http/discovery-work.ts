import { sendServiceRequest, withDiscoveryPacing } from "~/server/http/pacing";

const PAUSED_HOST = "paused.discovery-work-probe.example";

/**
 * Resolves to whether its caller runs as discovery-side work, which is all
 * that a paused service host refuses.
 */
export async function runsAsDiscoveryWork() {
  // Pauses the host, unless an earlier probe already has.
  await withDiscoveryPacing(() =>
    sendServiceRequest(PAUSED_HOST, () =>
      Promise.resolve(new Response(null, { status: 503 })),
    ),
  ).catch(() => {});
  return sendServiceRequest(PAUSED_HOST, () =>
    Promise.resolve(new Response()),
  ).then(
    () => false,
    () => true,
  );
}
