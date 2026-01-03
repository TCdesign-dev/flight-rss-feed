# flight-rss-feed

Generatore di feed RSS per voli del giorno utilizzando l'API di Aviationstack.

## Configurazione

1. Ottieni una API key gratuita da [Aviationstack](https://aviationstack.com/dashboard)
2. Configura l'API key in uno dei seguenti modi:
   - **Variabile d'ambiente** (consigliato):
     ```bash
     export AVIATIONSTACK_ACCESS_KEY=your_api_key_here
     ```
   - **Modifica il file**: Apri `generate_rss.js` e sostituisci `YOUR_ACCESS_KEY_HERE` con la tua API key

## Utilizzo

```bash
node generate_rss.js
```

Lo script genererà un file `flight_feed.xml` con il volo del giorno che corrisponde ai pattern di data.

## Pattern di ricerca

Lo script cerca voli che contengono:
- Pattern numerici: giorno, mese+giorno, giorno+mese (es. "15", "0115", "1501")
- Pattern di testo: prime 2-3 lettere di mesi e giorni della settimana in inglese (es. "JA" per January, "TU" per Tuesday)

## Output

Il feed RSS include:
- Numero volo e compagnia aerea
- Aeroporto di partenza (città e codice IATA)
- Aeroporto di arrivo (città e codice IATA)
- Link per tracciare il volo su FlightRadar24