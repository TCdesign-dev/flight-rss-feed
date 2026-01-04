import fs from 'fs';
import fetch from 'node-fetch';

const AVIATIONSTACK_ACCESS_KEY = process.env.AVIATIONSTACK_ACCESS_KEY;
const NOW = new Date();

// --- CREAZIONE PATTERN DATA --- //
const DATE_PATTERNS = (() => {
  const day = String(NOW.getDate()).padStart(2,'0');
  const month = String(NOW.getMonth()+1).padStart(2,'0');

  const numericPatterns = [day, month+day, day+month];

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                      'July', 'August', 'September', 'October', 'November', 'December'];
  const fullMonthName = monthNames[NOW.getMonth()];
  const monthPrefix2 = fullMonthName.substring(0, 2).toUpperCase();
  const monthPrefix3 = fullMonthName.substring(0, 3).toUpperCase();

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fullDayName = dayNames[NOW.getDay()];
  const dayPrefix2 = fullDayName.substring(0, 2).toUpperCase();
  const dayPrefix3 = fullDayName.substring(0, 3).toUpperCase();

  const textPatterns = [monthPrefix2, monthPrefix3, dayPrefix2, dayPrefix3].filter((v,i,a)=>a.indexOf(v)===i);

  return [...numericPatterns, ...textPatterns];
})();

// --- TEST CONNETTIVITÀ --- //
async function testConnectivity() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    await fetch('https://api.aviationstack.com', { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    return true;
  } catch {
    return false;
  }
}

// --- FETCH SICURA --- //
async function fetchJsonSafe(url, retries = 3) {
  for (let i=0;i<retries;i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) {
        if (res.status === 503) { if (i===retries-1) return null; await new Promise(r=>setTimeout(r, 3000*(i+1))); continue; }
        if (i===retries-1) return null;
        await new Promise(r=>setTimeout(r, 2000*(i+1))); continue;
      }
      const text = await res.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      if (i===retries-1) return null;
      await new Promise(r=>setTimeout(r, 2000*(i+1)));
    }
  }
  return null;
}

// --- FUNZIONI PER RANKING VOLI --- //
function scoreFlight(flight) {
  let score = 0;
  const now = Date.now();
  const dep = flight.departure?.scheduled || flight.departure?.estimated || flight.departure?.actual;
  if (!dep) return -Infinity;
  const depTime = new Date(dep).getTime();
  const diffHours = Math.abs(depTime - now) / 36e5;
  score -= diffHours * 10;
  if (flight.flight_status === 'scheduled') score += 50;
  if (flight.flight_status === 'active') score += 30;
  if (flight.flight?.iata) score += 10;
  if (flight.departure?.iata && flight.arrival?.iata) score += 10;

  const searchText = `
    ${flight.flight?.number || ""}
    ${flight.flight?.iata || ""}
    ${flight.flight?.icao || ""}
  `.toUpperCase();
  DATE_PATTERNS.forEach(p => { if (searchText.includes(p.toUpperCase())) score += 5; });
  return score;
}

// --- FETCH MIGLIOR VOLO OGGI --- //
async function fetchBestFlight() {
  const baseUrl = "https://api.aviationstack.com/v1/flights";
  const params = new URLSearchParams({ access_key: AVIATIONSTACK_ACCESS_KEY, limit: 100 });
  const url = `${baseUrl}?${params.toString()}`;
  const data = await fetchJsonSafe(url);
  if (!data?.data || !Array.isArray(data.data)) return null;

  // --- FILTRA SOLO VOLI DI OGGI (UTC) --- //
  const startOfDayUTC = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 0,0,0));
  const endOfDayUTC   = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 23,59,59));

  const scoredFlights = data.data
    .filter(flight => {
      const dep = flight.departure?.scheduled || flight.departure?.estimated || flight.departure?.actual;
      if (!dep) return false;
      const depTime = new Date(dep).getTime();
      return depTime >= startOfDayUTC.getTime() && depTime <= endOfDayUTC.getTime();
    })
    .map(f => ({ flight: f, score: scoreFlight(f) }))
    .sort((a,b)=>b.score - a.score);

  return scoredFlights.length ? scoredFlights[0].flight : null;
}

// --- GENERA FEED RSS --- //
async function generateRSS() {
  if (!AVIATIONSTACK_ACCESS_KEY || AVIATIONSTACK_ACCESS_KEY==='YOUR_ACCESS_KEY_HERE') {
    console.error('❌ API key non configurata!');
    process.exit(1);
  }

  console.log('Verifica connettività al server Aviationstack...');
  const isConnected = await testConnectivity();
  if (!isConnected) console.warn('⚠️ Server non raggiungibile, proverò comunque.\n');

  console.log('Recupero dati voli...');
  console.log(`Pattern cercati: ${DATE_PATTERNS.join(', ')}`);
  const flight = await fetchBestFlight();

  if (!flight) {
    console.log("\nNessun volo trovato oggi.");
    return;
  }

  // Estrazione info volo
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

  // --- PUBDATE OTTIMIZZATO INTERNATIONALE --- //
  // 14:00 CET (13:00 UTC)
  const pubDateUTC = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 13,0,0));
  const pubDate = pubDateUTC.toUTCString();

  const guid = `${callsign}-${NOW.toISOString().slice(0,10)}`;

  const currentDate = NOW.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  let description = `📅 ${currentDate}`;
  description += `\n✈ Flight of the day: ${flightIata || flightNumber} (${airlineName})`;
  if (depIata && arrIata) {
    description += `\n🛫 From: ${depCity || depAirport} (${depIata})`;
    description += `\n🛬 To: ${arrCity || arrAirport} (${arrIata})`;
  }
  if (flight.departure?.scheduled) {
    const depTime = new Date(flight.departure.scheduled).toLocaleString('it-IT', { timeZone: 'UTC', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
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

generateRSS();
