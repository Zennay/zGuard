FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie@sha256:1439cfdbc0db4e2b6f2c2ca518b9d15cc16454acf9fc4536578747a6ffdb18e3

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-color-emoji \
  && mkdir -p /opt/zbrowse-build-metadata \
  && dpkg-query -W -f='\${Package}\t\${Version}\n' | sort > /opt/zbrowse-build-metadata/apt-packages.tsv \
  && rm -rf /var/lib/apt/lists/*

COPY zguard /opt/zguard
RUN chmod -R a+rX /opt/zguard

COPY policies/policy.json /etc/chromium/policies/managed/zbrowse-policy.json
COPY root /
RUN chmod +x /usr/local/bin/start-zbrowse
