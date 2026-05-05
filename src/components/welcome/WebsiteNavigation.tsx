import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button";

export function WebsiteNavigation(props: { isAuthed: boolean }) {
  return (
    <header className="border-muted mx-auto max-w-4xl px-4 pt-4 lg:px-0 lg:pt-8">
      <nav className="flex items-center justify-between gap-1">
        <div>
          <Link
            to="/welcome"
            className="hover:bg-muted flex items-center justify-center gap-2 rounded px-2 py-1 text-xl font-bold transition-all"
          >
            <img
              src="/favicon-32x32.png"
              className="mx-auto size-5 rounded"
              alt="Serial logo"
            />
            Serial
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <Link
            to="/pricing"
            className="text-md text-muted-foreground hover:bg-muted block rounded px-2 py-1 font-semibold transition-all"
          >
            Pricing
          </Link>
          <Link
            to="/releases"
            className="text-md text-muted-foreground hover:bg-muted block rounded px-2 py-1 font-semibold transition-all"
          >
            Releases
          </Link>
          <Link
            to="/guides"
            className="text-md text-muted-foreground hover:bg-muted block rounded px-2 py-1 font-semibold transition-all"
          >
            Guides
          </Link>
        </div>
        <div>
          {true && (
            <Link to="/">
              <Button>Back to app</Button>
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
