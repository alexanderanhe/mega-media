import { ApiError, jsonOk, optionalAuth, parseQuery, withApiErrorHandling } from "~/server/http";
import { getCollections } from "~/server/db";
import { pageQuerySchema } from "~/server/schemas";

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const query = await parseQuery(request, pageQuerySchema);
    const auth = await optionalAuth(request);

    const statusList = auth ? ["ready", "processing", "error"] : ["ready", "processing"];
    const filter: Record<string, unknown> = { status: { $in: statusList } };
    if (!auth) filter.visibility = "PUBLIC";
    if (query.visibility) filter.visibility = query.visibility;
    if (query.type) filter.type = query.type;
    if (query.tag) filter.tags = normalizeToken(query.tag);
    if (query.category) filter.category = normalizeToken(query.category);

    const range = resolveDateRange(query.year, query.month, query.from, query.to);
    if (range) filter.dateEffective = range;
    if (query.q) {
      const regex = new RegExp(escapeRegex(query.q), "i");
      filter.$or = [
        { title: regex },
        { description: regex },
        { "location.placeName": regex },
      ];
    }

    const { media } = await getCollections();
    const skip = (query.page - 1) * query.pageSize;

    const sort = resolveSort(query.sort);
    const [items, total] = await Promise.all([
      media
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(query.pageSize)
        .project({
          _id: 1,
          type: 1,
          visibility: 1,
          status: 1,
          errorMessage: 1,
          title: 1,
          description: 1,
          tags: 1,
          category: 1,
          dateTaken: 1,
          dateEffective: 1,
          location: 1,
          aspect: 1,
          variants: 1,
          poster: 1,
          preview: 1,
        })
        .toArray(),
      media.countDocuments(filter),
    ]);

    return jsonOk({
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: items.map((item) => ({
        id: item._id.toString(),
        type: item.type,
        aspect: item.aspect || pickAspect(item),
        dateEffective: item.dateEffective,
        hasLocation: Boolean(item.location),
        visibility: item.visibility,
        status: item.status,
        errorMessage: auth ? (item.errorMessage ?? null) : null,
        title: auth ? (item.title ?? "") : undefined,
        description: auth ? (item.description ?? "") : undefined,
        placeName: auth ? (item.location?.placeName ?? "") : undefined,
        dateTaken: auth ? (item.dateTaken ?? null) : undefined,
        tags: auth ? (item.tags ?? []) : undefined,
        category: auth ? (item.category ?? null) : undefined,
        sizeBytes: auth ? pickSize(item) : undefined,
        durationSeconds: auth ? (item.preview?.duration ?? null) : null,
      })),
    });
  })(request);

function resolveDateRange(year?: string, month?: string, from?: string, to?: string) {
  if (month) {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) throw new ApiError(400, "Invalid month");
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    return { $gte: start, $lt: end };
  }

  if (year) {
    const y = Number(year);
    const start = new Date(Date.UTC(y, 0, 1));
    const end = new Date(Date.UTC(y + 1, 0, 1));
    return { $gte: start, $lt: end };
  }

  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    return range;
  }

  return null;
}

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function pickAspect(item: { variants?: Record<string, { w: number; h: number }>; poster?: { w: number; h: number } | null }) {
  const lod2 = item.variants?.lod2;
  if (lod2?.w && lod2?.h) return lod2.w / lod2.h;
  if (item.poster?.w && item.poster?.h) return item.poster.w / item.poster.h;
  return 1;
}

function resolveSort(sort?: string): Record<string, 1 | -1> {
  switch (sort) {
    case "date_asc":
      return { dateEffective: 1 };
    case "size_desc":
      return { "variants.lod4.bytes": -1, dateEffective: -1 };
    case "size_asc":
      return { "variants.lod4.bytes": 1, dateEffective: -1 };
    case "title_asc":
      return { title: 1 };
    case "title_desc":
      return { title: -1 };
    case "date_desc":
    default:
      return { dateEffective: -1 };
  }
}

function pickSize(item: { variants?: Record<string, { bytes: number }>; r2KeyOriginal?: string }) {
  const lod4 = item.variants?.lod4;
  if (lod4?.bytes) return lod4.bytes;
  const lod3 = item.variants?.lod3;
  if (lod3?.bytes) return lod3.bytes;
  return null;
}
