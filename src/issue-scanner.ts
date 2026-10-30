/**
 * issue-scanner.ts — Scans configured repositories for open issues
 * 
 * Part of the Self-Harness loop. Runs every cycle.
 * Set HARNESS_GITHUB_REPOS to choose which repositories to scan.
 */

import { callFreeLLM } from "./harness";
import { execSync } from "child_process";
import { FIXES_DIR } from "./config";

// Get GitHub token from gh CLI (most reliable source)
function getToken(): string {
  try {
    return execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  }
}

const TOKEN = getToken();

interface TargetIssue {
  number: number;
  repo: string;
  owner: string;
  title: string;
  body: string;
  labels: string[];
  url: string;
  repo_path?: string;
}

const TARGET_REPOS = (process.env.HARNESS_GITHUB_REPOS || "")
  .split(",")
  .map(value => value.trim())
  .filter(value => /^[^/]+\/[^/]+$/.test(value));

/** Fetch issues for a single repo */
async function fetchRepoIssues(owner: string, repo: string): Promise<TargetIssue[]> {
  const issues: TargetIssue[] = [];
  const url = `https://api.github.com/search/issues?q=repo:${owner}/${repo}+state:open+type:issue&per_page=5&sort=updated`;
  const resp = await fetch(url, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
  if (!resp.ok) return issues;
  const data = await resp.json() as any;
  for (const item of (data.items || [])) {
    issues.push({
      number: item.number,
      repo,
      owner,
      title: item.title,
      body: (item.body || "").slice(0, 2000),
      labels: (item.labels || []).map((l: any) => l.name),
      url: item.html_url,
      repo_path: "",
    });
  }
  return issues;
}

/** Prioritise: bugs > help-wanted > small features > everything else */
function scoreIssue(issue: TargetIssue): number {
  let score = 0;
  const ls = issue.labels.map(l => l.toLowerCase());
  if (ls.includes("bug")) score += 5;
  if (ls.includes("help wanted") || ls.includes("help-wanted")) score += 4;
  if (ls.includes("good first issue")) score += 3;
  if (ls.includes("documentation")) score += 2;
  if (issue.body.length < 100) score -= 1; // too vague
  return score;
}

/** Classify + attempt fix */
async function processIssue(issue: TargetIssue): Promise<void> {
  const repoPath = "";

  const prompt = `You are an open-source contributor. Given this GitHub issue, determine if you can fix it:

Repo: ${issue.owner}/${issue.repo}
Title: ${issue.title}
Description: ${issue.body.slice(0, 1200)}
Labels: ${issue.labels.join(", ")}

Return JSON:
{ "fixable": true/false,
  "approach": "what needs to change and how",
  "files": ["list", "of", "files", "likely", "to", "modify"],
  "confidence": 0.0-1.0 }

Mark fixable if:
- It's a bug with a clear expected behaviour
- A small feature with a defined interface
- A documentation improvement with known gaps
- Config/CI fix

Mark NOT fixable if:
- Requires domain expertise you lack
- Architectural design decision
- Needs human judgement on user-facing text/UX
- The description is too vague to act on`;

  const raw = await callFreeLLM(prompt);
  let result: any;
  try { result = JSON.parse(raw); } catch { 
    console.log(`  ⚠️ Parse failed: ${raw.slice(0, 100)}`);
    return; 
  }
  
  if (!result?.fixable || (result.confidence || 0) < 0.4) {
    console.log(`  ↪ Skipping (fixable=${result?.fixable}, confidence=${result?.confidence})`);
    return;
  }

  console.log(`  ✅ Fixable — ${result.approach?.slice(0, 100)}`);

  // Generate the actual patch
  const patchPrompt = `Generate a fix for this GitHub issue:

Issue: ${issue.title}
Description: ${issue.body.slice(0, 1000)}
Approach: ${result.approach}
Repo: ${issue.owner}/${issue.repo}${repoPath ? `\nLocal: ${repoPath}` : ""}

Return JSON array of patches:
[{ "file": "relative/path/to/file",
   "old_string": "exact text to replace",
   "new_string": "replacement text" }]

Keep patches minimal — smallest possible change.`;

  const patchRaw = await callFreeLLM(patchPrompt, "You are a precise code fixer. Raw JSON only.");
  let patches: any;
  try { patches = JSON.parse(patchRaw); } catch { return; }

  // Save the fix
  const { writeFileSync, mkdirSync } = await import("fs");
  const { join } = await import("path");
  const outDir = FIXES_DIR;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${issue.owner}-${issue.repo}-${issue.number}.json`),
    JSON.stringify({ issue, patches, approach: result.approach, generated_at: new Date().toISOString() }, null, 2)
  );
  console.log(`  📝 Fix saved → ${outDir}/${issue.owner}-${issue.repo}-${issue.number}.json`);
}

async function main() {
  console.log("🔍 Scanning issues...");
  let allIssues: TargetIssue[] = [];

  if (TARGET_REPOS.length === 0) {
    console.log("No targets configured. Set HARNESS_GITHUB_REPOS=owner/repo,owner/repo.");
    return;
  }
  for (const target of TARGET_REPOS) {
    const [owner, repo] = target.split("/");
    allIssues.push(...await fetchRepoIssues(owner, repo));
  }

  // Deduplicate by number+repo
  const seen = new Set<string>();
  allIssues = allIssues.filter(i => {
    const k = `${i.owner}/${i.repo}#${i.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`Found ${allIssues.length} open issues across ${TARGET_REPOS.length} configured repositories`);

  // Sort by score — best candidates first
  allIssues.sort((a, b) => scoreIssue(b) - scoreIssue(a));

  let processed = 0;
  for (const issue of allIssues) {
    if (processed >= 5) {
      console.log("\nReached batch limit (5) — next cycle will continue");
      break;
    }
    console.log(`\n--- ${issue.owner}/${issue.repo}#${issue.number}: ${issue.title.slice(0, 60)} ---`);
    await processIssue(issue);
    processed++;
  }
}

main().catch(console.error);
