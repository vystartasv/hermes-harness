# Every Repo Is a World Model

**Your git history already knows what breaks. You just can't search it.**

---

Every project has a memory problem. You fix a bug, close the ticket, move on. Three months later, the same class of failure hits a different repo — different stack, different team, same root cause. Nobody connects them because nobody searches across repos for *lifecycle patterns*.

I built a tool that does exactly that.

## The insight

A git repository isn't just code. It's a history book of every decision, every revert, every "let's try this" and "that didn't work."

Most people search code: "find where this function is called."
I wanted to search history: "find where this *failure* happened before."

The signal is in the lifecycle, not the code:
- **Reverts** — "we tried X, it broke Y, we rolled back"
- **File coupling** — "these three files always change together"
- **Ticket reopens** — "the first fix was incomplete, here's what we missed"

## How it works

1. Clone a repo (or point it at yours)
2. Read the full git log — subjects, bodies, files, parents
3. Extract patterns: reverts, co-changing files, topic clusters
4. Compress into a 128-dim vector per pattern
5. Query: "has this failure happened before?" → checks all repos in milliseconds

The query is pure arithmetic — cosine similarity on word-count vectors. No API calls. No GPU. Runs on a $5 VPS or your laptop.

## The seed

I ran it against 11 public repos: LangChain, Next.js, Svelte, Vite, Supabase, n8n, and others. 21 patterns surfaced from ~2,200 commits:

```
"dependency version conflict" → 48% match with "Playwright version roll"
"update dependency version" → 28% match with "dependency bumps and fixes"
```

Not impressive numbers. The model needs more data. But the architecture is sound.

## What I learned

1. **The signal is sparse.** Most commits are noise — formatting, one-off fixes, trivial merges. Only ~1 in 100 commits contains a reusable lifecycle pattern.
2. **Commit messages are unreliable.** "Fix bug" tells you nothing. Conventional commits (`fix:`, `feat:`) are better but still vague about *why*.
3. **Reverts are gold.** Every revert is "we tried this and it didn't work" — pure signal. They're rare (~2% of commits) but each one is a documented failure mode.
4. **Cross-repo search is the killer feature.** A pattern in LangChain's commits matches a pattern in Supabase's commits — different stacks, same class of problem (dependency pinning). No existing tool connects those dots.

## The hard part

Nobody thinks in lifecycles. When something breaks, you fix it and move on. You don't go looking for the same failure in a different repo.

This tool only works if you:
- Pull it into your workflow (post-pull hook on ticket pull)
- Actually read the hints it generates
- Trust it enough to click through to a referenced ticket

That's a habit problem, not a technical one.

## The bet

I shipped the seed as an npm package. It mines public repos only — no private data, no credentials. If the approach resonates, people will seed it with their own repos and the model gets better.

If it doesn't, I learned that lifecycle mining is a solution in search of a problem — and that's useful information too.

---

*The code: [github.com/vystartasv/hermes-harness](https://github.com/vystartasv/hermes-harness)*
*Try it: `npm install -g hermes-harness`, run `hermes-harness seed-harvest` once to build the public seed, then query with `hermes-harness seed-query "your error here"`.*
