## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `npm run graphify:sync` to keep the graph current (AST-only, no API cost). It runs `graphify update .` and then relabels the communities and regenerates the wiki. Do NOT run `graphify update .` on its own: it re-clusters, which reassigns every community id and orphans the saved labels, so the wiki regenerates with hub names like `main.js`, `x`, `s`, `_`.
- Never run `graphify cluster-only` or `graphify label` here. The first re-clusters and orphans the labels again; the second needs an LLM backend. Community names live in `scripts/graphify-wiki.py` (a marker map plus a dominant-file map) — edit them there.
- `graphify-out/wiki/` is committed and is the project's documentation. The `pre-push` hook (`npm run hooks:install`) regenerates it and blocks a push whose wiki is stale; CI runs `npm run graphify:lint`, which checks the committed wiki for broken links and filename collisions. CI cannot regenerate it — `graphify-out/` is gitignored apart from `wiki/`, so a fresh checkout has no graph and no semantic cache.
