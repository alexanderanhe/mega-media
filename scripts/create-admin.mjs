import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function getDbName(uri) {
  const parsed = new URL(uri);
  return parsed.pathname.replace(/^\//, "") || "mega_media_grid";
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  const email = (getArg("email") || process.env.BOOTSTRAP_ADMIN_EMAIL || "").toLowerCase();
  const password = getArg("password") || process.env.BOOTSTRAP_ADMIN_PASSWORD || "";

  if (!mongoUri) {
    throw new Error("Missing MONGODB_URI. Add it to .env");
  }

  if (!email || !password) {
    throw new Error(
      "Usage: pnpm run admin:create -- --email admin@example.com --password 'YourPass123'",
    );
  }

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    const db = client.db(getDbName(mongoUri));
    const users = db.collection("users");

    await users.createIndex({ email: 1 }, { unique: true });

    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();

    const result = await users.updateOne(
      { email },
      {
        $set: {
          email,
          passwordHash,
          role: "ADMIN",
          isActive: true,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );

    if (result.upsertedCount > 0) {
      console.log(`ADMIN created: ${email}`);
    } else {
      console.log(`ADMIN updated: ${email}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
