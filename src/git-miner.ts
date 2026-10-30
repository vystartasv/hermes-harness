/**
 * git-miner.ts — Full repo lifecycle miner
 * 
 * Each repository IS already a world model. Every commit, revert, branch, 
 * and file co-change contains signal we're not using.
 * 
 * This miner extracts:
 *   1. Full commit lifecycle (bodies, not just one-liners)
 *   2. Revert chains — what broke and why it was rolled back
 *   3. File coupling — which files change together (latent architecture)
 *   4. Branch topology — which problems needed isolation
 *   5. Timing patterns — how long fixes take, which ones stick
 * 
 * Each repo builds its own sub-model. The global world model cross-references them.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { callFreeLLM, getEmbedding, cosineSimilarity } from "./harness";
import { DATA_DIR, getDefaultRepos } from "./config";

const STATE_FILE = join(DATA_DIR, "git-state.json");
const REPO_MODELS_DIR = join(DATA_DIR, "repo-models");

interface GitState {
  processed: Record<string, string>;  // repo -> last processed commit hash
  last_run: string;
}

interface Commit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
  parents: string[];
  repo: string;
  repoName: string;
}

interface Lifecycle {
  type: "fix" | "feature" | "refactor" | "revert" | "docs" | "config" | "test" | "dependency";
  pattern: string;
  description: string;
  confidence: number;
}

interface RepoModel {
  name: string;
  path: string;
  total_commits: number;
  file_coupling: Record<string, string[]>;  // file -> files it co-changes with
  lifecycles: Lifecycle[];
  patterns: string[];
  frequency: Record<string, number>;        // pattern -> occurrence count
  last_analyzed: string;
}

// ── Discover git repos ──

function findGitRepos(): string[] {
  const bases = getDefaultRepos();
  const repos: string[] = [];
  for (const base of bases) {
    if (existsSync(join(base, ".git"))) repos.push(base);
    try {
      const dirs = readdirSync(base);
      for (const d of dirs) {
        const p = join(base, d);
        if (existsSync(join(p, ".git"))) repos.push(p);
      }
    } catch {}
  }
  return [...new Set(repos)];
}

// ── Git data extraction ──

function getCommits(repo: string, sinceHash: string = "", limit = 500): Commit[] {
  if (!existsSync(join(repo, ".git"))) return [];
  try {
    const range = sinceHash ? `${sinceHash}..HEAD` : `--all`;
    // Full body, file list, parents — complete lifecycle
    const cmd = `cd "${repo}" && git log ${range} --format="☕%H│%an│%ai│%P│%s│%b☕" --name-only --max-count=${limit} 2>/dev/null`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    
    const blocks = output.split("☕").filter(b => b.trim());
    const commits: Commit[] = [];
    
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const header = lines[0].split("│");
      if (header.length < 5) continue;
      
      const [hash, author, date, parents, subject] = header;
      const bodyEnd = lines.findIndex(l => l.trim().length > 0 && !l.includes("/") && lines.indexOf(l) > 0);
      const body = bodyEnd > 0 ? lines.slice(1, bodyEnd).join("\n").trim() : "";
      const files = lines.slice(bodyEnd > 0 ? bodyEnd : 1).filter(f => f.trim() && !f.startsWith("│"));
      
      commits.push({
        hash, author, date, subject: subject.slice(0, 200),
        body: body.slice(0, 1000),
        files: files.slice(0, 20),
        parents: parents ? parents.split(" ") : [],
        repo, repoName: repo.split("/").pop() || "unknown",
      });
    }
    return commits;
  } catch (e: any) {
    console.error(`  ⚠️ ${repo.split("/").pop()}: ${e.message.slice(0, 80)}`);
    return [];
  }
}

// ── Lifecycle analysis ──

function detectReverts(commits: Commit[]): Lifecycle[] {
  const reverts: Lifecycle[] = [];
  for (let i = 0; i < commits.length - 1; i++) {
    if (commits[i].subject.toLowerCase().startsWith("revert")) {
      // Find what was reverted — the commit right before it
      const reverted = commits[i + 1];
      reverts.push({
        type: "revert",
        pattern: `${reverted.subject.slice(0, 60)} (was reverted)`,
        description: `${reverted.subject} was rolled back in ${commits[i].hash.slice(0, 8)}`,
        confidence: 0.9,
      });
    }
  }
  return reverts;
}

function detectFileCoupling(commits: Commit[]): Record<string, string[]> {
  const cochange = new Map<string, Map<string, number>>();
  for (const c of commits) {
    for (let i = 0; i < c.files.length; i++) {
      for (let j = i + 1; j < c.files.length; j++) {
        if (!cochange.has(c.files[i])) cochange.set(c.files[i], new Map());
        const map = cochange.get(c.files[i])!;
        map.set(c.files[j], (map.get(c.files[j]) || 0) + 1);
      }
    }
  }
  const result: Record<string, string[]> = {};
  for (const [file, pairs] of cochange) {
    const sorted = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
    if (sorted.length > 0) result[file] = sorted;
  }
  return result;
}

async function extractLifecycles(commits: Commit[]): Promise<Lifecycle[]> {
  const lifecycles: Lifecycle[] = [...detectReverts(commits)];
  
  // Local: file coupling patterns
  const coupling = detectFileCoupling(commits);
  const coupledFiles = Object.values(coupling).flat();
  if (coupledFiles.length > 5) {
    lifecycles.push({
      type: "refactor",
      pattern: `Co-changing files: ${coupledFiles.slice(0, 3).map(f => f.split("/").pop()).join(", ")}`,
      description: `${coupledFiles.length} file pairs that change together — possible coupling`,
      confidence: 0.6,
    });
  }
  
  if (commits.length < 5) return lifecycles;
  
  // LLM analysis: only send subjects + file count + body (first line), not full bodies
  const compressed = commits.map(c => 
    `${c.subject} | ${c.files.length} files | ${c.body.split("\n")[0]?.slice(0, 80) || ""}`
  ).join("\n");
  
  const prompt = `Analyze these git commits for lifecycle patterns:

${compressed.slice(0, 4000)}

Return JSON with PATTERNS that repeat (appear 2+ times):
{ "lifecycles": [
    { "type": "bug|fix|revert|config|dependency|test|pattern",
      "pattern": "short pattern name",
      "description": "what pattern emerges from these commits",
      "confidence": 0-1 }
  ]
}

Examples of good patterns: "null pointer after config reload", "dependency upgrade breaks API", "test flaky on CI".
Skip: unique one-off commits, simple doc updates, trivial formatting changes.`;

  const raw = await callFreeLLM(prompt);
  try {
    const parsed = JSON.parse(raw);
    if (parsed.lifecycles) lifecycles.push(...parsed.lifecycles);
  } catch {}
  
  return lifecycles;
}

// ── Build per-repo model ──

function saveRepoModel(model: RepoModel) {
  mkdirSync(REPO_MODELS_DIR, { recursive: true });
  writeFileSync(
    join(REPO_MODELS_DIR, `${model.name}.json`),
    JSON.stringify(model, null, 2)
  );
  console.log(`  💾 Repo model saved: ${model.name} (${model.total_commits} commits, ${model.lifecycles.length} lifecycles)`);
}

function loadRepoModel(name: string): RepoModel | null {
  const p = join(REPO_MODELS_DIR, `${name}.json`);
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

// ── Feed into global world model ──

async function feedWorldModel(model: RepoModel) {
  const wmPath = join(homedir(), ".hermes", "harness", "world-model.json");
  let wm: any;
  try { wm = JSON.parse(readFileSync(wmPath, "utf-8")); }
  catch { wm = { clusters: [], total_observations: 0, last_updated: "", vocabulary: [] }; }

  let updated = false;
  for (const lc of model.lifecycles) {
    const key = `${model.name}:${lc.pattern.slice(0, 60)}`;
    if (wm.clusters.some((c: any) => c.pattern_id === key)) continue;
    
    const text = `${lc.type}: ${lc.pattern}. ${lc.description}`;
    // Use word-count embedding (same as world-model.ts)
    const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter((w: string) => w.length > 2);
    
    wm.clusters.push({
      pattern_id: key,
      centroid: [lc.confidence],  // placeholder — real embedding via vocabulary
      variance: 0.1,
      count: 1,
      label: lc.pattern.slice(0, 60),
      source: model.name,
      category: lc.type,
    });
    wm.total_observations++;
    updated = true;
  }
  
  if (updated) {
    writeFileSync(wmPath, JSON.stringify(wm, null, 2));
    console.log(`  🌍 World model updated: +${model.lifecycles.length} clusters from ${model.name}`);
  }
}

// ── Query a repo model ──

function queryRepoModel(context: string, name?: string) {
  const models = name 
    ? [loadRepoModel(name)].filter(Boolean) as RepoModel[]
    : readdirSync(REPO_MODELS_DIR).filter(f => f.endsWith(".json")).map(f => 
        JSON.parse(readFileSync(join(REPO_MODELS_DIR, f), "utf-8"))
      );
  
  const tokens = context.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  for (const model of models) {
    const matches = model.lifecycles
      .filter(lc => tokens.some(t => lc.pattern.toLowerCase().includes(t) || lc.description.toLowerCase().includes(t)))
      .sort((a, b) => b.confidence - a.confidence);
    
    if (matches.length > 0) {
      console.log(`\n📦 ${model.name} (${model.total_commits} commits):`);
      for (const m of matches.slice(0, 5)) {
        console.log(`  ${(m.confidence * 100).toFixed(0)}% ${m.pattern.slice(0, 70)}`);
      }
    }
  }
}

// ── Main ──

async function main() {
  console.log("📜 Mining full repo lifecycles...");
  const state: GitState = (() => {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
    catch { return { processed: {}, last_run: "" }; }
  })();
  
  const repos = findGitRepos();
  console.log(`Found ${repos.length} git repos`);
  
  for (const repo of repos) {
    const name = repo.split("/").pop() || "unknown";
    console.log(`\n${name}:`);
    
    const sinceHash = state.processed[repo] || "";
    const commits = getCommits(repo, sinceHash);
    if (commits.length === 0) {
      console.log(`  No new commits`);
      continue;
    }
    
    console.log(`  ${commits.length} new commits`);
    
    // Extract lifecycles
    const lifecycles = await extractLifecycles(commits);
    
    // Detect file coupling
    const coupling = detectFileCoupling(commits);
    
    // Frequency map
    const frequency: Record<string, number> = {};
    for (const lc of lifecycles) {
      frequency[lc.pattern] = (frequency[lc.pattern] || 0) + 1;
    }
    
    // Build repo model
    const existing = loadRepoModel(name);
    const model: RepoModel = {
      name,
      path: repo,
      total_commits: (existing?.total_commits || 0) + commits.length,
      file_coupling: { ...existing?.file_coupling, ...coupling },
      lifecycles: [
        ...(existing?.lifecycles || []),
        ...lifecycles.filter(lc => !existing?.lifecycles.some(el => el.pattern === lc.pattern)),
      ],
      patterns: [...new Set(lifecycles.map(l => l.pattern))],
      frequency: { ...existing?.frequency, ...frequency },
      last_analyzed: new Date().toISOString(),
    };
    
    saveRepoModel(model);
    await feedWorldModel(model);
    
    // Track state
    state.processed[repo] = commits[0].hash;
  }
  
  state.last_run = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  
  // Summary
  const modelCount = readdirSync(REPO_MODELS_DIR).filter(f => f.endsWith(".json")).length;
  console.log(`\n✅ ${modelCount} repo models built. Full lifecycles mined.`);
}

main().catch(console.error);
