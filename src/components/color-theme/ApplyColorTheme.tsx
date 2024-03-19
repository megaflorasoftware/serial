import { api } from "~/trpc/server";
import { ApplyColorThemeOnMount } from "./ApplyColorThemeOnMount";

export async function ApplyColorTheme({
  children,
}: {
  children: React.ReactNode;
}) {
  const data = await api.userConfig.getConfig.query();

  return (
    <>
      <ApplyColorThemeOnMount data={data} />
      {children}
    </>
  );
}
