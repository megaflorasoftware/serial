"use client";

import { UserButton } from "@clerk/nextjs";
import { ArrowLeftIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "~/components/ui/button";
import { useRouterBackHack } from "~/lib/hooks/use-router-back-hack";

export function TopLeftButton() {
  const pathname = usePathname();
  const goBack = useRouterBackHack();

  if (pathname !== "/feed") {
    return (
      <Button size="icon" variant="outline" onClick={goBack}>
        <ArrowLeftIcon size={16} />
      </Button>
    );
  }

  return (
    <div className="h-8 w-8 flex-shrink-0">
      <UserButton afterSignOutUrl="/welcome" />
    </div>
  );
}
