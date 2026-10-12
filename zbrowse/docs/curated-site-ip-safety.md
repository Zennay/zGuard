# Curated zBrowse site IP safety

The shipped `zbrowse/gateway/config/sites.json` is intended to link to public HTTPS websites. Its source-only validator already rejects credentials, non-HTTPS URLs, explicit nondefault ports, local DNS suffixes, localhost, RFC1918 and link-local address literals.

This quality gate additionally excludes IP literals which are not suitable for a public kiosk destination:

- IPv4 shared address space `100.64.0.0/10` (carrier-grade NAT).
- IPv4 benchmarking `198.18.0.0/15`.
- IPv4 documentation addresses `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`; also special-use `192.0.0.0/24`.
- IPv4 multicast `224.0.0.0/4` and reserved `240.0.0.0/4`, including the limited broadcast address.
- IPv6 multicast `ff00::/8` and documentation `2001:db8::/32`.
- Their applicable IPv4-mapped IPv6 encodings, including the equivalent hex-hextet spelling.

The gate retains public IPv4/IPv6 literals (such as `8.8.8.8` and `2001:4860:4860::8888`), and leaves the current public hostname configuration unchanged. It is a deterministic tracked-config review contract, **not** an IP reputation/DNS-rebinding defense, real-time DNS lookup, egress firewall, or assertion that any public hostname resolves exclusively to public addresses.

Issue: https://github.com/Zennay/zGuard/issues/253
