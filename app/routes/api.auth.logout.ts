import { buildClearAccessCookie } from "~/server/auth";
import { jsonOk, withApiErrorHandling } from "~/server/http";

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", buildClearAccessCookie());
    return jsonOk({ ok: true }, { headers });
  })(request);
