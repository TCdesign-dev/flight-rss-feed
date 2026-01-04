import fs from 'fs';
import fetch from 'node-fetch';

// --- CONFIGURAZIONE API --- //
const AVIATIONSTACK_ACCESS_KEY = process.env.AVIATIONSTACK_ACCESS_KEY;
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

// --- FETCH VOLI LIVE OPENSKY (fallback) --- //
async function fetchOpenSkyFlight(){
  try{
    const res = await fetch("https://opensky-network.org/api/states/all");
    const data = await res.json();
    if(!data?.states) return null;

    const match = data.states.find(s=>{
      if(!s[1]) return false;
      const cs = s[1].trim();
      return DATE_PATTERNS.some(p=>cs.includes(p));
    });

    if(!match) return null;

    let flight = {
      flight:{ iata: match[1] },
      airline:{ name: "Unknown Airline" },
      departure:{ airport:"Unknown" },
      arrival:{ airport:"Unknown" },
      flight_status:'active'
    };

    // --- PROVA A RECUPERARE INFO SU AVIATIONSTACK --- //
    if(AVIATIONSTACK_ACCESS_KEY){
      const baseUrl = "https://api.aviationstack.com/v1/flights";
      const params = new URLSearchParams({ access_key:AVIATIONSTACK_ACCESS_KEY, flight_iata:match[1], limit:1 });
      const url = `${baseUrl}?${params.toString()}`;
      const avData = await fetchJsonSafe(url);
      const avFlight = avData?.data?.[0];
      if(avFlight){
        flight.airline.name = avFlight.airline?.name || flight.airline.name;
        flight.departure.airport = avFlight.departure?.airport || flight.departure.airport;
        flight.departure.iata = avFlight.departure?.iata || '';
        flight.arrival.airport = avFlight.arrival?.airport || flight.arrival.airport;
        flight.arrival.iata = avFlight.arrival?.iata || '';
        flight.flight.icao = avFlight.flight?.icao || null; // aggiunto per modello
      }
    }

    return flight;
  }catch{
    return null;
  }
}

// --- RECUPERA MODELLO AEREO --- //
async function fetchAircraftModel(icaoCode){
  if(!AVIATIONSTACK_ACCESS_KEY || !icaoCode) return null;
  const baseUrl = "https://api.aviationstack.com/v1/aircraft_types";
  const params = new URLSearchParams({ access_key:AVIATIONSTACK_ACCESS_KEY, icao_code:icaoCode });
  const url = `${baseUrl}?${params.toString()}`;
  const data = await fetchJsonSafe(url);
  const type = data?.data?.[0];
  if(!type) return null;
  return `${type.manufacturer_name||''} ${type.aircraft_name||''}`.trim();
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
  const flightIcao = flight.flight?.icao || null;

  const callsign = flightIata || flightNumber.toString();
  const link = `https://www.flightradar24.com/data/flights/${flightIata || flightNumber}`;
  const pubDate = new Date().toUTCString();
  const guid = `${callsign}-${NOW.toISOString().slice(0,10)}`;
  const currentDate = NOW.toLocaleDateString('en-US',{ weekday:'long', day:'numeric', month:'long', year:'numeric' });

  // --- MODELLO AEREO --- //
  let aircraftModel = null;
  if(flightIcao) aircraftModel = await fetchAircraftModel(flightIcao);

  // --- DESCRIZIONE --- //
  let description = `📅 ${currentDate}`;
  description += `\n✈ Flight of the day: ${flightIata || flightNumber} (${airlineName})`;
  description += `\n🛫 From: ${depAirport}`;
  description += `\n🛬 To: ${arrAirport}`;
  if(aircraftModel) description += `\n🛩 Aircraft model: ${aircraftModel}`;
  description += `\n🔗 Track live here: ${link}`;

  // --- RSS --- //
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

  fs.writeFileSync('flight_feed.xml',rss);
  console.log('\n✓ Feed RSS generato: flight_feed.xml');
  console.log('\n'+description);
}

// --- ESECUZIONE --- //
generateRSS();
