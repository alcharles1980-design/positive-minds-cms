// ============================================================
// Transformation Engine (client) — identical logic to the edge fn.
// Turns internal packs+questions into a customizable external shape.
// ============================================================
const TRANSFORMS = [
  { v: "none", label: "None" },
  { v: "upper", label: "UPPERCASE" },
  { v: "lower", label: "lowercase" },
  { v: "trim", label: "Trim spaces" },
];

const xf = (val, t) => {
  if (val == null) return val;
  if (typeof val === "object") return val; // never stringify objects/arrays (e.g. frame_slots, tags)
  switch (t) { case "upper": return String(val).toUpperCase(); case "lower": return String(val).toLowerCase(); case "trim": return String(val).trim(); default: return val; }
};
const mapVal = (field, val, vm) => {
  const m = vm?.[field];
  if (!m) return val;
  const key = (typeof val === "object" || val == null) ? null : val; // only primitives can key a value_map
  return (key != null && key in m) ? m[key] : val;
};
const projectRow = (row, fields, vm) => {
  const out = {};
  for (const f of fields || []) { if (!f.to) continue; let v = xf(row[f.from], f.transform || "none"); v = mapVal(f.to, v, vm); out[f.to] = v; }
  return out;
};

// Convert a built output object/array into pretty XML. Keys become tags;
// arrays repeat a singularized item tag; primitives become text nodes.
const XML_ESC = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const singular = (k) => k === "levels" ? "levelVariant" : k.endsWith("ies") ? k.slice(0, -3) + "y" : k.endsWith("s") ? k.slice(0, -1) : k;
const safeTag = (k) => /^[a-zA-Z_][\w.-]*$/.test(k) ? k : "item";
const toXmlNode = (key, val, indent) => {
  const pad = "  ".repeat(indent);
  const tag = safeTag(key);
  if (val === null || val === undefined) return `${pad}<${tag}/>`;
  if (Array.isArray(val)) {
    const item = singular(tag);
    if (val.length === 0) return `${pad}<${tag}/>`;
    return `${pad}<${tag}>\n` + val.map(v => toXmlNode(item, v, indent + 1)).join("\n") + `\n${pad}</${tag}>`;
  }
  if (typeof val === "object") {
    const inner = Object.entries(val).map(([k, v]) => toXmlNode(k, v, indent + 1)).join("\n");
    return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`;
  }
  return `${pad}<${tag}>${XML_ESC(val)}</${tag}>`;
};
const toXml = (obj, rootTag = "gameContent") => {
  const body = Array.isArray(obj)
    ? obj.map(v => toXmlNode("item", v, 1)).join("\n")
    : Object.entries(obj).map(([k, v]) => toXmlNode(k, v, 1)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n${body}\n</${rootTag}>`;
};

// packs: array; byPack: { [packId or slug]: questions[] }; keyField tells which key byPack uses
const buildOutput = (spec, packs, byPack, keyField = "id") => {
  const vm = spec.value_maps || {};
  const qKey = spec.questions_key || "questions";
  const projectQ = (q) => { const base = projectRow(q, spec.question_fields, vm); if (spec.expand_levels && q.levels) base.levels = q.levels; if (spec.include_frames && q.frame_slots && Object.keys(q.frame_slots).length) base.frameSlots = q.frame_slots; return base; };
  const k = (p) => p[keyField];

  if (spec.structure === "flat") {
    const arr = [];
    for (const p of packs) { const pp = projectRow(p, spec.pack_fields, vm); for (const q of byPack[k(p)] || []) arr.push({ ...pp, ...projectQ(q) }); }
    return spec.root_key ? { [spec.root_key]: arr } : arr;
  }
  if (spec.structure === "keyed") {
    const obj = {}; const keyBy = spec.key_by || "slug";
    for (const p of packs) obj[p[keyBy]] = { ...projectRow(p, spec.pack_fields, vm), [qKey]: (byPack[k(p)] || []).map(projectQ) };
    return spec.root_key ? { [spec.root_key]: obj } : obj;
  }
  const arr = packs.map((p) => ({ ...projectRow(p, spec.pack_fields, vm), [qKey]: (byPack[k(p)] || []).map(projectQ) }));
  return spec.root_key ? { [spec.root_key]: arr } : arr;
};

const withMeta = (spec, body, counts) => {
  if (spec.include_meta === false) return body;
  const meta = { generated_at: new Date().toISOString(), profile: spec.__name || "", pack_count: counts.packs, question_count: counts.questions };
  return Array.isArray(body) ? { meta, data: body } : { meta, ...body };
};

// Field names available to map from
const PACK_SOURCE_FIELDS = ["slug", "name", "emoji", "description", "color", "difficulty", "status", "is_custom", "tags", "level", "purpose", "focus_areas", "style_approach", "example_objectives"];
const QUESTION_SOURCE_FIELDS = ["template", "base_sentence", "answer", "alt_answer", "status", "notes", "level", "effective_level", "letter_position", "letter_grouping", "frame_slots"];

const emptySpec = () => ({
  structure: "nested", root_key: "packs", questions_key: "questions", key_by: "slug",
  include_meta: true, filters: { status: "published", question_status: "active" },
  pack_fields: [{ from: "slug", to: "id", transform: "none" }, { from: "name", to: "name", transform: "none" }],
  question_fields: [{ from: "template", to: "template", transform: "none" }, { from: "answer", to: "answer", transform: "none" }],
  value_maps: {},
});

const db_profiles = {
  list: () => rest("pm_export_profiles?order=created_at.asc&limit=1000").then(r => r.data || []),
  create: (p) => rest("pm_export_profiles", { method: "POST", body: p }).then(r => r.data?.[0]),
  update: (id, p) => rest(`pm_export_profiles?id=eq.${id}`, { method: "PATCH", body: p }).then(r => r.data?.[0]),
  remove: (id) => rest(`pm_export_profiles?id=eq.${id}`, { method: "DELETE" }),
};
const db_sync = {
  log: (row) => rest("pm_sync_log", { method: "POST", body: row }).catch(() => {}),
  history: () => rest("pm_sync_log?order=created_at.desc&limit=100").then(r => r.data || []),
  // Advance released_version = content_version so "pending changes" clears. null = all published.
  markReleased: (packIds = null) => rpc("pm_mark_released", { pack_ids: packIds }),
};

// Fetch all content for building an export (paginated — no silent 1000 cap).
const fetchAllContent = async (filters = {}, opts = {}) => {
  let pQ = "pm_packs?order=sort_order.asc";
  if (filters.status) pQ += `&status=eq.${filters.status}`;
  const packs = await restAll(pQ);
  let qQ = "pm_questions?order=sort_order.asc";
  if (filters.question_status) qQ += `&status=eq.${filters.question_status}`;
  const questions = await restAll(qQ);

  const packLevelById = {};
  for (const p of packs) packLevelById[p.id] = p.level || 1;

  // Attach the effective level to every question (question override → pack default).
  // Also add a resolved base sentence (frame words filled at the base level) alongside the
  // raw template, so a consumer reading the base question sees real words, not {tokens}.
  for (const q of questions) {
    q.effective_level = q.level ?? packLevelById[q.pack_id] ?? 1;
    q.base_sentence = resolveSlots(q.template || "", q.frame_slots, q.effective_level).replace(/\{blank\}/g, (q.answer || "").toUpperCase());
  }

  // If the profile wants per-level variants, fetch level defs + overrides and expand.
  if (opts.expandLevels) {
    const levels = await restAll("pm_levels?order=level.asc");
    const overrideRows = await restAll("pm_question_levels?order=level.asc");
    const ovByQ = {};
    for (const r of overrideRows) { (ovByQ[r.question_id] = ovByQ[r.question_id] || {})[r.level] = r; }
    for (const q of questions) {
      q.levels = buildLevelVariants(q, levels, ovByQ[q.id] || {})
        .filter(v => v.enabled)
        .map(v => ({ level: v.level, level_name: v.name, sentence: v.sentence, blank: v.blank, target: v.target, frames: v.frames, opts: v.opts }));
    }
  }

  const byPack = {};
  for (const q of questions) (byPack[q.pack_id] = byPack[q.pack_id] || []).push(q);
  const packList = packs.filter(p => (byPack[p.id]?.length || 0) > 0 || filters.include_empty);
  return { packs: packList, byPack, questionCount: questions.length };
};
