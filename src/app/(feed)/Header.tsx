import { TopLeftButton } from "./feed/TopLeftButton";
import { TopRightHeaderContent } from "./feed/TopRightHeaderContent";

export function Header() {
  return (
    <header className="fixed top-0 z-20 flex h-20 w-full items-center justify-between px-6">
      <TopLeftButton />
      <TopRightHeaderContent />
    </header>
  );
}
