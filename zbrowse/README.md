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
- zGuard blokkeert popups en externe pop-unders.

Voeg alleen websites toe waarvoor je dit soort toegang mag aanbieden. Maak de dienst niet onbeperkt toegankelijk tot ieder willekeurig domein.

## Installeren op de VPS

Vereisten: Ubuntu/Debian, Docker Engine, Docker Compose v2 en Node.js.

Voor de standaardinstallatie:

```bash
bash scripts/install.sh
```

Het installatiescript controleert Docker, Compose, Node.js en de Docker-socket voordat het lokale `.env`-bestand wordt aangemaakt of aangepast. Daardoor laat een ontbrekende prerequisite geen gedeeltelijke installatiestate achter.

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
- `TRUST_PROXY=1`: gebruiken achter één reverse proxy.

Het installatiescript vult `DOCKER_GID` automatisch in zodat de gateway alleen via zijn aanvullende groep toegang krijgt tot de Docker-socket.

Op een VPS die ook HaxLab, FTMO en andere taken draait is één sessie met één CPU de veilige start. Verhoog dit pas na het bekijken van het echte resourcegebruik.

## Kwaliteitscontrole

Voer vóór installatie of deploy de lokale contractchecks uit:

```bash
bash scripts/validate.sh
```

Deze gate controleert onder meer JavaScript-syntax, JSON-configuratie, de loopback-only hostbinding, browser-policy/site-consistentie, trusted-proxy IP-resolutie en — wanneer Docker beschikbaar is — de Compose-configuratie.

## Controle

```bash
curl http://127.0.0.1:8090/api/health
docker compose logs -f gateway
```

Een geldige healthrespons bevat `"status":"ok"` en het aantal actieve sessies.
