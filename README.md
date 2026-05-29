# 🦠 AlphaGen — Simulatore di diffusione epidemica

Piattaforma interattiva per simulare la diffusione mondiale di virus e malattie.
Il modello **SEIRD+V** in metapopolazione (una dinamica SEIR per ogni nazione)
gira sul backend e viene trasmesso in tempo reale all'interfaccia, dove è
possibile **modificare i parametri mentre la simulazione avanza** e osservarne
subito l'effetto su una **mappa mondiale** e su **grafici a curve**.

![Licenza](https://img.shields.io/badge/license-MIT-blue)
![Backend](https://img.shields.io/badge/backend-FastAPI-009688)
![Frontend](https://img.shields.io/badge/frontend-Angular%2021-dd0031)

## Caratteristiche

- **Modello epidemiologico SEIRD+V** (Suscettibili, Esposti, Infetti, Guariti,
  Deceduti, Vaccinati) per 245 nazioni, con dati di popolazione reali.
- **Diffusione tra nazioni** tramite una rete voli reale (dataset OpenFlights)
  più una connettività di base che garantisce la raggiungibilità globale.
- **Controllo in tempo reale**: avvio/pausa, avanzamento manuale, velocità
  regolabile e modifica live di tutti i parametri tramite WebSocket.
- **Mappa mondiale** (Leaflet, tile scure): choropleth a intensità + **archi di
  volo animati** quando il contagio supera un confine.
- **Scheda paese**: click su una nazione → dettaglio SEIRD+V live, **sparkline**
  dei casi attivi, **lockdown per-paese** e pulsante "semina qui".
- **Grafici a curve** (ECharts) con aree sfumate per Esposti, Infetti, Guariti,
  Deceduti, Vaccinati.
- **Timeline / scrubber**: riavvolgi e rivedi l'evoluzione giorno per giorno
  (la mappa, le curve e la scheda mostrano il giorno selezionato).
- **Preset di malattie** reali pronti all'uso (18, da COVID-19 a Ebola),
  completamente modificabili.
- **Salva/Carica come file JSON** — esporta lo **stato completo** (l'intero
  buffer della timeline: curve del grafico, replay sulla mappa, parametri,
  compartimenti e lockdown per paese) e lo ripristina esattamente. Nessun DB.

## Architettura

```
┌──────────────────────────┐         WebSocket /ws          ┌───────────────────────────┐
│        Frontend          │  ◀───── snapshot (stato) ─────  │          Backend          │
│      Angular 21          │  ─────▶ comandi (play/seed/…) ─ │       FastAPI + uv         │
│  (zoneless, signals)     │                                 │                            │
│                          │            REST /api            │  ┌──────────────────────┐  │
│  Leaflet  ·  ECharts     │  ◀─── presets/countries/geojson │  │  motore SEIRD+V       │  │
│                          │  ◀───▶ scenario (JSON)          │  │  (NumPy, metapop.)    │  │
└──────────────────────────┘                                 │  └──────────────────────┘  │
                                                              └───────────────────────────┘
```

Il backend mantiene un'unica simulazione condivisa, la fa avanzare (uno step =
un giorno) e trasmette uno _snapshot_ ad ogni passo ai client connessi. Il
client invia comandi e aggiorna l'interfaccia in modo reattivo tramite signal.

## Stack tecnologico

| Livello   | Tecnologia                                                |
| --------- | --------------------------------------------------------- |
| Backend   | Python 3.13, FastAPI, Uvicorn, NumPy, gestione con **uv** |
| Real-time | WebSocket                                                 |
| Frontend  | Angular 21 (standalone, zoneless, signal-based)           |
| Mappa     | Leaflet                                                   |
| Grafici   | Apache ECharts                                            |

## Prerequisiti

- [**uv**](https://docs.astral.sh/uv/) (gestisce automaticamente Python 3.13)
- **Node.js** 20+ e **npm**

## Avvio rapido

Servono due terminali.

### 1) Backend — porta 8000

```bash
cd backend
uv run uvicorn app.main:app --reload --port 8000
```

`uv` crea l'ambiente virtuale e installa le dipendenze al primo avvio. I dataset
necessari (`countries.json`, `world.geo.json`) sono già inclusi nel repository.

### 2) Frontend — porta 4200

```bash
cd frontend
npm install
npm start
```

Apri **http://localhost:4200**, scegli un preset, **clicca un paese** sulla mappa
per aprire la sua scheda e premi **🦠 Semina focolaio qui**, poi **▶ Avvia** e
regola gli slider mentre la simulazione procede. Dalla scheda puoi anche imporre
un **lockdown** al singolo paese; con la **timeline** riavvolgi e rivedi l'epidemia.

## Il modello di simulazione

Per ogni nazione _i_ si evolvono i compartimenti S, E, I, R, D, V con un
aggiornamento giornaliero (Eulero esplicito, `dt = 1 giorno`):

```
β_eff   = (R₀ / durata_infettiva) · (1 − interventi)   # interventi = riduzione globale
apert_i = 1 − lockdown_i                                # lockdown per-paese in [0,1]
σ       = 1 / incubazione
γ       = 1 / durata_infettiva

prev_i  = apert_i · I_i / N_i                           # un paese chiuso trasmette/esporta meno
λ_i     = β_eff · prev_i  +  mobilità · apert_i · Σ_j W[i,j] · prev_j
nuovi_E = λ_i · S_i
nuovi_I = σ · E_i
uscita  = γ · I_i
nuovi_D = letalità · uscita
nuovi_R = (1 − letalità) · uscita
nuovi_V = vaccinazione · S_i
```

dove `W[i,j]` è il peso di viaggio (rete voli) dalla nazione _j_ alla _i_ (il
termine con `W` è la pressione infettiva importata dall'estero) e `lockdown_i`
è l'intervento **per singolo paese**, che riduce sia la trasmissione locale sia
import ed export di quel paese. Ogni transizione è limitata alla popolazione
disponibile nel compartimento di partenza (il modello conserva la popolazione).

## Parametri interattivi

Tutti i parametri sono modificabili **durante** la simulazione.

| Parametro                 | Effetto                                                     |
| ------------------------- | ----------------------------------------------------------- |
| **R₀**                    | Trasmissibilità di base (β = R₀ / durata infettiva)         |
| **Interventi**            | Riduzione dei contatti (lockdown/distanziamento): abbassa β |
| **Vaccinazione / giorno** | Frazione di suscettibili vaccinati ogni giorno              |
| **Letalità**              | Frazione di infetti che decede invece di guarire            |
| **Incubazione**           | Durata della fase Esposto (E → I), in giorni                |
| **Durata infettiva**      | Durata della fase Infetto (I → R/D), in giorni              |
| **Mobilità globale**      | Moltiplicatore sullo scambio tra nazioni                    |

## API

Base URL: `http://localhost:8000`

### REST

| Metodo | Path                  | Descrizione                                      |
| ------ | --------------------- | ------------------------------------------------ |
| `GET`  | `/api/health`         | Healthcheck                                      |
| `GET`  | `/api/countries`      | Metadati nazioni (ISO, popolazione, coordinate)  |
| `GET`  | `/api/geojson`        | Confini del mondo (GeoJSON) per la mappa         |
| `GET`  | `/api/flights`        | Rete voli (coppie di paesi) per gli archi        |
| `GET`  | `/api/presets`        | Preset di malattie                               |
| `GET`  | `/api/scenario?name=` | Stato live di un singolo frame (uso interno)     |
| `POST` | `/api/scenario`       | Sincronizza il motore a uno stato (no broadcast) |

### WebSocket `/ws`

**Client → server** (comandi):

```jsonc
{ "type": "play" }
{ "type": "pause" }
{ "type": "reset" }
{ "type": "step" }                                // un giorno manuale
{ "type": "seed", "iso": "USA", "count": 100 }    // innesca un focolaio
{ "type": "setParams", "params": { /* ... */ } }  // tuning in tempo reale
{ "type": "setSpeed", "speed": 10 }               // step al secondo
{ "type": "setCountryIntervention", "iso": "ITA", "value": 0.6 }  // lockdown paese
```

**Server → client** (ad ogni step):

```jsonc
{
	"type": "snapshot",
	"day": 42,
	"running": true,
	"speed": 10,
	"params": {
		/* ... */
	},
	"totals": { "s": 0, "e": 0, "i": 0, "r": 0, "d": 0, "v": 0 },
	"countries": [
		{
			"iso": "ITA",
			"name": "Italy",
			"population": 0,
			"s": 0,
			"e": 0,
			"i": 0,
			"r": 0,
			"d": 0,
			"v": 0,
			"intervention": 0,
		},
	],
}
```

## Configurazione

- **Porte**: backend `8000`, frontend `4200`. L'URL del backend usato dal client
  è in `frontend/src/app/simulation.service.ts`.
- **CORS**: il backend accetta richieste da `http://localhost:4200` e
  `http://127.0.0.1:4200` (vedi `backend/app/main.py`). In produzione aggiorna
  le origini consentite.

## Dati

Tutti i dataset sono già inclusi e versionati in `backend/app/data/`:
`countries.json` (popolazione e coordinate), `world.geo.json` (confini per la
mappa), `flights.json` (rete voli tra nazioni) e `presets.json` (malattie).

## Fonti dei dati

- Popolazione e coordinate delle nazioni: [REST Countries](https://restcountries.com/).
- Confini delle nazioni (GeoJSON): [`johan/world.geo.json`](https://github.com/johan/world.geo.json).
- Rete voli tra nazioni: [OpenFlights](https://openflights.org/data.html). Il
  peso di ogni coppia di paesi è il numero di rotte aeree tra essi (normalizzato),
  usato come proxy reale di connettività; la mappatura ISO usa REST Countries.

## Licenza

Distribuito con licenza **MIT**. Vedi il file [`LICENSE`](LICENSE).
