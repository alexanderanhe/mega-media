import { jsonOk, withApiErrorHandling } from "~/server/http";

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const enabled = (process.env.ENABLE_SELF_SIGNUP ?? "").toLowerCase() === "true";
    return jsonOk({ enableSelfSignup: enabled });
  })(request);
