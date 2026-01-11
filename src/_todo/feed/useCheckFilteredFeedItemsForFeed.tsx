import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/feed/useCheckFilteredFeedItemsForFeed")({
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/(feed)/feed/useCheckFilteredFeedItemsForFeed"!</div>;
}
