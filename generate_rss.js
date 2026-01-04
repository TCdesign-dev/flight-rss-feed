import fs from 'fs';
import fetch from 'node-fetch';

// --- CONFIGURAZIONE API --- //
const AVIATIONSTACK_ACCESS_KEY = process.env.AVIATIONSTACK_ACCESS_KEY; // opzionale, usata solo per info volo
const NOW = new Date();

// --- CREAZIONE PATTERN DATA --- //
const DATE_PATTERNS = (() => {
  const day = String(NOW.getDate()).padStart(2,'0');
  const month = String(NOW.getMonth()+1).padStart(2,'0');

  const numericPatterns = [day, month+day, day+month];

  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const fullMonthName = monthNames[NOW.getMonth()];
  const monthPrefix2 = fullMonthName.substring(0,2).toUpperCase();
  const monthPrefix3 = fullMonthName.substring(0,3).toUpperCase();

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const fullDayName = dayNames[NOW.getDay()];
  const dayPrefix2 = fullDayName.substring(0,2).toUpperCase();
  const dayPrefix3 = fullDayName.substring(0,3).toUpperCase();

  const textPatterns = [monthPrefix2, monthPrefix3, dayPrefix2, dayPrefix3].filter((v,i,a)=>a.indexOf(v)===i);

  return [...numericPatterns, ...textPatterns];
})();

// --- FETCH SICURA --- //
async function fetchJsonSafe(url, retries=3) {
  for(let i=0;i<retries;i++){
    try{
      const controller = new AbortController();
      const timeoutId = setTimeout(()=>controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if(!res.ok){
        if(i===retries-1) return null;
        await new Promise(r=>setTimeout(r,2000*(i+1)));
        continue;
      }
      const text = await res.text();
      try{ return JSON.parse(text); } catch{ return null; }
    }catch{
      if(i===retries-1) return null;
      await new Promise(r=>setTimeout(r,2000*(i+1)));
    }
  }
  return null;
}

// --- FUNZIONE RANKING AVIATIONSTACK --- //
function scoreFlight(flight){
  let score = 0;
  const now = Date.now();
  const dep = flight.departure?.scheduled || flight.departure?.estimated || flight.departure?.actual;
  if(!dep) return -Infinity;
  const depTime = new Date(dep).getTime();
  const diffHours = Math.abs(depTime - now)/36e5;
  score -= diffHours*10;
  if(flight.flight_status==='scheduled') score+=50;
  if(flight.flight_status==='active') score+=30;
  if(flight.flight?.iata) score+=10;
  if(flight.departure?.iata && flight.arrival?.iata) score+=10;

  const searchText = `
    ${flight.flight?.number||""}
    ${flight.flight?.iata||""}
    ${flight.flight?.icao||""}
  `.toUpperCase();
  DATE_PATTERNS.forEach(p=>{ if(searchText.includes(p.toUpperCase())) score+=5; });
  return score;
}

// --- FETCH MIGLIOR VOLO AVIATIONSTACK (oggi) --- //
async function fetchAviationstackFlight(){
  if(!AVIATIONSTACK_ACCESS_KEY || AVIATIONSTACK_ACCESS_KEY==='YOUR_ACCESS_KEY_HERE') return null;
  const baseUrl = "https://api.aviationstack.com/v1/flights";
  const params = new URLSearchParams({ access_key: AVIATIONSTACK_ACCESS_KEY, flight_status:'scheduled', limit:100 });
  const url = `${baseUrl}?${params.toString()}`;
  const data = await fetchJsonSafe(url);
  if(!data?.data || !Array.isArray(data.data)) return null;

  const startUTC = Date.UTC(NOW.getUTCFullYear(),NOW.getUTCMonth(),NOW.getUTCDate(),0,0,0);
  const endUTC   = Date.UTC(NOW.getUTCFullYear(),NOW.getUTCMonth(),NOW.getUTCDate(),23,59,59);

  const scoredFlights = data.data
    .filter(flight=>{
      const dep = flight.departure?.scheduled || flight.departure?.estimated || flight.departure?.actual;
      if(!dep) return false;
      const depTime = new Date(dep).getTime();
      return depTime>=startUTC && depTime<=endUTC;
    })
    .map(f=>({ flight:f, score:scoreFlight(f) }))
    .sort((a,b)=>b.score-a.score);

  return scoredFlights.length ? scoredFlights[0].flight : null;
}

// --- OPEN SKY OAUTH2 TOKEN --- //
let OPENSKY_TOKEN_CACHE = { token: null, expiresAt: 0 };

async function getOpenSkyToken() {
  const now = Date.now();
  if (OPENSKY_TOKEN_CACHE.token && now < OPENSKY_TOKEN_CACHE.expiresAt) {
    return OPENSKY_TOKEN_CACHE.token;
  }

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  const res = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    }
  );

  if (!res.ok) return null;
  const data = await res.json();

  OPENSKY_TOKEN_CACHE.token = data.access_token;
  OPENSKY_TOKEN_CACHE.expiresAt = now + (data.expires_in - 60) * 1000;

  return data.access_token;
}

