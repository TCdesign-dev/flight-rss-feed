import fs from 'fs';
import fetch from 'node-fetch';

// API Key per Aviationstack - ottieni la tua da: https://aviationstack.com/dashboard
const AVIATIONSTACK_ACCESS_KEY = process.env.AVIATIONSTACK_ACCESS_KEY;
const DATE_PATTERNS = (() => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2,'0');
  const month = String(now.getMonth()+1).padStart(2,'0');
  
  // Pattern numerici (esistenti)
  const numericPatterns = [day, month+day, day+month];
  
  // Prime 2-3 lettere dei nomi completi dei mesi in inglese
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                      'July', 'August', 'September', 'October', 'November', 'December'];
  const fullMonthName = monthNames[now.getMonth()];
  const monthPrefix2 = fullMonthName.substring(0, 2).toUpperCase(); // Prime 2 lettere
  const monthPrefix3 = fullMonthName.substring(0, 3).toUpperCase(); // Prime 3 lettere
  
  // Prime 2-3 lettere dei nomi completi dei giorni della settimana in inglese
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fullDayName = dayNames[now.getDay()];
  const dayPrefix2 = fullDayName.substring(0, 2).toUpperCase(); // Prime 2 lettere
  const dayPrefix3 = fullDayName.substring(0, 3).toUpperCase(); // Prime 3 lettere
  
  // Combina tutti i pattern (rimuove duplicati se le prime 2 e 3 lettere sono uguali)
  const textPatterns = [monthPrefix2, monthPrefix3, dayPrefix2, dayPrefix3].filter((v, i, a) => a.indexOf(v) === i);
  
  return [...numericPatterns, ...textPatterns];
})();
const NOW = new Date();

// --- TEST CONNETTIVITÀ --- //
async function testConnectivity() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    await fetch('https://api.aviationstack.com', { 
      method: 'HEAD',
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    return true;
  } catch (err) {
    return false;
  }
}

