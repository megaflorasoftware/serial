import { getAuth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const auth = getAuth(request);

  if (auth.userId) {
    return redirect("/feed");
  }

  return redirect("/welcome");
}
