# Workstation tenant HTTP fork

Build server-http.mjs and hook-http.mjs with node build/build-http.mjs. The HTTP endpoint, header, tenant adapters, timeouts, and data directory come from the caller-supplied workstation endpoint table. Both entries are flat bundles.

The stdio entry retains its original schema and operation. HTTP stores tenant/project-scoped journal, sources, metadata, and FTS rows in one SQLite database. A native one-shot hook posts its payload and tenant header to the shared server; transport failures use the upstream native failure policy. The HTTP listener supports _workspace and _sessionId tool arguments or corresponding request metadata. Machine-wide doctor and upgrade operations use stdio.
