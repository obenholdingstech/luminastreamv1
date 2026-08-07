// A fake R2 bucket for tests, shaped like the binding the Worker sees:
// put/get/head/delete/list — enough surface for the avatar routes, no more.
// Objects live in a Map keyed by object key; list() honors `prefix` only,
// which is exactly what the routes use (per-user prefixes ARE the isolation,
// so the fake must get prefix filtering right or the tests prove nothing).

export function createFakeR2() {
  const objects = new Map();
  return {
    async put(key, value, options = {}) {
      const bytes =
        value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, {
        key,
        bytes,
        size: bytes.length,
        uploaded: new Date('2026-08-07T12:00:00Z'),
        customMetadata: options.customMetadata ?? {},
        httpMetadata: options.httpMetadata ?? {},
      });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        key: o.key,
        size: o.size,
        uploaded: o.uploaded,
        customMetadata: o.customMetadata,
        httpMetadata: o.httpMetadata,
        body: new Blob([o.bytes]).stream(),
        async arrayBuffer() {
          return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength);
        },
      };
    },
    async head(key) {
      const o = objects.get(key);
      if (!o) return null;
      const { bytes, ...meta } = o;
      return meta;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const hits = [...objects.values()]
        .filter((o) => o.key.startsWith(prefix))
        .map(({ bytes, ...meta }) => meta);
      return { objects: hits, truncated: false };
    },
    /** test-only peek */
    _objects: objects,
  };
}
