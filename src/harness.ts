/**
 * Hermes Harness — shared types and helpers
 */
export interface FailurePattern {
  id: string;
  category: "tool_error" | "context_loss" | "wrong_model" | "config_miss" | "skill_gap" | "repeated_correction";
  title: string;
  description: string;
  count: number;
  last_seen: string;
  sample_sessions: string[];
}

export interface HarnessProposal {
  type: "skill_update" | "memory_add" | "hermes_pr" | "config_change" | "workflow_add";
  target: string;
  reason: string;
  code?: string;
  content?: string;
  confidence: number; // 0-1
}

export interface SessionSummary {
  session_id: string;
  corrections: number;
  retries: number;
  errors: string[];
  tool_usage: Record<string, number>;
  duration_seconds: number;
  model_used: string;
  skills_loaded: string[];
  outcome: "success" | "partial" | "failure";
}

export interface WorldModelState {
  known_patterns: FailurePattern[];
  embedding_dim: number;
  clusters: Map<string, number[]>; // pattern_id -> centroid
}

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DATA_DIR } from "./config";

// Read API key from env or .env (standalone ~/.hermes-harness/ first, fallback ~/.hermes/)
function getEnvVar(name: string): string {
  if (process.env[name]) return process.env[name]!;
  for (const base of [join(homedir(), ".hermes-harness"), join(homedir(), ".hermes")]) {
    try {
      const envPath = join(base, ".env");
      const env = readFileSync(envPath, "utf-8");
      const match = env.match(new RegExp(`^${name}=(.+)$`, "m"));
      if (match) return match[1].trim();
    } catch {}
  }
  return "";
}

const OR_KEY = getEnvVar("OPENROUTER_API_KEY");
const DS_KEY = getEnvVar("DEEPSEEK_API_KEY");

const ENDPOINTS: { name: string; url: string; key: string; model: string }[] = [
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: OR_KEY, model: "openrouter/free" },
  { name: "deepseek", url: "https://api.deepseek.com/chat/completions", key: DS_KEY, model: "deepseek-v4-flash" },
];

export async function callFreeLLM(prompt: string, system?: string): Promise<string> {
  // Try each endpoint in order until one works
  for (const ep of ENDPOINTS) {
    if (!ep.key) continue;
    try {
      const resp = await fetch(ep.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ep.key}`,
        },
        body: JSON.stringify({
          model: ep.model,
          messages: [
            { role: "system", content: system || "You are a precise agent harness analyzer. Output raw JSON only." },
            { role: "user", content: prompt },
          ],
          max_tokens: 2000,
        }),
      });

      if (!resp.ok) {
        console.error(`  ${ep.name}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json() as any;
      const content = data?.choices?.[0]?.message?.content || "";
      if (content) {
        console.error(`  ✓ ${ep.name}: ${content.length} chars`);
        return content;
      }
    } catch (e: any) {
      console.error(`  ${ep.name} error: ${e.message}`);
    }
  }
  return "";
}

export async function getEmbedding(text: string): Promise<number[]> {
  // Use free embedding model via OpenRouter
  const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b:free", // Free embedding
      input: text,
    }),
  });
  const data = await resp.json() as any;
  return data?.data?.[0]?.embedding || [];
}

// Cosine similarity between two vectors
export function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const normB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (normA * normB);
}
