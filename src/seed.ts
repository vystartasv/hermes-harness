/**
 * seed.ts — Harvest public repos to seed the world model
 * 
 * Clones curated public OSS repos, mines their full lifecycle,
 * builds a world model that anyone can query.
 * 
 * No private data. Only public repos with permissive licenses.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { callFreeLLM } from "./harness";
import { SEED_DIR, SEED_STATE, SEED_OUTPUT, MODELS_DIR, DATA_DIR } from "./config";

const OUTPUT_MODEL = SEED_OUTPUT;
const STATE_FILE = SEED_STATE;
const SEED_REPOS_DIR = SEED_DIR;

// Curated public repos — rich lifecycles, permissive licenses, high signal
const PUBLIC_REPOS = [
  // Agent/LLM frameworks — high churn, lots of issues
  { url: "https://github.com/langchain-ai/langchain.git", name: "langchain" },
  { url: "https://github.com/nicegui-dev/nicegui.git", name: "nicegui" },
  { url: "https://github.com/mckaywrigley/chatbot-ui.git", name: "chatbot-ui" },
  
  // Web frameworks — huge commit history, clear patterns
  { url: "https://github.com/vercel/next.js.git", name: "nextjs" },
  { url: "https://github.com/sveltejs/svelte.git", name: "svelte" },
  { url: "https://github.com/vitejs/vite.git", name: "vite" },
  
  // Infrastructure — revert-heavy, lots of lifecycle data
  { url: "https://github.com/n8n-io/n8n.git", name: "n8n" },
  { url: "https://github.com/appsmithorg/appsmith.git", name: "appsmith" },
  { url: "https://github.com/supabase/supabase.git", name: "supabase" },

  // Testing/quality — bug patterns are the signal
  { url: "https://github.com/playwright-community/playwright-go.git", name: "playwright-go" },
  
  // Developer tools — rich issue/PR lifecycle
  { url: "https://github.com/nrwl/nx.git", name: "nx" },
  { url: "https://github.com/biomejs/biome.git", name: "biome" },
];

interface SeedState {
  cloned: string[];
  mined: string[];
  patterns_found: number;
}

function loadState(): SeedState {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
  catch { return { cloned: [], mined: [], patterns_found: 0 }; }
}

function saveState(s: SeedState) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Clone phase ──

function cloneRepos(state: SeedState): void {
  mkdirSync(SEED_DIR, { recursive: true });
  
  for (const repo of PUBLIC_REPOS) {
    const target = join(SEED_DIR, repo.name);
    if (existsSync(join(target, ".git"))) {
      state.cloned.push(repo.name);
      continue;
    }
    
    console.log(`Cloning ${repo.name}...`);
    try {
      // Shallow clone — only need recent history for patterns
      execSync(
        `cd "${SEED_DIR}" && git clone --depth=500 "${repo.url}" "${repo.name}" 2>/dev/null`,
        { encoding: "utf-8", timeout: 120000 }
      );
      state.cloned.push(repo.name);
      console.log(`  ✅ ${repo.name} cloned`);
    } catch (e: any) {
      console.log(`  ⚠️ ${repo.name} clone failed: ${e.message.slice(0, 60)}`);
    }
  }
}

// ── Mine phase ──

interface Commit {
  hash: string;
  subject: string;
  body: string;
  files: string[];
  parents: string[];
  date: string;
}

function getCommits(repoPath: string): Commit[] {
  try {
    const cmd = `cd "${repoPath}" && git log --max-count=200 --format="☕%H│%ai│%P│%s│%b☕" --name-only 2>/dev/null`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    
    const blocks = output.split("☕").filter((b: string) => b.trim());
    return blocks.map((block: string) => {
      const lines = block.trim().split("\n");
      const header = lines[0].split("│");
      if (header.length < 4) return null;
      const [hash, date, parents, subject] = header;
      const bodyEnd = lines.findIndex((l: string) => l.trim().length > 0 && lines.indexOf(l) > 0);
      const body = bodyEnd > 0 ? lines.slice(1, bodyEnd).join("\n").trim() : "";
      const files = lines.slice(bodyEnd > 0 ? bodyEnd : 1).filter((f: string) => f.trim() && !f.startsWith("│"));
      return { hash, date, parents: parents ? parents.split(" ") : [], subject: subject.slice(0, 200), body: body.slice(0, 500), files: files.slice(0, 20) };
    }).filter(Boolean) as Commit[];
  } catch { return []; }
}

function detectReverts(commits: Commit[]): any[] {
  const reverts: any[] = [];
  for (let i = 0; i < commits.length - 1; i++) {
    if (commits[i].subject.toLowerCase().startsWith("revert")) {
      const reverted = commits[i + 1];
      reverts.push({
        type: "revert",
        pattern: `${reverted.subject.slice(0, 80)} (was reverted)`,
        description: `${reverted.subject.slice(0, 100)} was rolled back — fix was incomplete`,
        confidence: 0.9,
      });
    }
  }
  return reverts;
}

async function extractPatterns(repoName: string, commits: Commit[]): Promise<any[]> {
  const patterns: any[] = [...detectReverts(commits)];
  
  if (commits.length < 5) return patterns;
  
  const compressed = commits.map(c => `${c.subject.slice(0, 80)} | ${c.files.length} files`).join("\n");
  
  const prompt = `Analyze these commits from the OSS project "${repoName}" for RECURRING lifecycle patterns:

${compressed.slice(0, 3000)}

Return JSON:
{ "lifecycles": [
    { "type": "bug|fix|revert|config|dependency|test|pattern",
      "pattern": "short descriptive name of the pattern",
      "description": "what pattern emerges and why it matters",
      "confidence": 0-1 }
  ]
}

Focus on patterns that repeat. Skip unique one-off commits.`;

  const raw = await callFreeLLM(prompt);
  try {
    const parsed = JSON.parse(raw);
    if (parsed.lifecycles) patterns.push(...parsed.lifecycles);
  } catch {}
  
  return patterns;
}

async function mineRepos(state: SeedState): Promise<void> {
  const allPatterns: any[] = [];
  const repoModels: any[] = [];
  
  for (const repo of PUBLIC_REPOS) {
    if (state.mined.includes(repo.name)) continue;
    
    const repoPath = join(SEED_DIR, repo.name);
    if (!existsSync(join(repoPath, ".git"))) continue;
    
    console.log(`\nMining ${repo.name}...`);
    const commits = getCommits(repoPath);
    if (commits.length === 0) { console.log(`  No commits`); continue; }
    
    console.log(`  ${commits.length} commits`);
    const patterns = await extractPatterns(repo.name, commits);
    console.log(`  ${patterns.length} patterns extracted`);
    
    if (patterns.length > 0) {
      allPatterns.push(...patterns.map((p: any) => ({ ...p, source: repo.name })));
    }
    
    repoModels.push({
      name: repo.name,
      total_commits: commits.length,
      lifecycles: patterns,
    });
    
    state.mined.push(repo.name);
    saveState(state);
  }
  
  // Build world model
  const vocabulary = buildVocabulary(allPatterns);
  const clusters = allPatterns.map((p, i) => ({
    pattern_id: `${p.source}:${p.pattern.slice(0, 40)}`,
    centroid: encode(`${p.type} ${p.pattern} ${p.description}`, vocabulary),
    variance: 0.1,
    count: 1,
    label: p.pattern.slice(0, 60),
    source: p.source,
    category: p.type,
  }));
  
  const model = {
    version: 2,
    seed: true,
    generated_at: new Date().toISOString(),
    total_repos: repoModels.length,
    total_patterns: allPatterns.length,
    vocabulary,
    clusters,
    repo_models: repoModels,
  };
  
  writeFileSync(OUTPUT_MODEL, JSON.stringify(model, null, 2));
  console.log(`\n✅ Seed world model saved: ${allPatterns.length} patterns across ${repoModels.length} repos`);
}

function buildVocabulary(patterns: any[], dim = 128): string[] {
  const freq = new Map<string, number>();
  for (const p of patterns) {
    for (const w of `${p.type} ${p.pattern} ${p.description}`.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter((w: string) => w.length > 2)) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, dim).map(e => e[0]);
}

function encode(text: string, vocabulary: string[]): number[] {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter((w: string) => w.length > 2);
  const vec = new Array(vocabulary.length).fill(0);
  for (const t of tokens) {
    const idx = vocabulary.indexOf(t);
    if (idx >= 0) vec[idx] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
  return mag > 0 ? vec.map(v => v / mag) : vec;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

function queryModel(context: string, model: any): void {
  const emb = encode(context, model.vocabulary);
  const results = model.clusters
    .map((c: any) => ({ ...c, similarity: cosineSimilarity(c.centroid, emb) }))
    .filter((r: any) => r.similarity > 0.1)
    .sort((a: any, b: any) => b.similarity - a.similarity);
  
  if (results.length === 0) { console.log("No matches"); return; }
  
  console.log(`\n🔍 "${context}" — ${results.length} matches across ${model.total_repos} public repos\n`);
  for (const r of results.slice(0, 8)) {
    const bar = "█".repeat(Math.max(1, Math.round(r.similarity * 20)));
    const pct = (r.similarity * 100).toFixed(0);
    console.log(`  ${bar} ${pct}%  [${r.source}] ${r.label.slice(0, 60)}`);
  }
}

// ── CLI ──

const cmd = process.argv[2] || "harvest";
const state = loadState();

switch (cmd) {
  case "harvest":
    console.log("🌱 Harvesting public repos for seed world model...\n");
    cloneRepos(state);
    await mineRepos(state);
    break;
    
  case "query":
    const ctx = process.argv.slice(3).join(" ") || "build fails on CI";
    if (!existsSync(OUTPUT_MODEL)) {
      console.error("Seed model not found. Run `hermes-harness seed-harvest` first.");
      process.exitCode = 1;
      break;
    }
    const model = JSON.parse(readFileSync(OUTPUT_MODEL, "utf-8"));
    queryModel(ctx, model);
    break;
    
  case "export":
    if (!existsSync(SEED_OUTPUT)) {
      console.error("Seed model not found. Run `hermes-harness seed-harvest` first.");
      process.exitCode = 1;
      break;
    }
    const m = JSON.parse(readFileSync(SEED_OUTPUT, "utf-8"));
    // Strip repo_models for lightweight export
    const exportModel = {
      version: m.version,
      seed: true,
      generated_at: m.generated_at,
      total_patterns: m.total_patterns,
      total_repos: m.total_repos,
      vocabulary: m.vocabulary,
      clusters: m.clusters.map((c: any) => ({
        pattern_id: c.pattern_id,
        label: c.label,
        source: c.source,
        category: c.category,
        centroid: c.centroid,
      })),
    };
    const PUBLISH_FILE = join(DATA_DIR, "seed-world-model.publish.json");
    writeFileSync(PUBLISH_FILE, JSON.stringify(exportModel, null, 2));
    console.log(`Exported: ${exportModel.total_patterns} patterns, ${exportModel.vocabulary.length}-dim vocabulary`);
    break;
    
  default:
    console.log("Commands: harvest (clone+mine), query <text>, export");
}
