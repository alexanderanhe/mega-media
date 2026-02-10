import { ApiError, jsonOk, optionalAuth, parseQuery, withApiErrorHandling } from "~/server/http";
import { getCollections, ObjectId } from "~/server/db";
import { pageQuerySchema } from "~/server/schemas";

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const query = await parseQuery(request, pageQuerySchema);
    const auth = await optionalAuth(request);

    const statusList = auth ? ["ready", "processing", "error"] : ["ready", "processing"];
    const filter: Record<string, unknown> = { status: { $in: statusList } };
    if (query.visibility) filter.visibility = query.visibility;
    if (query.type) filter.type = query.type;
    if (query.tag) filter.tags = normalizeToken(query.tag);
    if (query.category) filter.category = normalizeToken(query.category);
    if (query.orientation) {
      const epsilon = 0.05;
      if (query.orientation === "landscape") {
        filter.aspect = { $gt: 1 + epsilon };
      } else if (query.orientation === "portrait") {
        filter.aspect = { $lt: 1 - epsilon };
      } else if (query.orientation === "square") {
        filter.aspect = { $gte: 1 - epsilon, $lte: 1 + epsilon };
      }
    }

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

    const { media, likes } = await getCollections();
    const skip = (query.page - 1) * query.pageSize;

    if (query.liked && !auth) {
      throw new ApiError(401, "Unauthorized");
    }
    if (query.featured && !auth) {
      throw new ApiError(401, "Unauthorized");
    }

    let likedIds: ObjectId[] | null = null;
    if (query.liked && auth?.sub) {
      const rows = await likes.find({ userId: new ObjectId(auth.sub) }).project({ mediaId: 1 }).toArray();
      likedIds = rows.map((row) => row.mediaId);
      if (likedIds.length === 0) {
        return jsonOk({ page: query.page, pageSize: query.pageSize, total: 0, items: [] });
      }
      filter._id = { $in: likedIds };
    }

    if (query.featured) {
      const featuredIds = await likes.distinct("mediaId");
      if (!featuredIds.length) {
        return jsonOk({ page: query.page, pageSize: query.pageSize, total: 0, items: [] });
      }
      if (filter._id && typeof filter._id === "object" && (filter._id as any).$in) {
        const current = new Set(((filter._id as any).$in as ObjectId[]).map((id) => id.toString()));
        const next = featuredIds.filter((id) => current.has(id.toString()));
        if (!next.length) {
          return jsonOk({ page: query.page, pageSize: query.pageSize, total: 0, items: [] });
        }
        filter._id = { $in: next };
      } else {
        filter._id = { $in: featuredIds };
      }
    }

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
          width: 1,
          height: 1,
          variants: 1,
          poster: 1,
          preview: 1,
          originalBytes: 1,
        })
        .toArray(),
      media.countDocuments(filter),
    ]);

    let likedSet = new Set<string>();
    let likesCountMap = new Map<string, number>();
    if (auth?.sub && items.length) {
      const itemIds = items.map((item) => item._id);
      const likedRows = await likes
        .find({ userId: new ObjectId(auth.sub), mediaId: { $in: itemIds } })
        .project({ mediaId: 1 })
        .toArray();
      likedSet = new Set(likedRows.map((row) => row.mediaId.toString()));
    }
    if (items.length) {
      const itemIds = items.map((item) => item._id);
      const counts = await likes
        .aggregate([
          { $match: { mediaId: { $in: itemIds } } },
          { $group: { _id: "$mediaId", count: { $sum: 1 } } },
        ])
        .toArray();
      likesCountMap = new Map(counts.map((row) => [row._id.toString(), row.count as number]));
    }

    return jsonOk({
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: items.map((item) => ({
        id: item._id.toString(),
        type: item.type,
        aspect: pickAspect(item),
        width: auth ? (item.width ?? null) : undefined,
        height: auth ? (item.height ?? null) : undefined,
        dateEffective: item.dateEffective,
        hasLocation: !auth && item.visibility === "PRIVATE" ? false : Boolean(item.location),
        visibility: item.visibility,
        status: item.status,
        errorMessage: auth ? (item.errorMessage ?? null) : null,
        hidden: !auth && item.visibility === "PRIVATE",
        title: !auth && item.visibility === "PRIVATE" ? "" : item.title ?? "",
        description: !auth && item.visibility === "PRIVATE" ? "" : item.description ?? "",
        placeName: auth ? (item.location?.placeName ?? "") : undefined,
        dateTaken: !auth && item.visibility === "PRIVATE" ? null : item.dateTaken ?? null,
        tags: auth ? (item.tags ?? []) : undefined,
        category: auth ? (item.category ?? null) : undefined,
        sizeBytes: auth ? pickSize(item) : undefined,
        originalBytes: auth ? (item.originalBytes ?? null) : undefined,
        variantSizes: auth ? pickVariantSizes(item) : undefined,
        durationSeconds: auth ? (item.preview?.duration ?? null) : null,
        liked: auth ? likedSet.has(item._id.toString()) : false,
        likesCount: likesCountMap.get(item._id.toString()) ?? 0,
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

function pickAspect(item: {
  width?: number | null;
  height?: number | null;
  aspect?: number;
  variants?: Record<string, { w: number; h: number }>;
  poster?: { w: number; h: number } | null;
}) {
  if (item.width && item.height) return item.width / item.height;
  if (item.aspect && Number.isFinite(item.aspect)) return item.aspect;
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

function pickVariantSizes(item: { variants?: Record<string, { bytes: number }> }) {
  if (!item.variants) return null;
  const sizes: Record<string, number> = {};
  for (const [key, value] of Object.entries(item.variants)) {
    if (value?.bytes) sizes[key] = value.bytes;
  }
  return Object.keys(sizes).length ? sizes : null;
}