// --- FETCH SICURA --- //
async function fetchJsonSafe(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 secondi timeout
      
      const res = await fetch(url, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!res.ok) {
        // Gestione specifica per errori 503 (Service Unavailable)
        if (res.status === 503) {
          if (i === retries - 1) {
            console.error(`❌ Servizio temporaneamente non disponibile (HTTP 503)`);
            console.error(`   Il server Aviationstack è sovraccarico o in manutenzione.`);
            console.error(`   Riprova tra qualche minuto.`);
            return null;
          }
          console.warn(`⚠️  Servizio temporaneamente non disponibile (HTTP 503), tentativo ${i + 1}/${retries}...`);
          await new Promise(resolve => setTimeout(resolve, 3000 * (i + 1))); // Backoff per 503
          continue;
        }
        
        // Gestione errori API specifici
        if (res.status === 401) {
          const errorData = await res.json().catch(() => ({}));
          if (errorData.error?.code === 'invalid_access_key' || errorData.error?.code === 'missing_access_key') {
            console.error(`❌ Errore di autenticazione: ${errorData.error?.message || 'API key non valida o mancante'}`);
            console.error(`   Verifica la tua API key su: https://aviationstack.com/dashboard`);
            return null;
          }
        }
        
        // Altri errori HTTP
        if (i === retries - 1) {
          const errorData = await res.json().catch(() => ({}));
          if (errorData.error) {
            console.warn(`Errore API: ${errorData.error.code || res.status} - ${errorData.error.message || res.statusText}`);
          } else {
            console.warn(`Errore HTTP ${res.status}: ${res.statusText}`);
          }
        } else {
          console.warn(`Errore HTTP ${res.status}, tentativo ${i + 1}/${retries}...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
          continue;
        }
        return null;
      }
      
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        console.warn('Aviationstack API non ha restituito JSON valido:', text);
        return null;
      }
    } catch (err) {
      if (i === retries - 1) {
        if (err.name === 'AbortError') {
          console.error('Timeout nella richiesta a:', url);
        } else {
          console.error('Errore fetch:', err.message);
        }
        return null;
      }
      console.warn(`Errore nella richiesta, tentativo ${i + 1}/${retries}...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
    }
  }
  return null;
}

// --- FUNZIONI PER VOLI --- //
async function fetchActiveFlight() {
  // Cerca sia voli attivi che schedulati
  const baseUrl = 'https://api.aviationstack.com/v1/flights';
  
  // Prova prima con voli schedulati (priorità)
  let params = new URLSearchParams({
    access_key: AVIATIONSTACK_ACCESS_KEY,
    flight_status: 'scheduled',
    limit: 100
  });
  let url = `${baseUrl}?${params.toString()}`;
  let data = await fetchJsonSafe(url);
  
  // Se non trova voli schedulati, cerca voli attivi
  if (!data?.data || data.data.length === 0) {
    params = new URLSearchParams({
      access_key: AVIATIONSTACK_ACCESS_KEY,
      flight_status: 'active',
      limit: 100
    });
    url = `${baseUrl}?${params.toString()}`;
    data = await fetchJsonSafe(url);
  }
  
  if (!data?.data || !Array.isArray(data.data)) return null;
  
  // Separa pattern numerici da pattern di testo
  const numericPatterns = DATE_PATTERNS.filter(p => /^\d+/.test(p)); // Pattern che iniziano con numeri
  const textPatterns = DATE_PATTERNS.filter(p => /^[A-Za-z]/.test(p)); // Pattern che iniziano con lettere
  
  return data.data.find(flight => {
    if (!flight) return false;
    
    // Cerca nei vari campi del volo
    const flightNumber = flight.flight?.number?.toString() || '';
    const flightIata = flight.flight?.iata?.toUpperCase() || '';
    const flightIcao = flight.flight?.icao?.toUpperCase() || '';
    const airlineIata = flight.airline?.iata?.toUpperCase() || '';
    const airlineIcao = flight.airline?.icao?.toUpperCase() || '';
    
    // Combina tutti i campi rilevanti per la ricerca
    const searchText = `${flightNumber} ${flightIata} ${flightIcao} ${airlineIata} ${airlineIcao}`.toUpperCase();
    
    // Per pattern numerici: cerca ovunque
    const matchesNumeric = numericPatterns.some(p => searchText.includes(p));
    
    // Per pattern di testo: cerca all'inizio dei codici (IATA/ICAO della compagnia o del volo)
    const matchesText = textPatterns.some(p => {
      const patternUpper = p.toUpperCase();
      // Controlla se inizia con il pattern nei codici IATA/ICAO
      return flightIata.startsWith(patternUpper) || 
             flightIcao.startsWith(patternUpper) ||
             airlineIata.startsWith(patternUpper) ||
             airlineIcao.startsWith(patternUpper);
    });
    
    return matchesNumeric || matchesText;
  });
}

// --- GENERA FEED RSS --- //
async function generateRSS() {
  // Verifica API key
  if (AVIATIONSTACK_ACCESS_KEY === 'YOUR_ACCESS_KEY_HERE') {
    console.error('❌ Errore: API key non configurata!');
    console.error('   Imposta la variabile d\'ambiente AVIATIONSTACK_ACCESS_KEY oppure');
    console.error('   modifica il file per inserire la tua API key.');
    console.error('   Ottieni la tua API key su: https://aviationstack.com/dashboard');
    process.exit(1);
  }
  
  console.log('Verifica connettività al server Aviationstack...');
  const isConnected = await testConnectivity();
  if (!isConnected) {
    console.warn('⚠️  Avviso: Il server Aviationstack non sembra essere raggiungibile.');
    console.warn('   Questo potrebbe essere un problema temporaneo o di rete.');
    console.warn('   Lo script proverà comunque a connettersi con retry automatici...\n');
  } else {
    console.log('✓ Connettività OK\n');
  }

  console.log('Recupero dati voli...');
  console.log(`Pattern cercati: ${DATE_PATTERNS.join(', ')}`);
  let flight = await fetchActiveFlight();

  if (!flight) {
    console.log("\nNessun volo trovato oggi. Nessun RSS creato.");
    console.log("Motivo: Nessun volo corrisponde ai pattern di data di oggi o l'API non ha restituito dati.");
    return;
  }

  // Estrai informazioni dal volo
  const flightNumber = flight.flight?.number || flight.flight?.iata || 'N/A';
  const flightIata = flight.flight?.iata || '';
  const airlineName = flight.airline?.name || 'Unknown Airline';
  const depAirport = flight.departure?.airport || 'Unknown';
  const depIata = flight.departure?.iata || '';
  const depCity = flight.departure?.city || '';
  const arrAirport = flight.arrival?.airport || 'Unknown';
  const arrIata = flight.arrival?.iata || '';
  const arrCity = flight.arrival?.city || '';
  
  const callsign = flightIata || flightNumber.toString();
  const link = `https://www.flightradar24.com/data/flights/${flightIata || flightNumber}`;
  
  // Determina la data di pubblicazione: usa l'orario di partenza se il volo è schedulato
  let pubDate;
  const flightStatus = flight.flight_status || '';
  const depScheduled = flight.departure?.scheduled;
  const depEstimated = flight.departure?.estimated;
  const depActual = flight.departure?.actual;
  
  // Se il volo è schedulato, usa l'orario programmato di partenza
  if (flightStatus === 'scheduled' && depScheduled) {
    pubDate = new Date(depScheduled).toUTCString();
  } 
  // Se c'è un orario stimato, usalo
  else if (depEstimated) {
    pubDate = new Date(depEstimated).toUTCString();
  }
  // Se c'è un orario effettivo, usalo
  else if (depActual) {
    pubDate = new Date(depActual).toUTCString();
  }
  // Altrimenti usa l'orario corrente
  else {
    pubDate = NOW.toUTCString();
  }
  
  const guid = `${callsign}-${NOW.toISOString().slice(0,10)}`;
  
  // Formatta la data corrente in inglese
  const currentDate = NOW.toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  
  // Descrizione più dettagliata con aeroporti
  let description = `📅 ${currentDate}`;
  description += `\n✈ Flight of the day: ${flightIata || flightNumber} (${airlineName})`;
  if (depIata && arrIata) {
    description += `\n🛫 From: ${depCity || depAirport} (${depIata})`;
    description += `\n🛬 To: ${arrCity || arrAirport} (${arrIata})`;
  }
  
  // Aggiungi informazioni sull'orario se disponibile
  if (depScheduled) {
    const depTime = new Date(depScheduled).toLocaleString('it-IT', { 
      timeZone: 'UTC',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    description += `\n🕐 Scheduled departure: ${depTime} UTC`;
  }
  
  description += `\n🔗 Track live here: ${link}`;

  const rss = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>Flight of the Day</title>
    <link>https://github.com/TCdesign-dev/flight-rss-feed</link>
    <description>Voli del giorno con link live</description>
    <item>
      <title>Flight ${flightIata || flightNumber} del giorno - ${airlineName}</title>
      <link>${link}</link>
      <description><![CDATA[${description}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid>${guid}</guid>
    </item>
  </channel>
</rss>`;

  fs.writeFileSync('flight_feed.xml', rss);
  console.log('\n✓ Feed RSS generato: flight_feed.xml');
  console.log('\n' + description);
}

// --- ESECUZIONE --- //
generateRSS();
