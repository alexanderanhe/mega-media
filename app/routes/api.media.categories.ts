import { z } from "zod";
import { getCollections } from "~/server/db";
import { jsonOk, optionalAuth, parseQuery, withApiErrorHandling } from "~/server/http";

const querySchema = z.object({
  q: z.string().max(64).optional(),
});

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const query = await parseQuery(request, querySchema);
    const auth = await optionalAuth(request);
    const filter: Record<string, unknown> = {};
    if (!auth) filter.visibility = "PUBLIC";
    if (query.q) {
      filter.category = { $regex: escapeRegex(query.q), $options: "i" };
    }

    const { media } = await getCollections();
    const raw = await media.distinct("category", filter);
    const normalized = raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);

    const list = query.q
      ? normalized.filter((item) => item.toLowerCase().includes(query.q!.toLowerCase()))
      : normalized;

    list.sort((a, b) => a.localeCompare(b));

    return jsonOk({ items: list.slice(0, 200) });
  })(request);

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
