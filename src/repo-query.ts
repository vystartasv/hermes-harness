/**
 * repo-query.ts — Query every repo-as-world-model for patterns matching a context
 * 
 * Each repo model knows its own lifecycle patterns. This tool queries ALL of them
 * and returns the best matches across repositories.
 * 
 * Usage: bun run src/repo-query.ts "ado auth keeps timing out in pipeline"
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { cosineSimilarity } from "./harness";

const REPO_MODELS_DIR = join(homedir(), ".hermes", "harness", "repo-models");

interface RepoModel {
  name: string;
  path: string;
  total_commits: number;
  file_coupling: Record<string, string[]>;
  lifecycles: { type: string; pattern: string; description: string; confidence: number }[];
  patterns: string[];
  last_analyzed: string;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function matchScore(contextTokens: string[], text: string): number {
  const lower = text.toLowerCase();
  const matches = contextTokens.filter(t => lower.includes(t)).length;
  return contextTokens.length > 0 ? matches / contextTokens.length : 0;
}

function main() {
  const context = process.argv.slice(2).join(" ");
  if (!context) {
    console.error("Usage: bun run src/repo-query.ts <search context>");
    console.error("Example: bun run src/repo-query.ts \"deploy pipeline auth timeout\"");
    process.exit(1);
  }

  if (!existsSync(REPO_MODELS_DIR)) {
    console.log("No repo models built yet. Run self-improve loop first.");
    process.exit(0);
  }

  const models = readdirSync(REPO_MODELS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(REPO_MODELS_DIR, f), "utf-8")) as RepoModel);

  const tokens = tokenize(context);
  
  interface Hit {
    model: string;
    commits: number;
    pattern: string;
    description: string;
    type: string;
    score: number;
  }

  const hits: Hit[] = [];

  for (const model of models) {
    for (const lc of model.lifecycles || []) {
      const score = matchScore(tokens, `${lc.type} ${lc.pattern} ${lc.description}`);
      if (score > 0) {
        hits.push({
          model: model.name,
          commits: model.total_commits,
          pattern: lc.pattern,
          description: lc.description.slice(0, 120),
          type: lc.type,
          score,
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);

  if (hits.length === 0) {
    console.log(`No matching patterns for: ${context}`);
    return;
  }

  console.log(`\n🔍 Query: "${context}"`);
  console.log(`Found ${hits.length} matches across ${models.length} repo models\n`);

  const byModel = new Map<string, Hit[]>();
  for (const h of hits.slice(0, 20)) {
    if (!byModel.has(h.model)) byModel.set(h.model, []);
    byModel.get(h.model)!.push(h);
  }

  for (const [model, modelHits] of byModel) {
    const m = models.find(m => m.name === model)!;
    console.log(`📦 ${model} (${m?.total_commits || "?"} commits, ${m?.lifecycles?.length || 0} lifecycles)`);
    for (const h of modelHits.slice(0, 5)) {
      const bar = "█".repeat(Math.max(1, Math.round(h.score * 10)));
      const pct = (h.score * 100).toFixed(0);
      console.log(`  ${bar} ${pct}%  [${h.type}] ${h.pattern.slice(0, 70)}`);
      console.log(`           ${h.description.slice(0, 80)}`);
    }
    console.log();
  }
}

main();
