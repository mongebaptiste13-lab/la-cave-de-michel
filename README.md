# La cave de Michel

Application web pour gérer une cave à vin : bouteilles en stock, ajout par QR code, photo d'étiquette ou saisie, retraits avec motif (bu, vendu, donné, abîmé), historique et sommelier IA.

- **Front** : Vite, JavaScript, installable sur l'écran d'accueil du téléphone.
- **Base et connexion** : Supabase (Postgres, Auth, sécurité par ligne, temps réel).
- **IA** : fonction serveur Supabase `ai` qui appelle l'API Gemini (offre gratuite). La clé reste côté serveur.
- **Hébergement** : Netlify.

## Mise en route

### 1. Base de données

Appliquer `supabase/migrations/20261018000000_cave.sql` une seule fois : éditeur SQL de Supabase (Dashboard, SQL Editor), coller le fichier, Run.

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
