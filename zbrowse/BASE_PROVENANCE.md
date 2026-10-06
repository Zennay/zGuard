# zBrowse base-image provenance

zBrowse container builds must be reproducible at the base-image boundary.

## Required contract

Both Dockerfiles keep a human-readable upstream tag **and** pin the exact manifest digest:

- `ghcr.io/linuxserver/baseimage-selkies:debiantrixie@sha256:<digest>`
- `node:22-alpine@sha256:<digest>`

The tag documents the intended update channel; the digest makes a build at a fixed zGuard commit consume the same base manifest until an explicit refresh is committed.

`tests/zbrowse.base-provenance.test.mjs` rejects mutable tag-only `FROM` lines.

## Refresh procedure

1. Resolve the current digest for each documented tag from its registry.
2. Review the upstream change/security context before accepting the refresh.
3. Replace only the digest while retaining the documented tag.
4. Run the full zBrowse validation plus the provenance regression on the permanent VPS runner.
5. Build both images on that runner and record the resulting image IDs and effective base digests in the PR evidence.

The browser image also records installed Debian package versions inside the built image so Chromium/apt provenance can be inspected from the exact artifact. Security refreshes therefore remain deliberate instead of occurring silently through a mutable base tag.
