// TODO
export async function ApplyColorTheme({
  children,
}: {
  children: React.ReactNode;
}) {
  // if (!(await isServerAuthed())) {
  //   return children;
  // }

  // const api = await getServerApi();
  // const data = await api.userConfig.getConfig();

  return (
    <>
      {/*<ApplyColorThemeOnServerMount data={data} />*/}
      {children}
    </>
  );
}
