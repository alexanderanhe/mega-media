import { getCollections, ObjectId } from "~/server/db";
import { jsonOk, optionalAuth, parseJson, withApiErrorHandling } from "~/server/http";
import { batchUrlsSchema } from "~/server/schemas";
import { createSignedGetUrl, toPublicUrl } from "~/server/r2";

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const auth = await optionalAuth(request);
    const body = await parseJson(request, batchUrlsSchema);
    const ids = body.requests.map((r) => new ObjectId(r.id));

    const { media } = await getCollections();
    const docs = await media.find({ _id: { $in: ids }, status: "ready" }).toArray();

    const byId = new Map(docs.map((doc) => [doc._id.toString(), doc]));
    const results: Array<{ id: string; lod: number; url: string | null }> = [];

    for (const req of body.requests) {
      const doc = byId.get(req.id);
      if (!doc) {
        results.push({ id: req.id, lod: req.lod, url: null });
        continue;
      }
      if (doc.visibility === "PRIVATE" && !auth) {
        results.push({ id: req.id, lod: req.lod, url: null });
        continue;
      }

      const variant = doc.variants[`lod${req.lod}`];
      if (!variant) {
        results.push({ id: req.id, lod: req.lod, url: null });
        continue;
      }

      const url = toPublicUrl(variant.r2Key) ?? (await createSignedGetUrl(variant.r2Key, 120));
      results.push({ id: req.id, lod: req.lod, url });
    }

    return jsonOk({ items: results });
  })(request);
