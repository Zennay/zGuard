# Curated site DNS root-dot normalization

The zBrowse site's JSON configuration is checked statically against private/local destinations and repeated origins. WHATWG URL parsing retains terminal root dots on DNS hostnames. A URL like `https://localhost./` or `https://printer.local./` therefore needs normalization **before** suffix isolation checks; comparing `URL.origin` alone also treats `https://site.example/` and `https://site.example./` as different strings even though DNS resolves the same hostname.

The source-only `tests/zbrowse.sites-config-safety.test.mjs` validator removes terminal root dots from the parsed lowercase hostname and uses that canonical hostname consistently for local DNS zone checks and origin deduplication. It rejects localhost, `.localhost`, `.local`, `.home.arpa` and `.internal` with or without a trailing root dot; it preserves otherwise valid public FQDNs with a trailing DNS root dot. It still rejects explicitly non-public IP literals through the independent #253 IP-range guard.

This is a deterministic checked-in configuration contract. It does not query DNS or claim runtime protection against DNS rebinding, proxies, arbitrary user navigation or deceptive publicly registered domains. The shipped `sites.json` and all deployed zBrowse code remain unchanged.

Issue: https://github.com/Zennay/zGuard/issues/257
