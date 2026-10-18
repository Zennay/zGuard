# zBrowse TV Browser

zBrowse is een tv-vriendelijke webinterface voor een tijdelijke Chromium-browser op een VPS. Iedere sessie draait in een eigen Docker-container met zGuard geladen. Het browserbeeld, geluid en de bediening worden door Selkies naar een gewone moderne browser gestreamd.

## Veilig model

De publieke startpagina maakt zBrowse niet tot een open proxy:

- maximaal één actieve sessie standaard;
- één sessie per IP-adres;
- automatische beëindiging na 15 minuten;
- een configureerbare lijst toegestane websites;
- tijdelijke browserprofielen die na de sessie verdwijnen;
- geen hostmappen in de browsercontainer;
- geheugen-, CPU- en proceslimieten;
- de gateway draait met een read-only rootfilesystem, zonder Linux capabilities en met `no-new-privileges`;
- alleen een begrensde `/tmp`-tmpfs blijft schrijfbaar en gatewaylogs worden geroteerd;
- een Docker-healthcheck controleert de bestaande `/api/health`-route;
- zGuard blokkeert popups en externe pop-unders.
- de browsercontainer draait als vergrendelde Selkies-kiosk: desktopgereedschappen, sudo, terminals en window-manager-uitwegen worden uitgeschakeld; sluiten van de kioskapp herstart de browser automatisch;
- sessiegebruikers kunnen geen Selkies bestanden overdragen, kopiëren/plakken, printen, delen, apps starten of webcam/microfoon/gamepad doorsturen; de TV-video- en audio-uitvoer blijven beschikbaar;
- geen Docker-in-Docker startup; deze kioskconfiguratie vervangt niet de onafhankelijke Chromium-sandbox, Docker-runtime-isolatie of de browser-gateway-authorisatie.

Voeg alleen websites toe waarvoor je dit soort toegang mag aanbieden. Maak de dienst niet onbeperkt toegankelijk tot ieder willekeurig domein.

## Installeren op de VPS

Vereisten: Ubuntu/Debian, Docker Engine, Docker Compose v2 en Node.js.

Voor de standaardinstallatie:

```bash
bash scripts/install.sh
```

Het installatiescript controleert Docker, Compose, Node.js, de Docker-socket én echte toegang tot de Docker-daemon en draait daarna de volledige zBrowse-validatie **voordat** het lokale `.env`-bestand wordt aangemaakt of aangepast. Daardoor laten ontbrekende prerequisites, daemon-permissieproblemen en bron-/contractfouten geen gedeeltelijk gemuteerde lokale configuratie achter.

Wil je instellingen vóór de eerste build aanpassen, maak dan zelf eerst `.env` aan en pas die aan:

```bash
cp .env.example .env
# pas .env aan
bash scripts/install.sh
```

De gateway luistert standaard alleen lokaal op `127.0.0.1:8090`. Koppel daarna je bestaande reverse proxy aan `http://127.0.0.1:8090` en laat WebSocket-upgrades door. Gebruik altijd HTTPS op de publieke domeinnaam.

### Caddy

