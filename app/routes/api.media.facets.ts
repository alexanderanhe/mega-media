import { jsonOk, optionalAuth, parseQuery, withApiErrorHandling } from "~/server/http";
import { getCollections, ObjectId } from "~/server/db";
import { z } from "zod";

const facetsQuerySchema = z.object({
  year: z.string().regex(/^\d{4}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  type: z.enum(["image", "video"]).optional(),
  tag: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  liked: z.coerce.boolean().optional(),
});

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const query = await parseQuery(request, facetsQuerySchema);
    const auth = await optionalAuth(request);

    const statusList = auth ? ["ready", "processing", "error"] : ["ready", "processing"];
    const match: Record<string, unknown> = { status: { $in: statusList } };
    if (!auth) match.visibility = "PUBLIC";

    const range = resolveDateRange(query.year, query.month, query.from, query.to);
    if (range) match.dateEffective = range;
    if (query.type) match.type = query.type;
    if (query.tag) match.tags = normalizeToken(query.tag);
    if (query.category) match.category = normalizeToken(query.category);

    const { media, likes } = await getCollections();

    if (query.liked && !auth) {
      return jsonOk({ years: [], months: [], tags: [], categories: [] });
    }
    if (query.liked && auth?.sub) {
      const likedRows = await likes.find({ userId: new ObjectId(auth.sub) }).project({ mediaId: 1 }).toArray();
      const likedIds = likedRows.map((row) => row.mediaId);
      if (!likedIds.length) {
        return jsonOk({ years: [], months: [], tags: [], categories: [] });
      }
      match._id = { $in: likedIds };
    }

    const years = await media
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: { $year: "$dateEffective" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
      ])
      .toArray();

    let months: Array<{ month: number; count: number }> = [];
    if (query.year) {
      const yearNum = Number(query.year);
      const start = new Date(Date.UTC(yearNum, 0, 1));
      const end = new Date(Date.UTC(yearNum + 1, 0, 1));
      const monthMatch = { ...match, dateEffective: { $gte: start, $lt: end } };
      months = await media
        .aggregate([
          { $match: monthMatch },
          {
            $group: {
              _id: { $month: "$dateEffective" },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray()
        .then((rows) => rows.map((row) => ({ month: row._id as number, count: row.count as number })));
    }

    const tags = await media
      .aggregate([
        { $match: match },
        { $unwind: "$tags" },
        { $group: { _id: "$tags", count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ])
      .toArray()
      .then((rows) => rows.map((row) => ({ tag: row._id as string, count: row.count as number })));

    const categories = await media
      .aggregate([
        { $match: { ...match, category: { $nin: [null, ""] } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ])
      .toArray()
      .then((rows) => rows.map((row) => ({ category: row._id as string, count: row.count as number })));

    return jsonOk({
      years: years.map((row) => ({ year: row._id, count: row.count })),
      months,
      tags,
      categories,
    });
  })(request);

function resolveDateRange(year?: string, month?: string, from?: string, to?: string) {
  if (month) {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return null;
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

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}
