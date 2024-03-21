import { FeedProviderServer } from "~/lib/data/FeedProviderServer";

export async function AppProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return <FeedProviderServer>{children}</FeedProviderServer>;
}