```caddy
browser.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

### Nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Websites aanpassen

De publieke snelkoppelingen staan in `gateway/config/sites.json`. De browserbeperking staat in `browser/policies/policy.json`. Pas beide aan en voer daarna uit:

```bash
docker build -t zbrowse-browser:1.0.0 ./browser
docker compose up -d --build gateway
```

## Instellingen

De belangrijkste waarden in `.env`:

- `MAX_SESSIONS=1`: maximaal gelijktijdige browsers;
- `SESSION_TTL_MINUTES=15`: maximale sessieduur;
- `IDLE_TTL_MINUTES=5`: opruimen wanneer de portal geen heartbeat meer stuurt;
- `BROWSER_MEMORY_MB=2048`: RAM per sessie;
- `BROWSER_CPU=1`: CPU-limiet per sessie;
- `TRUST_PROXY=1`: gebruiken achter één reverse proxy. Het sessie-eigenaarschap **en de POST /api/session-aanvraaglimiet** hanteren nu exact dezelfde conservatieve IP-bepaling: bij een ontbrekende, te korte of ongeldige vertrouwde X-Forwarded-For-keten wordt de TCP-peer gebruikt, nooit een onbewezen doorgestuurd clientadres. IPv6 blijft per prefix begrensd via de bestaande express-rate-limit-voorziening. Zet deze waarde alleen gelijk aan het aantal aantoonbaar vertrouwde proxyhops; `TRUST_PROXY=0` negeert X-Forwarded-For volledig.

Het installatiescript vult `DOCKER_GID` automatisch in zodat de gateway alleen via zijn aanvullende groep toegang krijgt tot de Docker-socket.

Op een VPS die ook HaxLab, FTMO en andere taken draait is één sessie met één CPU de veilige start. Verhoog dit pas na het bekijken van het echte resourcegebruik.

## Kwaliteitscontrole

Voer vóór installatie of deploy de lokale contractchecks uit:

```bash
bash scripts/validate.sh
```

Deze gate controleert onder meer JavaScript-syntax, JSON-configuratie, de loopback-only hostbinding, browser-policy/site-consistentie, trusted-proxy IP-resolutie, installer-preflight zonder lokale state-mutatie, portal-accessibility, repository-hygiëne en de statische containment/dependency-auditcontracten. Wanneer Docker beschikbaar is valideert dezelfde entrypoint ook de Compose-configuratie.

De aparte gateway-containment CI-gate draait eerst dezelfde volledige portable `scripts/validate.sh`-suite en bouwt en start daarna de echte gatewaycontainer op een portable hosted runner. Die gate accepteert de runtime pas wanneer Docker de applicatiehealthcheck op `/api/health` als `healthy` rapporteert. Daarna controleert dezelfde gate de effectieve draaiende container met `docker inspect` en echte write-probes: de gateway moet non-root blijven, een read-only rootfilesystem houden, alle Linux capabilities droppen, `no-new-privileges` behouden, alleen op loopback publiceren, de configuratie read-only mounten en alleen de begrensde `/tmp` schrijfbaar houden. De CI boot de gateway bovendien met de echte GID van de runner-Docker-socket en voert vanuit de non-root gateway een Docker API-ping uit; zo faalt de gate ook wanneer health groen is maar sessiestart later geen toegang tot Docker zou hebben.

## Controle

```bash
curl http://127.0.0.1:8090/api/health
docker compose ps gateway
docker compose logs -f gateway
```

Een geldige healthrespons bevat `"status":"ok"` en het aantal actieve sessies. `docker compose ps gateway` hoort de gateway als `healthy` te tonen.

## Browser-kiosk releasecontrole (#10)

De gateway maakt bij iedere geautoriseerde nieuwe `/api/session` in `gateway/server.js` een browsercontainer met vaste Selkies hardening-variabelen. Deze policy kan niet door de client, het start-URL-veld of externe HTTP-headers worden overschreven. De ingebouwde browser blijft voor eindgebruikers via de normale viewer werken; `RESTART_APP` is bewust aangezet zodat sluiten van Chromium geen onbeheerde desktop geeft.

Bronnen: [Selkies Security and Hardening](https://docs.linuxserver.io/selkies/user-guide/security/) en [Configuration Reference](https://docs.linuxserver.io/selkies/user-guide/configuration/). `SELKIES_FILE_TRANSFERS=none` vervangt het niet-ondersteunde `SELKIES_ENABLE_FILE_TRANSFER`; `|locked` vergrendelt betreffende boolean-instellingen. Privé-data en browser-wachtwoorden horen niet in logs of opleverdocumentatie.

**Vóór productieactivatie** moet de bevoegde eigenaar na de bestaande bron-CI en onafhankelijke review onder een geserialiseerd releasevenster de daadwerkelijke effectieve browsercontainerconfiguratie controleren (`docker inspect` voor Env, privileges, mounts en netwerk), een bruikbare TV-browser openen en aantonen dat terminal, apps, bestanden, sharing en clipboard niet bereikbaar zijn en herstart van Chromium werkt. Doe dit alleen met een geautoriseerde nieuwe lege sessie; geen bestaande actieve sessies, production-DB of worker-taken verstoren. Zolang die acceptatie ontbreekt geldt `fixed_in_source`, niet `deployed` of `runtime_verified`.
