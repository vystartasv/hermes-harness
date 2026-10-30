/**
 * world-model.ts — Portable latent failure prediction
 * 
 * Core idea (LeWM / JEPA):
 *   Encoder: pattern text → fixed-dim embedding (via simple hash → vector)
 *   Predictor: current context → most similar known failure cluster
 *   Surprise: distance from nearest cluster
 * 
 * No external API needed. Embedding is local via word-count vectorization.
 * This makes the world model fully portable — no API key required.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HERMES_HOME = join(homedir(), ".hermes");
const MODEL_FILE = join(HERMES_HOME, "harness", "world-model.json");

// Directories that feed into the world model
const PATTERN_DIRS = [
  join(HERMES_HOME, "harness", "git-patterns"),
  join(HERMES_HOME, "harness", "ticket-patterns"),
  join(HERMES_HOME, "harness", "generated-fixes"),
];

interface Cluster {
  pattern_id: string;
  centroid: number[];       // 128-dim word-count vector
  variance: number;
  count: number;
  label: string;
  source: string;            // which directory / project
  category: string;
}

interface WorldModel {
  clusters: Cluster[];
  total_observations: number;
  last_updated: string;
  vocabulary: string[];      // the 128 most common words across all patterns
}

function loadModel(): WorldModel {
  try { return JSON.parse(readFileSync(MODEL_FILE, "utf-8")); }
  catch { return { clusters: [], total_observations: 0, last_updated: "", vocabulary: [] }; }
}

function saveModel(m: WorldModel) {
  mkdirSync(join(HERMES_HOME, "harness"), { recursive: true });
  writeFileSync(MODEL_FILE, JSON.stringify(m, null, 2));
}

// ── LOCAL EMBEDDING (no API needed) ──────────────────────────────

/** Tokenize text into words, lowercased, filtered */
function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2 && !["the", "and", "for", "was", "are", "not", "but"].includes(w));
}

/** Build vocabulary from all pattern texts (most frequent N words) */
function buildVocabulary(texts: string[], dim = 128): string[] {
  const freq = new Map<string, number>();
  for (const t of texts) {
    for (const w of tokenize(t)) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, dim)
    .map(e => e[0]);
}

/** Encode text as 128-dim word-count vector against vocabulary */
function encode(text: string, vocabulary: string[]): number[] {
  const tokens = tokenize(text);
  const vec = new Array(vocabulary.length).fill(0);
  for (const t of tokens) {
    const idx = vocabulary.indexOf(t);
    if (idx >= 0) vec[idx] += 1;
  }
  // Normalize to unit vector
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag > 0) return vec.map(v => v / mag);
  return vec;
}

/** Cosine similarity */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// ── TRAINING ──────────────────────────────────────────────────────

/** Load all raw pattern files from all source dirs */
function loadRawPatterns(): { text: string; source: string; category: string; title: string }[] {
  const patterns: { text: string; source: string; category: string; title: string }[] = [];
  for (const dir of PATTERN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        const text = `${data.category || ""} ${data.title || ""} ${data.description || ""} ${data.approach || ""}`;
        const source = data.source || data.issue?.repo || dir.split("/").pop() || "unknown";
        patterns.push({ text, source, category: data.category || "unknown", title: data.title || f });
      } catch {}
    }
  }
  return patterns;
}

function train(): void {
  const patterns = loadRawPatterns();
  if (patterns.length === 0) {
    console.log("No patterns to train on");
    return;
  }

  const model = loadModel();
  
  // Build vocabulary from ALL patterns (new + existing)
  const allTexts = patterns.map(p => p.text);
  if (model.clusters.length > 0) {
    // Preserve existing vocabulary and extend
    allTexts.push(...model.clusters.map(c => c.label));
  }
  model.vocabulary = buildVocabulary(allTexts, 128);

  // Encode each pattern and add/update clusters
  for (const p of patterns) {
    const key = `${p.source}:${p.title}`;
    if (model.clusters.some(c => c.pattern_id === key)) continue;

    const emb = encode(p.text, model.vocabulary);
    const existing = model.clusters.find(c => c.pattern_id === key);
    if (existing) {
      // Moving average
      const n = existing.count;
      existing.centroid = existing.centroid.map((v, i) => (v * n + emb[i]) / (n + 1));
      existing.count += 1;
    } else {
      model.clusters.push({
        pattern_id: key,
        centroid: emb,
        variance: 0.1,
        count: 1,
        label: p.title.slice(0, 60),
        source: p.source,
        category: p.category,
      });
      model.total_observations++;
    }
  }

  model.last_updated = new Date().toISOString();
  saveModel(model);
  console.log(`World model trained: ${model.clusters.length} clusters, ${model.vocabulary.length}-dim vocabulary`);
}

