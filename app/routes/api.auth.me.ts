import { jsonOk, optionalAuth, withApiErrorHandling } from "~/server/http";

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const auth = await optionalAuth(request);
    if (!auth) return jsonOk({ user: null });
    return jsonOk({
      user: {
        id: auth.sub,
        email: auth.email,
        role: auth.role,
      },
    });
  })(request);
