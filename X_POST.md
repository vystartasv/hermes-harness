Every repo is a world model.

I built a tool that mines git history for lifecycle patterns — what broke, what fixed it, what went back and forth.

Then it lets you query across repos. "Has this failure happened before?" → milliseconds, no AI, pure arithmetic.

The seed indexes 11 public OSS repos. Clone 11 more and the model gets better.

hermes-harness:
• Harvest public repos → builds a world model
• Query "your error" → finds matching patterns across repos
• No API keys needed at query time
• Runs on your laptop, no data leaves

npm install -g hermes-harness
hermes-harness seed-harvest
hermes-harness seed-query "dependency version conflict"

It's MIT. Contribute your favorite repos' patterns.

github.com/vystartasv/hermes-harness
