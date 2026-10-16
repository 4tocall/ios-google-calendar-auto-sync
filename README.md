# Sync iCloud → Google Agenda (version automatique)

Cette application récupère les événements des calendriers **iCloud** via CalDAV et les importe dans l'agenda principal Google via Google Calendar API. Une tâche planifiée lance la synchronisation toutes les 15 minutes par défaut.

## Limite importante

Cela fonctionne pour les calendriers Apple **synchronisés avec iCloud**. Une page web ne peut pas lire directement les calendriers locaux de l'iPhone qui ne sont pas synchronisés avec iCloud. Active Calendrier dans les réglages iCloud sur l'iPhone si nécessaire.

## Prérequis

- Node.js 18+
- Un projet Google Cloud avec Google Calendar API activée
- Un compte Apple avec Calendrier iCloud activé et un mot de passe spécifique à l'application

## Configuration Google

1. Va sur https://console.cloud.google.com/
2. Crée/sélectionne un projet et active **Google Calendar API**.
3. Configure l'écran de consentement OAuth et ajoute ton compte comme utilisateur test si l'application est en mode test.
4. Crée un identifiant OAuth de type **Application Web**.
5. Ajoute `http://localhost:3000/auth/google/callback` aux URI de redirection autorisés.
6. Copie `.env.example` vers `.env` et renseigne les valeurs Google.
7. Génère une clé de chiffrement avec :
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   Mets le résultat dans `ENCRYPTION_KEY`. Garde cette clé : sans elle, les secrets stockés ne pourront plus être déchiffrés.

## Lancer en local

```bash
npm install
cp .env.example .env
# complète .env puis :
npm start
```

Ouvre http://localhost:3000, enregistre ton adresse Apple et un mot de passe spécifique à l'application, teste iCloud, puis connecte Google.

## Mot de passe Apple

Génère un mot de passe spécifique à l'application dans les réglages de sécurité du compte Apple. Ne saisis jamais ton mot de passe Apple principal dans cette application. Révoque le mot de passe spécifique si tu n'utilises plus le service.

## Fonctionnement et limites

- Les identifiants Apple et jetons Google sont chiffrés avec AES-256-GCM dans une base SQLite locale.
- OAuth Google utilise un paramètre `state` pour protéger le retour d'authentification.
- La synchronisation est unidirectionnelle iCloud → Google.
- La détection des doublons est persistée dans SQLite et fondée sur l'UID iCalendar combiné au calendrier source.
- Les modifications ultérieures d'un événement déjà importé ne sont pas encore répercutées. Les suppressions source ne sont pas propagées. Les événements récurrents et exceptions peuvent différer selon leur représentation iCalendar.
- Pour un fonctionnement automatique 24/7, le serveur Node.js doit rester en marche. En hébergement, configure HTTPS, un stockage de session persistant et sécurisé, une protection CSRF sur les endpoints de modification, des sauvegardes chiffrées et les URI OAuth de production. Ne publie pas cette configuration locale directement sur Internet.
- Teste d'abord avec un compte et un calendrier de test. La synchronisation crée des événements dans Google ; vérifie le résultat avant de l'utiliser pour un agenda important.
