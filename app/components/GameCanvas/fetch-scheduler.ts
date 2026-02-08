import { getBatchUrls } from "~/shared/client-api";

export class FetchScheduler {
  private pending = new Set<string>();

  async fetchUrls(
    requests: Array<{ id: string; lod: 0 | 1 | 2 | 3 | 4; kind?: "lod" | "blur"; priority: number }>,
  ) {
    const filtered = requests
      .filter((item) => {
        const key = `${item.id}:${item.kind ?? "lod"}:${item.lod}`;
        if (this.pending.has(key)) return false;
        this.pending.add(key);
        return true;
      })
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 300);

    if (!filtered.length) return [];

    try {
      const res = await getBatchUrls(filtered.map(({ id, lod, kind }) => ({ id, lod, kind })));
      return res.items;
    } finally {
      for (const item of filtered) {
        this.pending.delete(`${item.id}:${item.kind ?? "lod"}:${item.lod}`);
      }
    }
  }
}