// --- FETCH MODELLO AEREO DA OPENSKY --- //
async function fetchAircraftModelFromOpenSky(icao24) {
  if (!icao24) return null;

  const token = await getOpenSkyToken();
  if (!token) return null;

  const res = await fetch(
    `https://opensky-network.org/api/metadata/aircraft/icao/${icao24}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) return null;
  const data = await res.json();

  if (!data?.model) return null;

  const manufacturer = data.manufacturerName || '';
  const model = data.model || '';

  return `${manufacturer} ${model}`.trim();
}

// --- FETCH VOLI LIVE OPENSKY (fallback) --- //
async function fetchOpenSkyFlight(){
  try{
    const token = await getOpenSkyToken();
    if(!token) return null;

    const res = await fetch("https://opensky-network.org/api/states/all", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if(!data?.states) return null;

    const match = data.states.find(s=>{
      if(!s[1]) return false;
      const cs = s[1].trim();
      return DATE_PATTERNS.some(p=>cs.includes(p));
    });

    if(!match) return null;

    return {
      flight: { iata: match[1], icao24: match[0] },
      airline: { name: "Unknown Airline" },
      departure: { airport:"Unknown" },
      arrival: { airport:"Unknown" },
      flight_status:'active'
    };

  }catch{
    return null;
  }
}

// --- GENERA RSS --- //
async function generateRSS(){
  console.log('Recupero miglior volo schedulato da Aviationstack...');
  let flight = await fetchAviationstackFlight();

  if(!flight){
    console.log('Nessun volo schedulato trovato, cerco voli live su OpenSky...');
    flight = await fetchOpenSkyFlight();
    if(!flight){
      console.log('Nessun volo live trovato oggi.');
      return;
    }
  }

  // --- ESTRAZIONE INFO --- //
  const flightNumber = flight.flight?.number || flight.flight?.iata || 'N/A';
  const flightIata = flight.flight?.iata || '';
  const airlineName = flight.airline?.name || 'Unknown Airline';
  const depAirport = flight.departure?.airport || 'Unknown';
  const arrAirport = flight.arrival?.airport || 'Unknown';

  const callsign = flightIata || flightNumber.toString();
  const link = `https://www.flightradar24.com/data/flights/${flightIata || flightNumber}`;
  const pubDate = new Date().toUTCString();
  const guid = `${callsign}-${NOW.toISOString().slice(0,10)}`;
  const currentDate = NOW.toLocaleDateString('en-US',{ weekday:'long', day:'numeric', month:'long', year:'numeric' });

  // --- MODELLO AEREO (OpenSky) --- //
  let aircraftModel = null;
  if (flight.flight?.icao24) {
    aircraftModel = await fetchAircraftModelFromOpenSky(flight.flight.icao24);
  }

  // --- DESCRIZIONE PULITA --- //
  let description = `📅 ${currentDate}`;
  
  // Flight info
  if (flightIata || flightNumber) {
    description += `\n✈ Flight of the day: ${flightIata || flightNumber}`;
    if (airlineName) description += ` (${airlineName})`;
  }
  
  // Departure / Arrival
  if (depAirport) description += `\n🛫 From: ${depAirport}`;
  if (arrAirport) description += `\n🛬 To: ${arrAirport}`;
  
  // Aircraft model
  if (aircraftModel) description += `\n🛩 Aircraft model: ${aircraftModel}`;
  
  // Tracking link su OpenSky se disponibile
  if (flight.flight?.icao24) {
    description += `\n🔗 Track live here: https://opensky-network.org/aircraft/${flight.flight.icao24}`;
  } else if (flightIata || flightNumber) {
    // fallback su Flightradar se non c'è icao24
    description += `\n🔗 Track live here: https://www.flightradar24.com/data/flights/${flightIata || flightNumber}`;
  }
  
  // --- RSS --- //
  const rss = `<?xml version="1.0" encoding="UTF-8" ?>
  <rss version="2.0">
    <channel>
      <title>Flight of the Day</title>
      <link>https://github.com/TCdesign-dev/flight-rss-feed</link>
      <description>Daily flights with live tracking</description>
      <item>
        <title>Flight ${flightIata || flightNumber}${airlineName ? ' - ' + airlineName : ''}</title>
        <link>${flight.flight?.icao24 ? `https://opensky-network.org/aircraft/${flight.flight.icao24}` : link}</link>
        <description><![CDATA[${description}]]></description>
        <pubDate>${pubDate}</pubDate>
        <guid>${guid}</guid>
      </item>
    </channel>
  </rss>`;


  fs.writeFileSync('flight_feed.xml',rss);
  console.log('\n✓ Feed RSS generato: flight_feed.xml');
  console.log('\n'+description);
}

// --- ESECUZIONE --- //
generateRSS();
