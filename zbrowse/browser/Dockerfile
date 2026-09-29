FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium unzip ca-certificates fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

COPY zguard /opt/zguard
RUN mkdir -p /opt/zguard \
  && unzip -q /tmp/zGuard-Chromium.zip -d /opt/zguard \
  && rm /tmp/zGuard-Chromium.zip \

COPY policies/policy.json /etc/chromium/policies/managed/zbrowse-policy.json
COPY root /
RUN chmod +x /usr/local/bin/start-zbrowse
