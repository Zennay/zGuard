# zBrowse Selkies effective-environment acceptance

This is an **operator-only, read-only** check for issue [#10](https://github.com/Zennay/zGuard/issues/10). It is not a browser sandbox, kiosk escape, TV↔VPS or public-network release acceptance.

The source-only gate `node tests/zbrowse.selkies-hardening-posture.test.mjs --require-selkies-hardening` reviews the gateway's declared launch environment. The effective Docker inspection tool independently reads the **actual running container configuration**. Both must pass before the kiosk configuration can be considered validated. Neither substitutes for interactive Selkies kiosk escape testing or Chromium process-sandbox proof.

## Safe execution on the authorized VPS

From the deployed zGuard repository directory, with Docker read permissions, and **only when a reviewed zBrowse browser session already exists**, run the strict operator command `node tools/zbrowse-live-docker-acceptance.mjs --require-live-docker`. It discovers exactly one managed running container, validates the complete Docker ID, calls `docker inspect` using an argument array (never a shell), checks that the inspected ID matches, and evaluates the reviewed Selkies and Docker isolation posture. It never writes or displays the raw inspection document. The previous manual `docker inspect | node` pipeline remains available through `tools/zbrowse-selkies-effective-posture.mjs`, but is no longer the preferred operator path.

The command refuses missing/multiple managed sessions and exits nonzero if any of the eight reviewed settings is absent/weakened, if the legacy transfer variable remains, or if the inspection does not identify a live managed zBrowse container. It also refuses Docker privilege escalation, host/default/container networking, host namespaces, host bind mounts or injected devices, published browser ports, absent CPU/RAM/PID limits, missing `no-new-privileges`, unexpected persistent effective mounts and unbounded/executable `/config` or `/tmp` filesystems. The tool outputs only generic failure categories and the **names** of reviewed missing settings or fixed Docker isolation gap labels, never configuration values.

Do **not** run `docker inspect` without the pipe in a shared terminal/log or paste its raw output into GitHub issues, CI, Notion or chat: Docker environment includes a per-session PASSWORD and bearer-derived SUBFOLDER. Do not enable shell tracing (`set -x`), retain raw inspect artifacts, or redirect them into persistent files. Execute the command in an authorized maintenance context without creating additional public browser sessions for testing.

A pass reports only that the Docker-configured Selkies variables **and Docker isolation configuration** match the reviewed policy for one running managed browser **at the inspection instant**. It does not independently demonstrate that Selkies honors each variable, the in-container Chromium process is sandboxed, keyboard/terminal escape routes are blocked, or that public TV streaming works. Verify these separately using the owning runtime/deploy lane, and record exact image/ref and sanitized pass/fail evidence rather than credentials.

## Portable no-VPS regression

From the repository root, run the portable QA regression with `node tests/zbrowse.selkies-effective-env.test.mjs`.

This exercises synthetic inspect documents, missing/relaxed settings, stopped/wrongly named containers, malformed input, oversize input, CLI misuse and secret-output regressions. A passing portable test is **not** live VPS proof.
