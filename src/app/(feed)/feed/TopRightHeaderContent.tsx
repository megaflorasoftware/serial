import { ListIcon, PaletteIcon } from "lucide-react";
import Link from "next/link";
import { ColorModeToggle } from "~/components/ColorModeToggle";
import { CustomVideoButton } from "~/components/CustomVideoButton";
import { Button } from "~/components/ui/button";

export function TopRightHeaderContent() {
  return (
    <div className="flex items-center gap-2">
      <Link href="/feed/edit">
        <Button variant="outline" size="icon">
          <ListIcon size={16} />
        </Button>
      </Link>
      <CustomVideoButton />
      <Link href="/feed/colors">
        <Button variant="outline" size="icon">
          <PaletteIcon size={16} />
        </Button>
      </Link>
      <ColorModeToggle />
    </div>
  );
}
