/**
 * post-session.ts — Self-Harness failure mining loop
 * Wired to Hermes cron, runs after every session.
 * Free OpenRouter models do all the thinking.
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { callFreeLLM, getEmbedding, cosineSimilarity, FailurePattern, HarnessProposal } from "./harness";

const HERMES_HOME = join(homedir(), ".hermes");
const STATE_FILE = join(HERMES_HOME, "harness", "state.json");
const KNOWLEDGE_DIR = join(HERMES_HOME, "knowledge");
const SESSIONS_DIR = join(HERMES_HOME, "sessions");

interface HarnessState {
  patterns: FailurePattern[];
  proposals_applied: number;
  last_run: string;
  total_sessions_analyzed: number;
}

function loadState(): HarnessState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { patterns: [], proposals_applied: 0, last_run: "", total_sessions_analyzed: 0 };
  }
}

function saveState(s: HarnessState) {
  mkdirSync(join(HERMES_HOME, "harness"), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** Find the most recent session transcript */
function findLatestSession(): { path: string; id: string } | null {
  if (!existsSync(SESSIONS_DIR)) return null;
  const entries = readdirSync(SESSIONS_DIR);
  const files = entries.filter(f => f.endsWith(".jsonl"));
  if (files.length === 0) return null;
  files.sort().reverse();
  const latest = files[0];
  return { path: join(SESSIONS_DIR, latest), id: latest.replace(".jsonl", "") };
}

/** Mine session for failures via free LLM */
async function mineFailures(transcript: string): Promise<FailurePattern[]> {
  const prompt = `Analyze this agent session transcript for failure patterns.
Focus on:
1. User corrections — what did the user correct? Why?
2. Tool errors — what tools failed? In what context?
3. Retries — how many retries happened? Why?
4. Context loss — did the agent lose track of something?

Return a JSON array of failure patterns:
[{ "category": "tool_error|context_loss|wrong_model|config_miss|skill_gap|repeated_correction",
   "title": "short title",
   "description": "specific description of the pattern",
   "count": 1 }]

Transcript (last 50 messages):
${transcript.slice(-10000)}`;

  const raw = await callFreeLLM(prompt);
  try {
    return JSON.parse(raw);
  } catch {
    console.error("Failed to parse LLM response:", raw.slice(0, 200));
    return [];
  }
}

/** Check if a new pattern matches known ones via embedding similarity */
function matchKnownPattern(newPattern: FailurePattern, state: HarnessState): FailurePattern | null {
  // Simple keyword overlap for now; true JEPA comes in world-model.ts
  for (const known of state.patterns) {
    const overlap = known.title.split(" ").filter(w => newPattern.title.includes(w)).length;
    if (overlap / Math.max(known.title.split(" ").length, 1) > 0.5) return known;
  }
  return null;
}

/** Generate fix proposal from failure pattern */
async function proposeFix(pattern: FailurePattern): Promise<HarnessProposal | null> {
  const prompt = `Given this failure pattern from an agent session, propose a concrete fix:

Pattern: ${pattern.title}
Description: ${pattern.description}
Category: ${pattern.category}

Return a JSON fix proposal:
{ "type": "skill_update|memory_add|hermes_pr|config_change",
  "target": "what file/skill to change",
  "reason": "why this fix works",
  "content": "the content to add or change (for skill/memory)",
  "confidence": 0.0-1.0 }

If no clear fix is possible, return null.`;

  const raw = await callFreeLLM(prompt);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Validate a proposal against past corrections */
async function validateProposal(proposal: HarnessProposal, state: HarnessState): Promise<boolean> {
  if (proposal.confidence < 0.3) return false;
  if (state.patterns.some(p => {
    // Check we're not re-proposing the same fix
    return p.title.includes(proposal.reason.slice(0, 40));
  })) return false;
  return true;
}

/** Apply a fix: update skills, add memory, or queue Hermes PR */
function applyFix(proposal: HarnessProposal) {
  switch (proposal.type) {
    case "skill_update":
      // Write to skills dir for Hermes to pick up
      const skillsDir = join(HERMES_HOME, "skills", "harness-auto");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, `${proposal.target.replace(/[^a-z0-9]/g, "-")}.md`),
        `---\nname: ${proposal.target}\ndescription: "Auto-generated from harness self-improvement"\n---\n\n${proposal.content}\n`
      );
      console.log(`✅ Skill created: ${proposal.target}`);
      break;

    case "memory_add":
      // Append to knowledge base
      const memDir = join(HERMES_HOME, "knowledge");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(
        join(memDir, `harness-${Date.now()}.md`),
        `## domain\nharness\n## pattern\n${proposal.target}\n\n${proposal.content}\n`
      );
      console.log(`✅ Memory added: ${proposal.target}`);
      break;

    case "hermes_pr":
      // Log PR request for PR creator
      const prDir = join(HERMES_HOME, "harness", "pending-prs");
      mkdirSync(prDir, { recursive: true });
      writeFileSync(
        join(prDir, `${Date.now()}-${proposal.target.replace(/[^a-z0-9]/g, "-")}.json`),
        JSON.stringify(proposal, null, 2)
      );
      console.log(`📝 PR queued: ${proposal.target}`);
      break;

    case "config_change":
      console.log(`⚙️ Config change suggested: ${proposal.target} — ${proposal.reason}`);
      break;
  }
}

/** Main loop */
async function main() {
  const session = findLatestSession();
  if (!session) {
    console.log("No sessions found");
    return;
  }

  const state = loadState();
  if (state.last_run === session.id) {
    console.log(`Session ${session.id} already analyzed`);
    return;
  }

  console.log(`Analyzing session: ${session.id}`);
  const transcript = readFileSync(session.path, "utf-8");

  const newPatterns = await mineFailures(transcript);
  if (newPatterns.length === 0) {
    console.log("No new failure patterns found");
    state.last_run = session.id;
    saveState(state);
    return;
  }

  for (const pattern of newPatterns) {
    const matched = matchKnownPattern(pattern, state);
    if (matched) {
      matched.count += 1;
      matched.last_seen = new Date().toISOString();
      console.log(`  Pattern known: ${pattern.title} (x${matched.count})`);
    } else {
      console.log(`  New pattern: ${pattern.title}`);
      pattern.last_seen = new Date().toISOString();
      pattern.sample_sessions = [session.id];
      state.patterns.push(pattern);

      // Propose and apply fix for new patterns
      const proposal = await proposeFix(pattern);
      if (proposal && await validateProposal(proposal, state)) {
        applyFix(proposal);
        state.proposals_applied++;
      }
    }
  }

  state.last_run = session.id;
  state.total_sessions_analyzed++;
  saveState(state);

  console.log(`\nDone. ${state.total_sessions_analyzed} sessions analyzed, ${state.proposals_applied} proposals applied.`);
  console.log(`Known patterns: ${state.patterns.length}`);
}

main().catch(console.error);
