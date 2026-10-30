/**
 * config.ts — Centralized paths for the hermes-harness package
 * 
 * Default data directory: $HOME/.hermes-harness/
 * Override via: HARNESS_DATA_DIR env var
 */

import { homedir } from "os";
import { join } from "path";

const BASE = process.env.HARNESS_DATA_DIR || join(homedir(), ".hermes-harness");

export const DATA_DIR = BASE;
export const MODELS_DIR = join(BASE, "models");
export const REPO_MODELS_DIR = join(BASE, "repo-models");
export const PATTERNS_DIR = join(BASE, "patterns");

// Seed data
export const SEED_DIR = join(BASE, "seed-repos");
export const SEED_STATE = join(BASE, "seed-state.json");
export const SEED_OUTPUT = join(BASE, "seed-world-model.json");
export const SEED_PUBLISH = join(BASE, "seed-world-model.publish.json");

// Git miner
export const GIT_STATE = join(BASE, "git-state.json");

// Ticket miner
export const TICKET_STATE = join(BASE, "ticket-state.json");

// Issue scanner
export const FIXES_DIR = join(BASE, "generated-fixes");
export const PR_DIR = join(BASE, "pending-prs");

// World model
export const WORLD_MODEL = join(MODELS_DIR, "world-model.json");

// Ticket patterns
export const TICKET_PATTERNS_DIR = join(PATTERNS_DIR, "tickets");

// Git patterns
export const GIT_PATTERNS_DIR = join(PATTERNS_DIR, "git");

// Skills output
export const SKILLS_DIR = join(BASE, "skills");

// Knowledge output
export const KNOWLEDGE_DIR = join(BASE, "knowledge");

// Ticket ledger paths (for ticket-miner)
export const TICKET_LEDGER_PATHS = (process.env.HARNESS_TICKET_DIRS || "")
  .split(process.platform === "win32" ? ";" : ":")
  .map(path => path.trim())
  .filter(Boolean);

// Git repos to scan (for git-miner)
export function getDefaultRepos(): string[] {
  return (process.env.HARNESS_REPOS || "")
    .split(process.platform === "win32" ? ";" : ":")
    .map(path => path.trim())
    .filter(Boolean);
}
