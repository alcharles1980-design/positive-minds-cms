// ============================================================
// Firebase Transport — writes transformed content into Firebase.
// Supports: Realtime DB (REST), Firestore (REST), Cloud Function (POST).
// Layout is fully configurable via path templates.
// ============================================================

// Resolve a path template like "packs/{slug}" or "content/all"
const resolvePath = (tpl, ctx) => (tpl || "").replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? "");

// Convert a plain JS value into Firestore's typed REST format.
const toFirestoreValue = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFirestoreValue(x)])) } };
  return { stringValue: String(v) };
};
const toFirestoreDoc = (obj) => ({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toFirestoreValue(v)])) });

// Given the built output and a target config, produce a list of write ops.
// Each op: { path, data }  (data is a JS object/array)
const planWrites = (cfg, packs, byPack, buildFn, spec) => {
  const layout = cfg.layout || "per-pack";
  const ops = [];
  if (layout === "single-doc") {
    const body = buildFn(spec, packs, byPack, "id");
    ops.push({ path: cfg.singlePath || "content/all", data: body });
  } else if (layout === "per-question") {
    // one entry per question at questionPath/{id}
    for (const p of packs) {
      for (const q of byPack[p.id] || []) {
        const one = buildFn({ ...spec, structure: "flat", root_key: null }, [p], { [p.id]: [q] }, "id");
        const row = Array.isArray(one) ? one[0] : one;
        ops.push({ path: resolvePath(cfg.questionPath || "questions/{id}", { id: q.id, slug: p.slug }), data: row });
      }
    }
  } else {
    // per-pack (default): one doc per pack at packPath/{slug}
    for (const p of packs) {
      const one = buildFn({ ...spec, structure: "nested", root_key: null }, [p], byPack, "id");
      const row = Array.isArray(one) ? one[0] : one;
      ops.push({ path: resolvePath(cfg.packPath || "packs/{slug}", { slug: p.slug, id: p.id }), data: row });
    }
  }
  return ops;
};

// --- writers ---
const fbWriters = {
  // Realtime Database via REST. cfg: { rtdbUrl, secret }
  async rtdb(cfg, ops) {
    const base = (cfg.rtdbUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("Realtime DB URL is required");
    let ok = 0;
    for (const op of ops) {
      const auth = cfg.secret ? `?auth=${encodeURIComponent(cfg.secret)}` : "";
      const res = await fetch(`${base}/${op.path}.json${auth}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op.data) });
      if (!res.ok) throw new Error(`RTDB write failed at ${op.path}: HTTP ${res.status}`);
      ok++;
    }
    return { written: ok };
  },

  // Firestore via REST. cfg: { projectId, apiKey?, bearer? }
  async firestore(cfg, ops) {
    if (!cfg.projectId) throw new Error("Firestore projectId is required");
    const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents`;
    let ok = 0;
    for (const op of ops) {
      // path like "packs/confidence" -> collection/doc
      const parts = op.path.split("/").filter(Boolean);
      const docId = parts.pop();
      const collection = parts.join("/");
      const key = cfg.apiKey ? `?key=${cfg.apiKey}` : "";
      const url = `${base}/${collection}?documentId=${encodeURIComponent(docId)}${key}`;
      const headers = { "Content-Type": "application/json" };
      if (cfg.bearer) headers.Authorization = `Bearer ${cfg.bearer}`;
      // Firestore create; if exists, PATCH instead
      let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(toFirestoreDoc(op.data)) });
      if (res.status === 409) {
        const patchUrl = `${base}/${collection}/${encodeURIComponent(docId)}${key}`;
        res = await fetch(patchUrl, { method: "PATCH", headers, body: JSON.stringify(toFirestoreDoc(op.data)) });
      }
      if (!res.ok) throw new Error(`Firestore write failed at ${op.path}: HTTP ${res.status}`);
      ok++;
    }
    return { written: ok };
  },

  // Cloud Function (or any endpoint): POST the whole payload once. cfg: { fnUrl, secret, header }
  async cloudFn(cfg, ops, fullPayload) {
    if (!cfg.fnUrl) throw new Error("Cloud Function URL is required");
    const headers = { "Content-Type": "application/json" };
    if (cfg.secret) headers[cfg.header || "Authorization"] = cfg.secret;
    const res = await fetch(cfg.fnUrl, { method: "POST", headers, body: JSON.stringify({ writes: ops, payload: fullPayload }) });
    if (!res.ok) throw new Error(`Cloud Function returned HTTP ${res.status}`);
    return { written: ops.length };
  },
};

// Orchestrate a Firebase sync for a target.
const runFirebaseSync = async (target, profile) => {
  const cfg = target.config || {};
  const content = await fetchAllContent(profile.spec.filters || {}, { expandLevels: !!profile.spec.expand_levels });
  const spec = { ...profile.spec, __name: profile.name };
  const ops = planWrites(cfg, content.packs, content.byPack, buildOutput, spec);
  const fullBody = buildOutput(spec, content.packs, content.byPack, "id");
  const fullPayload = withMeta(spec, fullBody, { packs: content.packs.length, questions: content.questionCount });

  let result;
  if (cfg.mode === "firestore") result = await fbWriters.firestore(cfg, ops);
  else if (cfg.mode === "cloudfn") result = await fbWriters.cloudFn(cfg, ops, fullPayload);
  else result = await fbWriters.rtdb(cfg, ops);

  return { ...result, packCount: content.packs.length, questionCount: content.questionCount, opCount: ops.length };
};

const db_targets = {
  list: () => rest("pm_sync_targets?order=created_at.asc&limit=1000").then(r => r.data || []),
  create: (t) => rest("pm_sync_targets", { method: "POST", body: t }).then(r => r.data?.[0]),
  update: (id, t) => rest(`pm_sync_targets?id=eq.${id}`, { method: "PATCH", body: t }).then(r => r.data?.[0]),
  remove: (id) => rest(`pm_sync_targets?id=eq.${id}`, { method: "DELETE" }),
};
