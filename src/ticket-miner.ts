/**
 * ticket-miner.ts — Full ticket lifecycle miner
 * 
 * A ticket isn't just its resolution. The lifecycle tells the real story:
 *   opened → assigned → in progress → resolved → reopened → resolved → closed
 * 
 * A reopened ticket means the fix was incomplete. A long "in progress" means 
 * the problem was hard. A ticket that failed and was "Closed - Won't Fix" is 
 * just as valuable as one that succeeded.
 * 
 * We mine all of it — the state machine of every ticket.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { callFreeLLM } from "./harness";
import { DATA_DIR, REPO_MODELS_DIR, TICKET_LEDGER_PATHS } from "./config";

const STATE_FILE = join(DATA_DIR, "ticket-state.json");

interface TicketState {
  processed: string[];
  patterns_found: number;
  last_run: string;
}

interface Ticket {
  path: string;
  slug: string;
  title: string;
  description: string;
  resolution: string;
  state: "open" | "resolved" | "partial" | "wonfix";
  lifecycle_hints: {
    reopened: boolean;      // was it reopened? (incomplete fix)
    backForth: number;      // how many state transitions
    longRunning: boolean;    // sat open for > 7 days
    hasFailure: boolean;     // explicitly mentions failure
    rootCause: string;       // extracted root cause
  };
}

function loadState(): TicketState {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
  catch { return { processed: [], patterns_found: 0, last_run: "" }; }
}

function saveState(s: TicketState) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Discover tickets ──

function findAllTickets(): Ticket[] {
  const roots = TICKET_LEDGER_PATHS;
  
  const tickets: Ticket[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      if (d.startsWith(".") || ["node_modules", "docs", "scripts", "scratch"].includes(d)) continue;
      const ticketPath = join(root, d, "ticket.md");
      if (!existsSync(ticketPath)) continue;
      
      const content = readFileSync(ticketPath, "utf-8");
      const title = content.match(/^# (.+)$/m)?.[1] || "untitled";
      const description = content.match(/## Description\n\n([\s\S]*?)(?=\n## )/)?.[1]?.slice(0, 1000) || "";
      const resolution = content.match(/## Resolution\n\n([\s\S]*?)(?=\n## \/Resolution|$)/)?.[1]?.slice(0, 2000) || "";
      
      // Detect lifecycle from content
      const reopenCount = (content.match(/reopen|re-open|reopened/gi) || []).length;
      const backForth = reopenCount + (content.match(/iteration|attempt|try \d|retry/gi) || []).length;
      const hasFailure = /fail|error|broken|crash|timeout|bug/i.test(content);
      const mentionsRoot = /root cause|because|due to|caused by/i.test(content);
      
      let state: Ticket["state"] = "open";
      if (resolution) state = "resolved";
      else if (content.includes("Won't Fix") || content.includes("wontfix")) state = "wonfix";
      else if (hasFailure) state = "partial";
      
      // Extract root cause
      let rootCause = "";
      const rcMatch = content.match(/root cause[:\s]+(.+?)(?:\n|$)/i);
      if (rcMatch) rootCause = rcMatch[1].slice(0, 200);
      
      tickets.push({
        path: ticketPath,
        slug: d,
        title,
        description,
        resolution,
        state,
        lifecycle_hints: {
          reopened: reopenCount > 0,
          backForth,
          longRunning: false, // would need ADO timestamps
          hasFailure,
          rootCause,
        },
      });
    }
  }
  return tickets;
}

// ── Pattern extraction ──

async function extractLifecyclePattern(ticket: Ticket): Promise<{
  pattern_id: string;
  type: string;
  pattern: string;
  description: string;
  confidence: number;
} | null> {
  const prompt = `Analyze this ticket's full lifecycle for the failure/fix pattern:

Title: ${ticket.title}
Description: ${ticket.description.slice(0, 500)}
Resolution: ${ticket.resolution.slice(0, 500)}
State: ${ticket.state}
Lifecycle hints: ${JSON.stringify(ticket.lifecycle_hints)}

Return JSON with the CLEAR failure pattern from this lifecycle:
{ "pattern_id": "project-slug:short-pattern",
  "type": "bug|process|config|test|deploy|auth|permission",
  "pattern": "short pattern name",
  "description": "what the full lifecycle tells us — what failed, why, and what fixed it",
  "confidence": 0-1 }

Only return a pattern if the lifecycle contained a clear failure + fix.
Return null if: no resolution, vague description, or no clear root cause.`;

  const raw = await callFreeLLM(prompt);
  try { return JSON.parse(raw); }
  catch { return null; }
}

// ── Feed into repo model ──

function saveToRepoModel(ticket: Ticket, pattern: { pattern_id: string; type: string; pattern: string; description: string; confidence: number }) {
  const repoSlug = ticket.slug.split("/")[0];
  const modelPath = join(REPO_MODELS_DIR, `${repoSlug}.json`);
  
  let model: any;
  try { model = JSON.parse(readFileSync(modelPath, "utf-8")); }
  catch {
    model = { name: repoSlug, path: "", total_commits: 0, file_coupling: {}, lifecycles: [], patterns: [], frequency: {}, last_analyzed: "" };
  }
  
  if (!model.lifecycles) model.lifecycles = [];
  
  // Don't add duplicates
  if (model.lifecycles.some((l: any) => l.pattern === pattern.pattern)) return;
  
  model.lifecycles.push({
    type: pattern.type,
    pattern: `${pattern.pattern} (${ticket.state})`,
    description: `From ticket ${ticket.slug}: ${pattern.description}`,
    confidence: pattern.confidence,
  });
  model.total_commits = (model.total_commits || 0) + 1;
  model.last_analyzed = new Date().toISOString();
  
  writeFileSync(modelPath, JSON.stringify(model, null, 2));
  console.log(`  📦 ${pattern.pattern.slice(0, 60)} → ${repoSlug}.json`);
}

// ── Main ──

async function main() {
  console.log("🎫 Mining full ticket lifecycles...");
  const state = loadState();
  const tickets = findAllTickets().filter(t => !state.processed.includes(t.slug));
  
  console.log(`Found ${tickets.length} unprocessed tickets`);
  
  // Categorize
  const resolved = tickets.filter(t => t.state === "resolved");
  const failed = tickets.filter(t => t.state === "wonfix" || t.state === "partial");
  const reopened = tickets.filter(t => t.lifecycle_hints.reopened);
  
  console.log(`  ${resolved.length} resolved, ${failed.length} failed/unfixable, ${reopened.length} reopened`);
  
  for (const ticket of tickets) {
    console.log(`\n--- ${ticket.slug}: ${ticket.title.slice(0, 60)} ---`);
    console.log(`  State: ${ticket.state}${ticket.lifecycle_hints.reopened ? " (was reopened)" : ""}${ticket.lifecycle_hints.hasFailure ? " (has failure data)" : ""}`);
    
    const pattern = await extractLifecyclePattern(ticket);
    if (pattern) {
      console.log(`  ✅ ${pattern.pattern}`);
      saveToRepoModel(ticket, pattern);
      state.patterns_found++;
    } else {
      console.log(`  ↪ No clear pattern extracted`);
    }
    
    state.processed.push(ticket.slug);
    saveState(state);
  }
  
  console.log(`\nDone. ${state.patterns_found} patterns mined from ticket lifecycles.`);
}

main().catch(console.error);
