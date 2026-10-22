# Wine Cellar Manager with AI Sommelier

Installable web app to manage a wine cellar: stock of bottles, entry by QR code, label photo or manual input, removals with a reason (drunk, sold, given, damaged), full history, and an AI sommelier. Interface in French.

## Features

- Bottle inventory with QR-code scan, label photo or manual entry
- Removals with reason and complete movement history
- Multi-user cellar: the owner shares access by email, with row-level security in the database
- AI sommelier: Supabase Edge Function calling the Gemini API, authenticated, rate-limited per user (80 calls/day by default), reads only the cellar of the signed-in user
- Real-time updates, installable on the phone home screen

## Stack

Vite · JavaScript · Supabase (Postgres, Auth, Row Level Security, Realtime, Edge Functions in TypeScript) · Google Gemini API · Netlify

## Mise en route

### 1. Base de données

Appliquer, dans cet ordre et une seule fois chacun, `supabase/migrations/20261018000000_cave.sql` puis `supabase/migrations/20261018120000_photos_profiles.sql` (photos de bouteilles, profils et photos de profil) : éditeur SQL de Supabase (Dashboard, SQL Editor), coller le fichier, Run.

### 2. Connexion

Dans Supabase, Authentication, Providers, Email : pour une cave familiale, désactiver « Confirm email » évite d'attendre un message de confirmation. Dans Authentication, URL Configuration, renseigner l'adresse du site Netlify dans « Site URL » (utile pour les emails de réinitialisation de mot de passe).

### 3. IA

1. Créer une clé gratuite sur https://aistudio.google.com/apikey (sans carte bancaire).
2. Dans Supabase, Edge Functions, Secrets, ajouter `GEMINI_API_KEY` avec cette clé.
3. Facultatif : `GEMINI_MODEL` (par défaut `gemini-flash-lite-latest`) et `AI_DAILY_LIMIT` (par défaut 80 appels par personne et par jour).

La fonction `supabase/functions/ai/index.ts` exige une connexion, limite l'usage par personne et ne lit la cave qu'avec les droits de la personne connectée.

### 4. Déploiement Netlify

1. Netlify, Add new site, Import an existing project, choisir ce dépôt GitHub.
2. Les réglages sont déjà dans `netlify.toml` (build `npm run build`, dossier `dist`). Aucune variable d'environnement à saisir : l'URL et la clé publique Supabase sont dans `src/config.js` (publiques par conception, la sécurité repose sur les règles d'accès de la base).
3. Renommer le site en `la-cave-de-michel` (Site configuration, Change site name) pour obtenir `la-cave-de-michel.netlify.app`.

### Développement local

```bash
npm install
npm run dev
```

## Utilisation

- Premier compte : créer le compte, puis « Créer cette cave ». Ce compte devient propriétaire.
- Partager : le propriétaire ajoute les autres comptes par email (icône profil en haut à droite).
- QR code : un QR au format JSON (`{"nom":"…","millesime":2015,"type":"rouge","region":"…","prix":40}`) remplit toute la fiche. Un QR contenant un simple texte remplit le nom.
