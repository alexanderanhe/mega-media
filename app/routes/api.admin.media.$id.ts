import { getCollections, ObjectId } from "~/server/db";
import { deleteObjects } from "~/server/r2";
import { ApiError, jsonOk, parseJson, requireRole, withApiErrorHandling } from "~/server/http";
import { patchMediaSchema } from "~/server/schemas";

export const action = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid media id");
    if (request.method === "DELETE") {
      const { media } = await getCollections();
      const existing = await media.findOne({ _id: new ObjectId(params.id) });
      if (!existing) throw new ApiError(404, "Media not found");

      const keys = [
        existing.r2KeyOriginal,
        ...Object.values(existing.variants ?? {}).map((variant) => variant.r2Key),
        existing.poster?.r2Key,
        existing.preview?.r2Key,
      ].filter(Boolean) as string[];

      await deleteObjects(keys);
      await media.deleteOne({ _id: new ObjectId(params.id) });

      return jsonOk({ ok: true });
    }

    const body = await parseJson(request, patchMediaSchema);

    const patch: Record<string, unknown> = {};
    if (body.visibility) patch.visibility = body.visibility;
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
    if (body.category !== undefined) {
      patch.category = body.category ? normalizeToken(body.category) : null;
    }
    if (body.dateTaken !== undefined) {
      patch.dateTaken = body.dateTaken ? new Date(body.dateTaken) : null;
      patch.dateEffective = body.dateTaken ? new Date(body.dateTaken) : undefined;
    }
    if (body.location !== undefined) {
      patch.location = body.location;
    }
    if (body.placeName !== undefined) {
      if (!patch.location) {
        patch.location = body.placeName
          ? { lat: 0, lng: 0, source: "manual", placeName: body.placeName }
          : null;
      } else if (patch.location && typeof patch.location === "object") {
        patch.location = { ...(patch.location as Record<string, unknown>), placeName: body.placeName ?? undefined };
      }
    }
    if (body.width !== undefined) {
      patch.width = normalizeDimension(body.width);
    }
    if (body.height !== undefined) {
      patch.height = normalizeDimension(body.height);
    }

    Object.keys(patch).forEach((key) => {
      if (patch[key] === undefined) delete patch[key];
    });

    if (Object.keys(patch).length === 0) throw new ApiError(400, "No changes provided");

    const { media } = await getCollections();
    const existing = await media.findOne({ _id: new ObjectId(params.id) });
    if (!existing) throw new ApiError(404, "Media not found");

    if (patch.dateTaken !== undefined && patch.dateEffective === undefined) {
      patch.dateEffective = existing.createdAt;
    }

    if (patch.width !== undefined || patch.height !== undefined) {
      const width =
        patch.width !== undefined
          ? (patch.width as number | null)
          : existing.width ?? null;
      const height =
        patch.height !== undefined
          ? (patch.height as number | null)
          : existing.height ?? null;
      if (width && height) {
        patch.aspect = width / height;
      }
    }

    await media.updateOne({ _id: new ObjectId(params.id) }, { $set: patch });

    return jsonOk({ ok: true });
  })(request);

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function normalizeTags(tags: string[]) {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeToken(tag);
    if (normalized) unique.add(normalized);
  }
  return Array.from(unique).slice(0, 30);
}

function normalizeDimension(value: number | null) {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.round(value);
}
