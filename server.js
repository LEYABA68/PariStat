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
const PORT = process.env.PORT || 4300;
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

  // Marché des buts/points (over/under) si disponible
  let avisTotals = null, totalsInfo = null;
  if (totals.Over && totals.Under) {
    const oOver = avg(totals.Over), oUnder = avg(totals.Under);
    const po = 1 / oOver, pu = 1 / oUnder, s = po + pu;
    avisTotals = { point: totalsPoint, over: +(po / s * 100).toFixed(1), under: +(pu / s * 100).toFixed(1) };
    totalsInfo = {
      point: totalsPoint,
      over: { price: +oOver.toFixed(2), fairProb: +(po / s).toFixed(4) },
      under: { price: +oUnder.toFixed(2), fairProb: +(pu / s).toFixed(4) }
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
    totals: totalsInfo,
    nbBooks: (ev.bookmakers || []).length
  };
}

// Marchés à demander selon le sport (évite les erreurs 422 de marché invalide)
function marketsFor(sport) {
  if (sport.startsWith('soccer')) return ['h2h', 'double_chance', 'draw_no_bet', 'totals', 'btts', 'spreads'];
  if (sport.startsWith('basketball')) return ['h2h', 'spreads', 'totals'];
  if (sport.startsWith('icehockey')) return ['h2h', 'spreads', 'totals', 'btts'];
  if (sport.startsWith('tennis')) return ['h2h', 'totals', 'spreads'];
  return ['h2h', 'totals', 'spreads'];
}

// De-vig par marché : normalisation pour les marchés "complets", sinon retrait de marge forfaitaire
const NORMALIZE = new Set(['h2h', 'btts', 'draw_no_bet', 'spreads']);
function analyseEventDetail(ev) {
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const markets = {};
  for (const bk of ev.bookmakers || []) for (const mkt of bk.markets || []) {
    if (mkt.key.endsWith('_lay')) continue; // ignore les cotes d'échange (Betfair lay)
    const mk = markets[mkt.key] ||= {};
    for (const o of mkt.outcomes) {
      const idKey = (o.description ? o.description + '|' : '') + o.name + (o.point != null ? '|' + o.point : '');
      const slot = mk[idKey] ||= { name: o.name, point: o.point ?? null, desc: o.description || null, prices: [] };
      slot.prices.push(o.price);
    }
  }
  const out = [];
  for (const [key, outs] of Object.entries(markets)) {
    const list = Object.values(outs).map(s => ({ name: s.name, point: s.point, desc: s.desc, price: +avg(s.prices).toFixed(2) }));
    if (key === 'totals') {
      // de-vig par ligne (même point = paire Over/Under)
      const g = {};
      list.forEach(o => { (g[String(o.point)] ||= []).push(o); });
      Object.values(g).forEach(pair => {
        const s = pair.reduce((a, o) => a + 1 / o.price, 0);
        pair.forEach(o => o.fairProb = +(1 / o.price / s).toFixed(4));
      });
    } else if (NORMALIZE.has(key)) {
      const s = list.reduce((a, o) => a + 1 / o.price, 0);
      list.forEach(o => o.fairProb = +(1 / o.price / s).toFixed(4));
    } else {
      // double_chance, player props… : issues non exclusives → retrait de marge forfaitaire ~6 %
      list.forEach(o => o.fairProb = +Math.min(0.97, (1 / o.price) * 0.94).toFixed(4));
    }
    list.sort((a, b) => b.fairProb - a.fairProb);
    out.push({ key, outcomes: list });
  }
  // Ordre d'affichage : résultat d'abord, puis marchés populaires
  const order = ['h2h', 'double_chance', 'draw_no_bet', 'btts', 'totals', 'spreads'];
  out.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  return out;
}

// --- Tous les marchés d'un match ---
app.get('/api/event', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'no_key', message: 'Clé API manquante.' });
  const { sport, id } = req.query;
  if (!sport || !id) return res.status(400).json({ error: 'bad_request', message: 'Paramètres sport et id requis.' });
  const ck = `event:${sport}:${id}:${REGION}`;
  const cached = getCache(ck);
  if (cached) return res.json(cached);
  const tries = [marketsFor(sport), ['h2h', 'totals'], ['h2h']];
  let lastErr = '';
  for (const mks of tries) {
    try {
      const url = `${ODDS_BASE}/sports/${sport}/events/${id}/odds/?apiKey=${API_KEY}&regions=${REGION}&markets=${mks.join(',')}&oddsFormat=decimal`;
      const r = await apiFetch(url, { dispatcher });
      const remaining = r.headers.get('x-requests-remaining');
      if (!r.ok) { lastErr = await r.text(); continue; }
      const ev = await r.json();
      const payload = { id, home: ev.home_team, away: ev.away_team, commence: ev.commence_time, quotaRestant: remaining, markets: analyseEventDetail(ev) };
      setCache(ck, payload);
      return res.json(payload);
    } catch (e) { lastErr = String(e); }
  }
  res.status(502).json({ error: 'upstream', message: lastErr.slice(0, 200) });
});

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
