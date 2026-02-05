import type { Texture } from "pixi.js";

export class TextureCache {
  private map = new Map<string, Texture>();

  constructor(private max = 800) {}

  get(key: string) {
    const existing = this.map.get(key);
    if (!existing) return null;
    this.map.delete(key);
    this.map.set(key, existing);
    return existing;
  }

  set(key: string, texture: Texture) {
    if (this.map.has(key)) {
      const old = this.map.get(key);
      old?.destroy(true);
      this.map.delete(key);
    }
    this.map.set(key, texture);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (!first) return;
      const old = this.map.get(first);
      old?.destroy(true);
      this.map.delete(first);
    }
  }

  clear() {
    for (const value of this.map.values()) {
      value.destroy(true);
    }
    this.map.clear();
  }
}
