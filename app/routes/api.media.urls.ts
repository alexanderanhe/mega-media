import { getCollections, ObjectId } from "~/server/db";
import { jsonOk, optionalAuth, parseJson, withApiErrorHandling } from "~/server/http";
import { batchUrlsSchema } from "~/server/schemas";
import { createSignedGetUrl, toPublicUrl } from "~/server/r2";

const SIGNED_URL_TTL_SECONDS = clampNumber(Number(process.env.SIGNED_URL_TTL_SECONDS ?? 21600), 600, 604800);
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const auth = await optionalAuth(request);
    const body = await parseJson(request, batchUrlsSchema);
    const ids = body.requests.map((r) => new ObjectId(r.id));

    const { media } = await getCollections();
    const docs = await media.find({ _id: { $in: ids }, status: "ready" }).toArray();

    const byId = new Map(docs.map((doc) => [doc._id.toString(), doc]));
    const results: Array<{ id: string; lod: number; url: string | null; expiresAt?: number | null }> = [];

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

      const publicUrl = toPublicUrl(variant.r2Key);
      if (publicUrl) {
        results.push({ id: req.id, lod: req.lod, url: publicUrl, expiresAt: null });
        continue;
      }

      const cached = signedUrlCache.get(variant.r2Key);
      const now = Date.now();
      if (cached && cached.expiresAt - now > 60_000) {
        results.push({ id: req.id, lod: req.lod, url: cached.url, expiresAt: cached.expiresAt });
        continue;
      }

      const url = await createSignedGetUrl(variant.r2Key, SIGNED_URL_TTL_SECONDS);
      const expiresAt = now + SIGNED_URL_TTL_SECONDS * 1000;
      signedUrlCache.set(variant.r2Key, { url, expiresAt });
      results.push({ id: req.id, lod: req.lod, url, expiresAt });
    }

    return jsonOk({ items: results });
  })(request);

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
