import { MongoClient } from "mongodb";

const args = process.argv.slice(2);
const flagAll = args.includes("--all");
const dryRun = args.includes("--dry-run");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number.parseInt(limitArg.split("=")[1] || "", 10) : null;

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Missing MONGODB_URI. Run with: node --env-file=.env ./scripts/update-media-dimensions.mjs");
  process.exit(1);
}

const dbName = getDbName(uri);
const client = new MongoClient(uri);

const LOD_ORDER = ["lod2", "lod3", "lod4", "lod1", "lod0"];

try {
  await client.connect();
  const db = client.db(dbName);
  const media = db.collection("media");

  const filter = flagAll
    ? {}
    : {
        $or: [
          { width: { $exists: false } },
          { height: { $exists: false } },
          { width: null },
          { height: null },
        ],
      };

  const cursor = media.find(filter);
  const bulk = [];
  let scanned = 0;
  let updated = 0;

  for await (const doc of cursor) {
    scanned += 1;
    if (limit && scanned > limit) break;

    const { width, height } = resolveDimensions(doc);
    if (!width || !height) continue;

    const nextAspect = width / height;
    const needsUpdate =
      !isFiniteNumber(doc.width) ||
      !isFiniteNumber(doc.height) ||
      Math.abs((doc.aspect ?? 0) - nextAspect) > 0.0001;

    if (!needsUpdate) continue;

    updated += 1;
    if (!dryRun) {
      bulk.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              width,
              height,
              aspect: nextAspect,
            },
          },
        },
      });
    }

    if (bulk.length >= 500) {
      await media.bulkWrite(bulk);
      bulk.length = 0;
    }
  }

  if (bulk.length > 0) {
    await media.bulkWrite(bulk);
  }

  console.log(
    JSON.stringify(
      {
        scanned,
        updated,
        dryRun,
        limit: limit ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}

function resolveDimensions(doc) {
  if (doc.type === "video") {
    const poster = doc.poster;
    if (poster?.w && poster?.h) return { width: poster.w, height: poster.h };
  }
  const variants = doc.variants || {};
  for (const key of LOD_ORDER) {
    const variant = variants[key];
    if (variant?.w && variant?.h) return { width: variant.w, height: variant.h };
  }
  if (doc.poster?.w && doc.poster?.h) return { width: doc.poster.w, height: doc.poster.h };
  return { width: null, height: null };
}

function getDbName(uri) {
  const parsed = new URL(uri);
  return parsed.pathname.replace(/^\//, "") || "mega_media_grid";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
