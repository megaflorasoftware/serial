import { usePathname, useRouter } from "next/navigation";

/**
 * I have no idea if this does anything but here we are
 */
export function useRouterBackHack() {
  const router = useRouter();
  const pathname = usePathname();

  const goBack = () => {
    const previousPathname = pathname;
    router.back();

    setTimeout(() => {
      if (window.location.pathname === previousPathname) {
        goBack();
      }
    }, 0);
  };

  return goBack;
}
