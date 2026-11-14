# NoCoin Surfer — comptes, 1v1 BO3, RR, classement

Serveur (Render, Railway, VPS…) : `npm install` puis `npm start`.
Netlify : dépose seulement `index.html` (SERVER_URL pointe déjà vers wss://nocoinsurfer.onrender.com).

- Ranked : classement par RR (1v1 BO3). Victoire +12 à +40, défaite -10 à -32, minimum 0.
- Normal : classement par meilleur temps (solo + manches de duel).
- Rangs : Bronze 0 · Argent 200 · Or 400 · Platine 700 · Diamant 1000 · Maître 1400.
- Données dans `data.json` (variable `DB_FILE` pour changer l'emplacement).

## Ajouts
- Profil : pdp (upload), police du pseudo, clic sur un joueur du classement = son profil.
- Cosmétiques : pièce et cape (Base / Doré / Galaxie / Perso upload). Images PNG/JPEG/WebP, recadrées 128-160 px côté client, 60 Ko max, magic bytes vérifiés côté serveur.
- Anti-triche serveur : temps client comparés à l'horloge serveur (ticks solo + duel), scores rejetés, 6 points de suspicion = ban auto, pas de duel même IP, max 6 duels/h contre le même adversaire, 3 comptes/IP/jour, anti-flood, limite connexions/IP.
- Anti-triche client : jeu isolé dans une closure (pas d'accès console), détection extensions/userscripts/devtools/horloge truquée/fonctions natives modifiées → ranked et records bloqués.
- Variables Render : `ALLOWED_ORIGINS=https://TON-SITE.netlify.app` (recommandé), `ADMIN_KEY=...`, `DB_FILE` (disque persistant).
- Admin : `/admin/flags?key=`, `/admin/ban?key=&pseudo=`, `/admin/unban?key=&pseudo=`.
- Netlify : déposer `index.html` + `_headers`.
