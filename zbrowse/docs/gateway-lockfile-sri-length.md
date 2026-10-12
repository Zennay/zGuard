# zBrowse gateway lockfile SRI length and encoding

The committed gateway `package-lock.json` must retain immutable npm tarball provenance. The existing test requires `https://registry.npmjs.org/` and `sha512-` Subresource Integrity (SRI) tokens for resolved dependencies.

A lexical `sha512-` prefix is not sufficient evidence: `sha512-YQ==` syntactically looks like base64 but decodes to a single byte, whereas a complete SHA-512 digest is exactly **64 bytes**. This source-only regression decodes the token as base64, demands 64 bytes and demands that re-encoding produces the **identical** canonical base64 text (including padding). It rejects truncated, malformed and noncanonical fixtures.

The test does not compute the actual package tarball digest or fetch packages over the network; npm's `ci` remains responsible for validating tarball bytes against the committed digest. No package versions, install scripts or lockfile entries are changed here.

Issue: https://github.com/Zennay/zGuard/issues/259
