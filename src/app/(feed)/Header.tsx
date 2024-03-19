import { DatetimeDisplay } from "~/components/DatetimeDisplay";
import { TopLeftButton } from "./feed/TopLeftButton";
import { TopRightHeaderContent } from "./feed/TopRightHeaderContent";

export function Header() {
  return (
    <header className="sticky top-0 z-20 flex h-20 w-full items-center justify-between border-b bg-background px-6">
      <TopLeftButton />
      <h1 className="hidden flex-1 px-2 font-mono text-sm sm:block">
        <DatetimeDisplay />
      </h1>
      <TopRightHeaderContent />
    </header>
  );
}