// ── PREDICTION ─────────────────────────────────────────────────────

function predict(context: string): void {
  const model = loadModel();
  if (model.clusters.length === 0 || model.vocabulary.length === 0) {
    console.log("World model empty — run 'world-train' first");
    return;
  }

  const emb = encode(context, model.vocabulary);
  const results = model.clusters.map(c => ({
    ...c,
    similarity: cosineSimilarity(c.centroid, emb),
    surprise: 1 - cosineSimilarity(c.centroid, emb),
  })).sort((a, b) => b.similarity - a.similarity);

  console.log("\n🔮 Failure Predictions:");
  console.log(`${"Similarity".padStart(10)} ${"Surprise".padStart(9)}  Source            Pattern`);
  console.log(`${"-".repeat(10)} ${"-".repeat(9)}  ${"-".repeat(16)}  ${"-".repeat(40)}`);
  
  for (const r of results.slice(0, 10)) {
    if (r.similarity < 0.1) continue;
    const icon = r.surprise > 0.85 ? "\u{1F534}" : r.surprise > 0.7 ? "\u{1F7E1}" : "\u{1F7E2}";
    const s = `${icon} ${(r.similarity * 100).toFixed(0)}%`.padStart(10);
    const su = `${(r.surprise * 100).toFixed(0)}%`.padStart(9);
    const src = r.source.slice(0, 16).padEnd(16);
    console.log(`${s} ${su}  ${src} ${r.label.slice(0, 40)}`);
  }
}

/** Export model as a JSON blob for another project to consume */
function exportModel(): void {
  const model = loadModel();
  const outPath = join(HERMES_HOME, "harness", "world-model.publish.json");
  writeFileSync(outPath, JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    total_patterns: model.total_observations,
    clusters: model.clusters.map(c => ({
      id: c.pattern_id,
      label: c.label,
      source: c.source,
      category: c.category,
    })),
    vocabulary: model.vocabulary,
    // Clients use same encode() function with this vocabulary
  }, null, 2));
  console.log(`Exported to ${outPath}`);
}

// ── SUMMARY ───────────────────────────────────────────────────────

function summary(): void {
  const model = loadModel();
  console.log(`\nWorld Model Summary`);
  console.log(`${"=".repeat(50)}`);
  console.log(`  Observations:    ${model.total_observations}`);
  console.log(`  Clusters:        ${model.clusters.length}`);
  console.log(`  Vocabulary dims: ${model.vocabulary.length}`);
  console.log(`  Last updated:    ${model.last_updated || "never"}`);
  
  if (model.clusters.length > 0) {
    console.log(`\n  Sources:`);
    const srcCount = new Map<string, number>();
    for (const c of model.clusters) {
      srcCount.set(c.source, (srcCount.get(c.source) || 0) + 1);
    }
    for (const [src, count] of [...srcCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${src.padEnd(20)} ${count} patterns`);
    }
    
    console.log(`\n  Categories:`);
    const catCount = new Map<string, number>();
    for (const c of model.clusters) {
      catCount.set(c.category, (catCount.get(c.category) || 0) + 1);
    }
    for (const [cat, count] of [...catCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cat.padEnd(12)} ${count} patterns`);
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────

const cmd = process.argv[2] || "summary";
switch (cmd) {
  case "train":
    train();
    break;
  case "evaluate":
  case "predict":
    predict(process.argv.slice(3).join(" ") || "new agent session");
    break;
  case "export":
    exportModel();
    break;
  case "summary":
  default:
    summary();
    break;
}
