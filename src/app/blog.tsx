import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/blog")({
  component: BlogLayout,
});

function BlogLayout() {
  return (
    <main className="bg-background text-pretty">
      <div className="pt-8 pb-12 md:pt-12 md:pb-24">
        <Outlet />
      </div>
    </main>
  );
}
