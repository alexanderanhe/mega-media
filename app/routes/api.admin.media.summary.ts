import { ApiError, jsonOk, parseQuery, requireRole, withApiErrorHandling } from "~/server/http";
import { getCollections, ObjectId } from "~/server/db";
import { pageQuerySchema } from "~/server/schemas";

const EPSILON = 0.05;

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");

    const query = await parseQuery(request, pageQuerySchema);
    const filter: Record<string, unknown> = { status: { $in: ["ready", "processing", "error"] } };
    if (query.visibility) filter.visibility = query.visibility;
    if (query.type) filter.type = query.type;
    if (query.tag) filter.tags = normalizeToken(query.tag);
    if (query.category) filter.category = normalizeToken(query.category);
    if (query.orientation) {
      if (query.orientation === "landscape") {
        filter.aspect = { $gt: 1 + EPSILON };
      } else if (query.orientation === "portrait") {
        filter.aspect = { $lt: 1 - EPSILON };
      } else if (query.orientation === "square") {
        filter.aspect = { $gte: 1 - EPSILON, $lte: 1 + EPSILON };
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

    if (query.featured) {
      const featuredIds = await likes.distinct("mediaId");
      if (!featuredIds.length) {
        return jsonOk(emptySummary());
      }
      filter._id = { $in: featuredIds };
    }

    const items = await media
      .find(filter)
      .project({
        _id: 1,
        type: 1,
        originalBytes: 1,
        variants: 1,
        width: 1,
        height: 1,
        aspect: 1,
      })
      .toArray();

    const summary = computeSummary(items);
    return jsonOk(summary);
  })(request);

function emptySummary() {
  return {
    totalCount: 0,
    totalBytes: 0,
    imageCount: 0,
    videoCount: 0,
    imageAverage: 0,
    imageMedian: 0,
    videoAverage: 0,
    videoMedian: 0,
    orientationCounts: {
      landscape: 0,
      portrait: 0,
      square: 0,
      unknown: 0,
    },
  };
}

function computeSummary(
  items: Array<{
    _id: ObjectId;
    type: "image" | "video";
    originalBytes?: number | null;
    variants?: Record<string, { bytes?: number }>;
    width?: number | null;
    height?: number | null;
    aspect?: number;
  }>,
) {
  if (!items.length) return emptySummary();

  let totalBytes = 0;
  let imageCount = 0;
  let videoCount = 0;
  const imageSizes: number[] = [];
  const videoSizes: number[] = [];
  const orientationCounts = {
    landscape: 0,
    portrait: 0,
    square: 0,
    unknown: 0,
  };

  for (const item of items) {
    if (item.type === "image") imageCount += 1;
    if (item.type === "video") videoCount += 1;
    const baseSize = pickSize(item);
    if (baseSize > 0) {
      totalBytes += baseSize;
      if (item.type === "image") imageSizes.push(baseSize);
      if (item.type === "video") videoSizes.push(baseSize);
    }
    const aspect = resolveItemAspect(item.width, item.height, item.aspect);
    const orientation = resolveOrientation(aspect);
    if (!orientation) {
      orientationCounts.unknown += 1;
    } else {
      orientationCounts[orientation] += 1;
    }
  }

  return {
    totalCount: items.length,
    totalBytes,
    imageCount,
    videoCount,
    imageAverage: average(imageSizes),
    imageMedian: median(imageSizes),
    videoAverage: average(videoSizes),
    videoMedian: median(videoSizes),
    orientationCounts,
  };
}

function pickSize(item: { originalBytes?: number | null; variants?: Record<string, { bytes?: number }> }) {
  if (item.originalBytes && Number.isFinite(item.originalBytes)) return item.originalBytes;
  const lod4 = item.variants?.lod4?.bytes;
  if (lod4 && Number.isFinite(lod4)) return lod4;
  const lod3 = item.variants?.lod3?.bytes;
  if (lod3 && Number.isFinite(lod3)) return lod3;
  return 0;
}

function resolveItemAspect(width?: number | null, height?: number | null, aspect?: number) {
  if (width && height) return width / height;
  if (aspect && Number.isFinite(aspect)) return aspect;
  return 1;
}

function resolveOrientation(aspect?: number) {
  if (!aspect || !Number.isFinite(aspect)) return null;
  if (aspect > 1 + EPSILON) return "landscape";
  if (aspect < 1 - EPSILON) return "portrait";
  return "square";
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

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
