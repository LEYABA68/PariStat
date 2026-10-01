// PariStat — serveur Node/Express
// Sert le frontend et expose une API qui va chercher les cotes en direct
// sur The Odds API (https://the-odds-api.com), en gardant la clé côté serveur.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch as apiFetch, ProxyAgent } from 'undici';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Réseau d'entreprise : si un proxy est défini, on le fait suivre aux appels API
// (sans ça, Node ignore les variables proxy et les appels échouent en timeout).
// À la maison (sans proxy), dispatcher = undefined → connexion directe normale.
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
              process.env.https_proxy || process.env.http_proxy;
const dispatcher = PROXY ? new ProxyAgent(PROXY) : undefined;

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const REGION = process.env.ODDS_REGION || 'eu'; // eu | uk | us | au

app.use(express.static(path.join(__dirname, 'public')));

// --- Petit cache mémoire pour économiser le quota de l'API (5 min) ---
const cache = new Map();
const TTL = 5 * 60 * 1000;
function getCache(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  return null;
}
function setCache(key, v) { cache.set(key, { t: Date.now(), v }); }

// --- Calcul : retrait de la marge (de-vig) + avis automatique ---
function analyseEvent(ev) {
  // Moyenne des cotes h2h sur tous les bookmakers, par issue
  const prices = {}; // name -> [cotes]
  let totalsPoint = null;
  const totals = {}; // "Over"/"Under" -> [cotes]
  for (const bk of ev.bookmakers || []) {
    for (const mkt of bk.markets || []) {
      if (mkt.key === 'h2h') {
        for (const o of mkt.outcomes) {
          (prices[o.name] ||= []).push(o.price);
        }
      }
      if (mkt.key === 'totals') {
        for (const o of mkt.outcomes) {
          (totals[o.name] ||= []).push(o.price);
          if (o.point != null) totalsPoint = o.point;
        }
      }
    }
  }
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const outcomes = Object.entries(prices).map(([name, arr]) => ({ name, price: +avg(arr).toFixed(2) }));
  if (!outcomes.length) return null;

  // Probabilités implicites puis "justes" (sans marge)
  const implied = outcomes.map(o => 1 / o.price);
  const overround = implied.reduce((a, b) => a + b, 0);
  const fair = outcomes.map((o, i) => ({
    name: o.name,
    price: o.price,
    fairProb: implied[i] / overround,
    fairOdds: +(overround / implied[i]).toFixed(2)
  }));
  const margin = (overround - 1) * 100;

  // Avis automatique basé sur la proba réelle du favori
  const favorite = fair.reduce((a, b) => (b.fairProb > a.fairProb ? b : a));
  let niveau, texte;
  if (favorite.fairProb >= 0.60) { niveau = 'low'; texte = `Favori net : ${favorite.name}`; }
  else if (favorite.fairProb >= 0.48) { niveau = 'mid'; texte = `Léger favori : ${favorite.name}`; }
  else { niveau = 'high'; texte = 'Match très serré — prudence'; }

  // Avis sur les buts (si marché totals disponible)
  let avisTotals = null;
  if (totals.Over && totals.Under) {
    const po = 1 / avg(totals.Over), pu = 1 / avg(totals.Under);
    const s = po + pu;
    avisTotals = {
      point: totalsPoint,
      over: +(po / s * 100).toFixed(1),
      under: +(pu / s * 100).toFixed(1)
    };
  }

  return {
    id: ev.id,
    sport: ev.sport_title,
    sportKey: ev.sport_key,
    commence: ev.commence_time,
    home: ev.home_team,
    away: ev.away_team,
    outcomes: fair,
    margin: +margin.toFixed(2),
    avis: { pick: favorite.name, fairProb: +(favorite.fairProb * 100).toFixed(1), niveau, texte },
    avisTotals,
    nbBooks: (ev.bookmakers || []).length
  };
}

// --- Liste des sports actifs ---
app.get('/api/sports', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'no_key', message: 'Clé ODDS_API_KEY manquante dans .env' });
  try {
    const cached = getCache('sports');
    if (cached) return res.json(cached);
    const r = await apiFetch(`${ODDS_BASE}/sports/?apiKey=${API_KEY}`, { dispatcher });
    if (!r.ok) throw new Error(`API ${r.status}`);
    const data = await r.json();
    setCache('sports', data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'upstream', message: String(e) });
  }
});

// --- Cotes en direct pour un sport ---
app.get('/api/odds', async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      error: 'no_key',
      message: "Clé API manquante. Copie .env.example en .env et renseigne ODDS_API_KEY (clé gratuite sur the-odds-api.com)."
    });
  }
  const sport = req.query.sport || 'soccer_uefa_nations_league';
  const cacheKey = `odds:${sport}:${REGION}`;
  try {
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const url = `${ODDS_BASE}/sports/${sport}/odds/?apiKey=${API_KEY}&regions=${REGION}&markets=h2h,totals&oddsFormat=decimal`;
    const r = await apiFetch(url, { dispatcher });
    const remaining = r.headers.get('x-requests-remaining');
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: 'upstream', status: r.status, message: body });
    }
    const raw = await r.json();
    const events = raw.map(analyseEvent).filter(Boolean)
      .sort((a, b) => new Date(a.commence) - new Date(b.commence));
    const payload = { sport, region: REGION, quotaRestant: remaining, count: events.length, events };
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: 'upstream', message: String(e) });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, hasKey: !!API_KEY }));

app.listen(PORT, () => {
  console.log(`\n  PariStat en ligne  →  http://localhost:${PORT}`);
  console.log(`  Clé API détectée   →  ${API_KEY ? 'oui ✓' : 'NON — ajoute ODDS_API_KEY dans .env'}`);
  if (PROXY) console.log(`  Proxy détecté      →  ${PROXY}`);
  console.log('');
});
