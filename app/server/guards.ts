import { redirect } from "react-router";
import { optionalAuth } from "./http";

export async function requireAdminPage(request: Request) {
  const auth = await optionalAuth(request);
  if (!auth) throw redirect("/login");
  if (auth.role !== "ADMIN") throw redirect("/");
  return auth;
}
