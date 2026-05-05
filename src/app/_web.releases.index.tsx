import { createFileRoute, Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import { ContainerIcon } from "lucide-react";
import { WebsiteHeader } from "~/components/welcome/WebsiteHeader";
import { getAllReleases } from "~/lib/markdown/loaders";
import { fetchIsAuthed } from "~/server/auth/endpoints";

export const Route = createFileRoute("/_web/releases/")({
  component: RouteComponent,
  loader: async () => {
    const isAuthed = await fetchIsAuthed();

    return {
      isAuthed,
      releases: getAllReleases(),
    };
  },
});

function RouteComponent() {
  const { releases } = Route.useLoaderData();

  return (
    <div>
      <WebsiteHeader Icon={ContainerIcon} title="Releases" />
      <div className="mx-auto max-w-3xl px-6">
        <ul className="mt-8 list-none space-y-8 p-0">
          {!releases.length && (
            <p className="text-xl">Nothing to see here. Check back soon!</p>
          )}
          {releases.map(({ slug, title, description, publish_date }) => {
            return (
              <li key={slug}>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between">
                  <Link
                    // @ts-expect-error this is fine
                    to={`/releases/${slug}`}
                    className="text-xl font-bold underline"
                    preload="intent"
                  >
                    {title}
                  </Link>
                  <p className="text-muted-foreground text-lg font-semibold">
                    {dayjs(publish_date).format("MMMM DD, YYYY")}
                  </p>
                </div>
                {description && <p className="mt-2 text-lg">{description}</p>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
