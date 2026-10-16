# CalSync — iCloud → Google Agenda

Petit serveur Node.js auto‑hébergé qui copie automatiquement les événements de **tes calendriers iCloud** (ceux de l'iPhone, de l'iPad et du Mac) vers **Google Agenda**.

- **Tu choisis les calendriers** : active ou désactive chaque calendrier iCloud et choisis vers quel agenda Google il est envoyé (principal, « Travail », « Famille »…).
- **Modifications répercutées** : un changement de titre, d'horaire ou de lieu est mis à jour dans Google.
- **Suppressions (facultatif)** : un événement supprimé dans iCloud peut aussi être supprimé dans Google.
- **Synchronisation automatique** : la fréquence (5 min à 3 h) et la période couverte (jours passés et à venir) se règlent dans l'interface.
- **Secrets chiffrés** : les identifiants Apple et les jetons Google sont chiffrés en AES‑256‑GCM dans une base SQLite locale.
- **Interface moderne** : tableau de bord clair ou sombre, historique des synchronisations, mise en page adaptée au mobile.

> La synchronisation va **dans un seul sens**, d'iCloud vers Google. Les changements faits dans Google ne sont jamais renvoyés vers iCloud.

---

## Prérequis

- **Node.js 18 ou plus récent**
- Un **compte Apple** avec Calendrier activé dans iCloud (Réglages → [ton nom] → iCloud → Calendrier)
- Un **mot de passe spécifique à l'app** Apple ([appleid.apple.com](https://appleid.apple.com) → Connexion et sécurité → Mots de passe pour app)
- Un **projet Google Cloud** avec l'API Google Calendar activée

> **Attention :** seuls les calendriers **synchronisés avec iCloud** sont accessibles. Ceux qui restent uniquement sur l'appareil (« Sur mon iPhone ») ou qui viennent d'un autre compte (Exchange, Google…) ne sont pas lus.

## 1. Configurer Google Cloud

1. Ouvre la [console Google Cloud](https://console.cloud.google.com/), puis crée ou sélectionne un projet.
2. **API et services → Bibliothèque** : active **Google Calendar API**.
3. **Écran de consentement OAuth** : choisis le type *Externe* et ajoute ton adresse Gmail dans **Utilisateurs test**.
4. **Identifiants → Créer → ID client OAuth**, type **Application Web**.
5. Dans **URI de redirection autorisés**, ajoute `http://localhost:3000/auth/google/callback`.
6. Copie le *Client ID* et le *Client secret*.

L'application demande deux autorisations :
- `calendar.events` pour créer, modifier et supprimer les événements synchronisés ;
- `calendar.calendarlist.readonly` pour lister tes agendas afin que tu puisses choisir une destination.

## 2. Installer et lancer

```bash
git clone git@github.com:4tocall/ios-google-calendar-auto-sync.git
cd ios-google-calendar-auto-sync
npm install
cp .env.example .env
```

Remplis `.env`. Pour générer `SESSION_SECRET` et `ENCRYPTION_KEY`, lance deux fois la commande suivante :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Garde précieusement `ENCRYPTION_KEY`**. Si tu la perds, les identifiants enregistrés ne pourront plus être déchiffrés et il faudra reconnecter les deux comptes.

Ensuite :

```bash
npm start
```

Pendant le développement, `npm run dev` redémarre le serveur automatiquement à chaque modification.

## 3. Utiliser l'interface

Ouvre <http://localhost:3000>, puis :

1. **iCloud** : saisis ton identifiant Apple et le mot de passe spécifique à l'app. La connexion est testée immédiatement.
2. **Google** : clique sur *Connecter Google Agenda* et accepte les autorisations.
3. **Calendriers** : active ceux à synchroniser, choisis l'agenda Google de destination de chacun, puis clique sur *Enregistrer la sélection*.
4. **Options** : règle la fréquence, la période couverte, et indique si les modifications et les suppressions doivent être répercutées.
5. Clique sur **Synchroniser** pour lancer une première synchronisation, puis laisse le serveur tourner.

Si tu mets à jour depuis une ancienne version, clique sur **Réautoriser** dans la carte Google pour accorder la nouvelle permission de lecture de la liste d'agendas.

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Oui | ID client OAuth |
| `GOOGLE_CLIENT_SECRET` | Oui | Secret client OAuth |
| `GOOGLE_REDIRECT_URI` | Oui | Doit correspondre exactement à l'URI déclarée dans Google Cloud |
| `SESSION_SECRET` | Oui | Chaîne aléatoire pour signer les cookies de session |
| `ENCRYPTION_KEY` | Oui | 64 caractères hexadécimaux (clé AES‑256) |
| `PORT` | | Port HTTP (par défaut `3000`) |
| `SYNC_EVERY_MINUTES` | | Fréquence initiale, modifiable ensuite dans l'interface (par défaut `15`) |
| `DB_PATH` | | Chemin de la base SQLite (par défaut `sync.sqlite`) |
| `TZ` | | Fuseau horaire utilisé quand un événement n'en précise pas (par exemple `Europe/Paris`) |

## Fonctionnement

1. Le serveur lit chaque calendrier iCloud sélectionné via **CalDAV** (`caldav.icloud.com`), limité à la période choisie.
2. Chaque événement reçoit un identifiant stable, calculé à partir de l'URL du calendrier et de l'UID iCalendar, ce qui évite les doublons.
3. Une empreinte du contenu permet de mettre à jour un événement seulement s'il a changé.
4. Si tu changes l'agenda de destination d'un calendrier, ses événements sont déplacés.
5. Les événements récurrents sont transmis avec leur règle `RRULE` et leurs exceptions `EXDATE`.

## Limites connues

- Les occurrences **modifiées individuellement** d'une série récurrente (`RECURRENCE-ID`) ne sont pas encore reportées. La série principale l'est.
- Les rappels, les invités et les pièces jointes ne sont pas copiés.
- Le serveur doit **rester allumé** pour que la synchronisation automatique fonctionne (Mac mini, Raspberry Pi, NAS, VPS…).
- L'application est prévue pour **un seul utilisateur** en local. Avant de l'exposer sur Internet, ajoute au minimum HTTPS, une authentification devant l'interface, un stockage de sessions persistant et l'URI OAuth de production.

## Sécurité

- N'utilise **jamais** ton mot de passe Apple principal. Révoque le mot de passe spécifique à l'app si tu n'utilises plus le service.
- `.env` et `sync.sqlite*` sont exclus de Git. Ne les commite jamais.
- Les requêtes d'écriture de l'API exigent un en‑tête `X-Requested-With`, ce qui protège contre les attaques CSRF simples.
- Le bouton *Déconnecter* de Google révoque aussi le jeton côté Google.

## Conseils

Fais un premier essai avec un **agenda Google de test** comme destination, vérifie le résultat, puis choisis ton agenda définitif.

## Licence

Projet personnel, fourni tel quel, sans garantie.
