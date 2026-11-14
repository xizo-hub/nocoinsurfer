# NoCoin Surfer — comptes + 1v1 BO3

Nécessite Node 18+ et un hébergeur qui supporte les WebSockets (Render, Railway, Fly.io, VPS…).

    npm install
    npm start        # http://localhost:3000

- `index.html` : le jeu (servi par `server.js`, même domaine).
- Si le jeu est hébergé ailleurs : mets `const SERVER_URL="wss://ton-serveur"` en haut du dernier `<script>` d'`index.html`.
- Les comptes sont stockés dans `data.json` (mots de passe hashés scrypt). Sur un hébergeur à disque éphémère, monte un volume persistant et définis `DB_FILE=/chemin/data.json`.
- Reconnexion auto : un token est gardé dans le navigateur (localStorage).
