# 📊 PariStat

Calculateur de statistiques pour paris sportifs — **cotes en direct**, **avis calculés automatiquement** et une boîte à 10 outils pour parier avec méthode et prudence.

> ⚠️ **Outil pédagogique.** Aucune formule ne garantit un gain. Les paris comportent un risque de perte.
> Joue avec modération — **09 74 75 13 13** (Joueurs Info Service, appel non surtaxé).

---

## Fonctionnalités

**Onglets d'analyse**
- 📡 **En direct** — vraies cotes récupérées via l'API, avec proba réelle (marge retirée) et avis automatique
- 📅 **Matchs du jour** — sélection analysée (foot, tennis, basket, hockey)
- ✓ **Paris à tenter** — value sur tous les marchés (BTTS, over/under, buteur, handicap)
- ✎ **Raisonnement** — le cheminement derrière chaque prédiction
- 🎟 **Tickets** — combinés prêts à l'emploi, avec proba réelle vs implicite
- ❓ **Guide** — à quoi sert chaque outil

**10 outils de calcul**
1. Cotes & probabilité implicite
2. Valeur attendue (EV)
3. Mise de Kelly (+ demi-Kelly)
4. Marge du bookmaker (de-vig)
5. Arbitrage / Surebet
6. Pari combiné
7. Analyse de match & taux de risque
8. Modèle foot (Poisson) 1-N-2
9. Risque de ruine (simulation Monte-Carlo)
10. Simulateur d'objectif (intérêts composés)

---

## Installation

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer la clé API
cp .env.example .env
#   puis ouvre .env et colle ta clé ODDS_API_KEY

# 3. Lancer
npm start
```

Ouvre ensuite **http://localhost:4300**.

### Obtenir une clé API (gratuite)

1. Va sur [the-odds-api.com](https://the-odds-api.com) → *Get API Key*
2. Tu reçois une clé gratuite (**500 requêtes / mois**)
3. Colle-la dans le fichier `.env` : `ODDS_API_KEY=ta_cle`

> Sans clé, l'app fonctionne quand même : tous les outils de calcul et les onglets analysés restent disponibles. Seul l'onglet **📡 En direct** a besoin de la clé.

---

## Comment ça marche

```
Navigateur (public/index.html)
        │   fetch('/api/odds?sport=...')
        ▼
Serveur Node/Express (server.js)
        │   appelle The Odds API avec la clé (cachée côté serveur)
        ▼
The Odds API  →  cotes de dizaines de bookmakers
```

Le serveur **calcule les avis** : il moyenne les cotes de tous les bookmakers, **retire la marge** pour obtenir les vraies probabilités, et signale le favori et le niveau de risque.

### Endpoints

| Route | Rôle |
|-------|------|
| `GET /api/sports` | Liste des compétitions disponibles |
| `GET /api/odds?sport=<clé>` | Cotes + avis pour une compétition |
| `GET /api/health` | Vérifie que le serveur tourne |

Exemples de clés sport : `soccer_uefa_nations_league`, `soccer_france_ligue_one`, `soccer_epl`, `basketball_euroleague`, `icehockey_nhl`.

---

## Stack

- **Backend** : Node.js + Express (ES modules)
- **Frontend** : HTML / CSS / JS vanilla, sans dépendance
- **Données** : [The Odds API](https://the-odds-api.com)

## Licence

MIT — voir [LICENSE](LICENSE).
