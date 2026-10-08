<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (`.codegraph/codegraph.db` exists at the repo root — `.codegraph/.gitignore` alone doesn't count), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If `.codegraph/codegraph.db` doesn't exist, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
