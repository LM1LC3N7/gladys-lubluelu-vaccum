# Audit du projet — octobre 2026

Audit de `gladys-lubluelu-vaccum` **v0.2.6** (commit `329e59d`, 8 octobre 2026) : structure, qualité,
dépendances, maintenance, sécurité, documentation — puis ce que les dernières versions de Gladys et de son
SDK d'intégration permettent de neuf, et une proposition d'évolution de l'expérience utilisateur.

Les constats marqués **[corrigé]** sont traités dans la même PR que ce document ; les autres sont des
recommandations.

## 1. Synthèse

Projet **sain et bien outillé** pour son âge (5 semaines) : architecture claire en modules courts, code
abondamment commenté, 81 tests sans dépendance, CI en trois jobs (qualité, bridge Python contre le vrai SDK,
build Docker), Dependabot sur les quatre écosystèmes, image multi-arch durcie (non-root, rootfs en lecture
seule, pas de pip/npm à l'exécution).

Les points qui comptent vraiment :

| Priorité | Constat                                                                                                                                                               | Statut        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Haute    | L'image Docker tourne sur **Node 25**, une version impaire (jamais LTS) arrivée en fin de vie le 1er juin 2026 ; la CI, elle, teste sur Node 22.                      | **[corrigé]** |
| Haute    | L'**état réel du robot** (DP `status` : en nettoyage, en charge, retour à la base, en pause…) n'est pas remonté : l'utilisateur ne voit pas ce que fait l'aspirateur. | Proposition   |
| Haute    | En mode **cloud seul** (aucune IP locale connue) ou session locale tombée, **aucun état n'est publié** : batterie, mode, etc. restent figés dans Gladys.              | Proposition   |
| Moyenne  | Deux codes « alias » (`switch_status`/`power_go`, `electricity_left`/`battery_percentage`) produisaient deux features avec le **même `external_id`**.                 | **[corrigé]** |
| Moyenne  | Le SDK 0.14.0 (widgets de dashboard, déclencheurs/actions de scène) attend dans la PR Dependabot #17 — compatible, tests verts.                                       | À merger      |
| Moyenne  | Si le processus Python redémarre, la session Smart Life n'est pas restaurée : la découverte et le repli cloud échouent en silence (log `debug`) jusqu'au redémarrage. | Recommandé    |
| Basse    | Libellés d'options toujours en anglais, `tuyapi` sans release depuis mai 2025, couverture de `local.js` à 29 %, `index.js` non testé.                                 | Recommandé    |

## 2. Structure et architecture

**Points forts**

- Séparation nette : protocole Tuya (`src/tuya/`), logique d'appareil (`src/devices/`), point d'entrée qui ne
  fait que câbler (`index.js`), bridge Python isolé derrière un protocole JSON ligne à ligne.
- Deux méthodes d'onboarding (QR Smart Life / API Cloud) convergent vers **une seule forme** d'entrée de
  registre : tout l'aval (session locale, repli cloud) est commun.
- Features construites **depuis le schéma DP de l'appareil** plutôt que codées en dur : un code inconnu
  donne une feature en moins, jamais un crash.
- Tests de cohérence manifest ↔ code (`test/manifest.test.js`) : bonne pratique rare.

**Points d'attention**

- `index.js` (≈ 330 lignes, toute l'orchestration : refresh, QR, cycle de vie) n'est importé par aucun test —
  il appelle `gladys.connect()` au chargement. Extraire l'orchestration dans un module (`src/app.js`)
  injectable permettrait de la tester avec `test-fixtures/fakeGladys.js`.
- `refreshAndReconcile()` peut s'exécuter **en parallèle** (minuterie + scan manuel + changement de config) :
  deux scans UDP et deux `discover` concurrents sur le bridge. Sans gravité aujourd'hui ; un verrou
  « une seule exécution en vol » (réutiliser la promesse en cours) le supprimerait.
- Les commentaires sont très longs (souvent plus que le code). Ils sont précis et utiles, mais une partie du
  « pourquoi historique » gagnerait à vivre dans les messages de commit/PR plutôt que dans le code.

## 3. Qualité du code et tests

| Contrôle                                                | Résultat                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| Prettier (`npm run format:check`)                       | OK                                                                   |
| ESLint (`npm run lint`, recommended + prettier)         | OK, 0 avertissement                                                  |
| Tests (`npm test`)                                      | 81/81 → **84/84** après cette PR                                     |
| Couverture (`node --test --experimental-test-coverage`) | 88,5 % lignes ; `local.js` 29 %, `dpsSchema.js` 73 %, `index.js` 0 % |
| Ruff (bridge Python, règles E/F/W/B/UP/S/PL/RUF)        | OK (un `noqa: BLE001` inutile car la règle n'est pas activée)        |
| actionlint (workflows GitHub)                           | OK                                                                   |

**Bugs trouvés**

1. **[corrigé] `external_id` dupliqués** (`src/tuya/dpsSchema.js#buildKnownFeatures`) — reproduit : un
   appareil qui expose `switch_status` **et** `power_go` obtenait deux features `vacuum:<id>:power` ; idem
   `electricity_left` + `battery_percentage` → deux `vacuum:<id>:battery`, et les deux DP écrivaient dans la
   même feature (valeurs qui « clignotent »). Désormais le premier alias (ordre de `KNOWN_CODES`) gagne ; les
   `external_id` existants ne changent pas.
2. **DP `status` non mappé** — c'est le DP standard de la catégorie Tuya « Robot vacuum » (`sd`) qui donne
   l'activité (`standby`, `smart_clean`, `charging`, `charge_done`, `goto_charge`, `paused`…, cf. le mapping de
   Home Assistant dans `tuya-device-handlers`). Sans lui, Gladys ne sait pas si le robot nettoie ou dort.
3. **Bouton « Retour à la base » incomplet** — il n'est construit que si l'énumération `mode` contient une
   valeur de type `chargego`. Le DP standard `switch_charge` (booléen « retour à la charge »), présent sur de
   nombreux modèles, est ignoré.
4. **Aucun état en mode cloud** — `NO_IP_LOCAL_CLIENT` permet d'envoyer des commandes par le cloud, mais rien
   ne lit l'état : ni interrogation périodique de `get_status`, ni abonnement MQTT (le SDK Python sait le faire
   : `Manager.refresh_mq()` + `SharingDeviceListener`, c'est ce qu'utilise Home Assistant).
5. **Redémarrage du bridge Python** — `PythonBridge` relance le processus au prochain appel, mais l'état Python
   (session) est perdu ; `restoreSession()` n'est rejoué que sur l'évènement `connected` du WebSocket. Le
   message « No active device-sharing session » est alors journalisé en `debug` : panne silencieuse.
6. **`_serialize_device`** (bridge) lève `KeyError` si une entrée de `local_strategy` n'a pas de
   `status_code` : un seul appareil atypique fait échouer la découverte de **tous** les appareils du compte.
7. **Publication d'états non dédupliquée** — chaque trame `dps` est republiée intégralement (une requête par
   DP). Le SDK recommande `publishStates()` groupé et de ne publier que ce qui change (limite : 300 états/min) ;
   `lastKnownState` existe déjà et permettrait de filtrer.
8. **Langue** — `buildDiscoveredDevice(..., language = 'en')` n'est jamais appelé avec `'fr'` : les libellés
   français de `MODE_LABELS`, `SUCTION_LABELS`… ne sont jamais utilisés.

## 4. Dépendances

Vérifié le 8 octobre 2026 (`npm outdated`, `npm audit`, `pip index versions`, `pip-audit`).

| Dépendance                              | Utilisée              | Dernière              | Commentaire                                                                                                            |
| --------------------------------------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@gladysassistant/integration-sdk`      | 0.13.0                | **0.14.0**            | PR Dependabot #17 ouverte ; testée localement : 81/81. `^0.13.0` n'inclut pas 0.14 (semver 0.x).                       |
| `tuyapi`                                | 7.7.1                 | 7.7.1                 | À jour, gère le protocole 3.5, mais **aucune release depuis le 13 mai 2025** ; `updateKey()` dépend de ses internes.   |
| eslint / globals / prettier (dev)       | 10.10 / 17.12 / 3.9.7 | 10.12 / 17.13 / 3.9.9 | PR Dependabot #19 ouverte.                                                                                             |
| `brace-expansion` (dev, transitive)     | 5.0.9                 | 5.0.12                | **[corrigé]** 3 avis **hauts** (DoS) via eslint → minimatch. Dev uniquement, jamais dans l'image.                      |
| `tuya-device-sharing-sdk`               | 0.2.15                | 0.2.15                | À jour. Pré-1.0 : une version mineure peut casser l'API (bien couvert par le job `python-bridge`).                     |
| `cryptography`, `requests`, `paho-mqtt` | 50.0.2, 2.34.2, 2.1.0 | idem                  | À jour, `pip-audit` : aucune vulnérabilité. `cryptography` est importé par le SDK sans être déclaré : le garder listé. |
| Image `node:*-alpine`                   | 25                    | LTS : **24**          | **[corrigé]** → `node:24-alpine` (voir §5).                                                                            |

## 5. Maintenance et CI/CD

- **[corrigé] Node 25 en production.** Dependabot a proposé `node:26-alpine` (PR #2, fermée sans merge), puis
  `node:25-alpine` (PR #14, mergée). Node 25 est une ligne impaire, jamais LTS, en fin de vie depuis le
  1er juin 2026 : l'image ne reçoit plus de correctifs de sécurité Node. La CI testait sur Node 22 tout en
  affirmant tester « la version de l'image ». Corrections :
  - `Dockerfile` → `node:24-alpine` (LTS jusqu'en avril 2028) ;
  - nouveau `.nvmrc` (`24`), lu par `ci.yml` et `release.yml` (`node-version-file`) ;
  - nouveau `test/runtime.test.js` : échoue si le `FROM node:<major>` du Dockerfile diffère de `.nvmrc` ou si
    la version est impaire — une PR Dependabot comme #14 serait désormais rouge ;
  - `engines.node` : `>=20` (fin de vie avril 2026) → `>=22`.
- **Versions ignorées par Dependabot.** Fermer une PR Dependabot sans la merger lui fait ignorer cette version
  définitivement : c'est le cas de Node 26 (#2), `actions/setup-python` 7 (#4) et `dependabot/fetch-metadata`
  3 (#5). Node 26 passe LTS le 28 octobre 2026 : il faudra le monter **à la main** (Dockerfile + `.nvmrc`) ou via
  `@dependabot recreate`. Même chose pour les deux actions.
- **[corrigé] Commentaire obsolète** dans `dependabot.yml` : la branche par défaut du dépôt est bien `main`
  désormais.
- **[corrigé] Permissions CI** : `ci.yml` n'avait pas de bloc `permissions` et héritait des droits par défaut
  du jeton ; il est maintenant en `contents: read`.
- `release.yml` lance `npx --yes prettier` sans `npm ci` : il télécharge la **dernière** version de Prettier,
  pas celle épinglée — risque de reformatage différent de la CI (et dépendance non verrouillée au moment de
  publier). Recommandé : `npm ci --ignore-scripts` puis `npx prettier`.
- Le job `docker` ne construit que pour `linux/amd64` et ne lance rien dans l'image. Un test de fumée
  (`docker run --rm <image> /opt/venv/bin/python3 -c "import tuya_sharing"`) validerait le venv avec le
  Python d'Alpine (la CI Python teste en 3.12, l'image utilise celui de la version d'Alpine sous-jacente).
- Pas de `CHANGELOG.md` : les notes de release sont générées par GitHub, ce qui suffit à ce stade.
- Sécurité de la chaîne d'approvisionnement (optionnel) : épingler les actions par SHA et l'image de base par
  digest, Dependabot sachant maintenir les deux.

## 6. Sécurité

Bon niveau général : conteneur non-root, rootfs en lecture seule, `npm ci --ignore-scripts`, pas d'outil de
build dans l'image finale, secret Tuya déclaré en type `secret`, session Smart Life stockée hors
`config_schema` (conforme au SDK).

Points à connaître :

- **Identifiant d'application Home Assistant.** Le bridge utilise l'enregistrement public de Home Assistant
  (`HA_3y9q4ak7g4ephrvke`) : l'app Smart Life affiche « Home Assistant » à la confirmation (documenté). C'est
  la seule voie sans compte développeur, mais Tuya pourrait la restreindre : risque de pérennité à suivre.
- **QR rendu par un tiers** (`api.qrserver.com`). Le jeton QR transite par ce service ; il expire en 1-2 min et
  ne suffit pas seul à se connecter (il faut aussi le `user_code` et la confirmation dans l'app), mais
  l'onboarding dépend de la disponibilité d'un service externe.
- `user_code` est un champ `string` (visible en clair dans le formulaire) : acceptable, ce n'est pas un mot de
  passe, mais le passer en `secret` ne coûterait rien.

## 7. Documentation

Très complète (README développeur, docs utilisateur `docs/en.md`/`docs/fr.md` reprises dans Gladys, section
« Tested and confirmed » d'une honnêteté rare). Corrections apportées :

- **[corrigé]** catégorie Tuya des robots aspirateurs : `sd` (« Robot vacuum »), pas `scwxcy` ;
- **[corrigé]** image de base `node:22-alpine` → `node:24-alpine` dans le tableau Dependabot du README.

À reprendre lors de l'évolution proposée : la section « v0.1 scope » (le projet est en 0.2.x) et la liste des
features des docs utilisateur.

## 8. Ce que Gladys propose de nouveau

Dernière version : **Gladys 5.1.4** (2 octobre 2026). Le manifest de l'intégration exige `>=4.86.1` (15 août).

| Version           | Date     | Ce qui compte pour un aspirateur                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.0.0 « Horizon » | 27 août  | Nouveau dashboard à sections et éditeur de scènes refondu ; déclencheur « n'importe quel changement d'état » ; historique activable **par feature** par l'utilisateur (`keep_history` devient une valeur par défaut) ; les numéros de version renvoient aux **GitHub Releases** de l'intégration ; outil IA « niveaux de batterie ». |
| **5.1.0**         | 21 sept. | Les intégrations externes peuvent déclarer des **widgets de dashboard** et des **déclencheurs / actions de scène** (exige `gladys_version >= 5.1.0`, contrôlé par l'indexeur du store). Le `step` des features est respecté par les sliders.                                                                                         |
| 5.1.2 / 5.1.3     | 28 sept. | La page Appareils **signale les appareils « verbeux »** qui remplissent l'historique : ne pas mettre `keep_history` sur la télémétrie rapide (durée/surface de nettoyage…).                                                                                                                                                          |

Côté SDK, **0.14.0** (21 septembre, PR #17) apporte exactement les API correspondantes : `onWidgetGet`,
`onWidgetAction`, `onWidgetGetImage`, `requestWidgetRefresh`, `publishSceneEvent`, `onSceneAction`, plus
`validateWidgetContent()` pour tester un widget. Le README du SDK prend d'ailleurs **un robot aspirateur comme
exemple de widget**, et la spécification des scènes cite « nettoyer ces pièces » (action) et « aspirateur
bloqué » (évènement) comme cas d'usage.

Ce qui existe déjà dans Gladys pour les aspirateurs, et que l'intégration n'utilise pas encore :

- `VACUUM_CLEANER.STATE` (entier : arrêté 0, en marche 1, en pause 2, erreur 3, retour à la base 4, en charge 5,
  sur la base 6) : le widget « Appareils » du cœur l'affiche comme un **badge d'état traduit**, et il est
  utilisable tel quel comme déclencheur de scène (« quand l'aspirateur passe à Sur la base »).
- `MAINTENANCE.LIFE_REMAINING` (déjà utilisé) et `TEXT.SELECT`, que le cœur cite pour les « pièces
  d'aspirateur ».
- Ce qui **n'existe pas** : types aspiration, surface, durée, code d'erreur, pièces/zones — ni carte aspirateur
  dédiée dans le cœur (c'est précisément le rôle des widgets externes), ni outil IA/MCP spécifique aux
  aspirateurs (l'IA voit la batterie et peut lancer une scène).

## 9. Proposition d'évolution : l'aspirateur comme citoyen de première classe

Objectif : qu'un utilisateur voie **d'un coup d'œil ce que fait son robot**, le pilote depuis une vraie carte
du dashboard, et l'intègre à ses scènes sans bricolage. Trois étapes livrables séparément.

### Étape 1 — Voir ce que fait le robot (v0.3.0, compatible Gladys ≥ 4.86.1)

1. **État du robot** : DP `status` → feature `VACUUM_CLEANER.STATE`, avec la table de correspondance de
   référence (celle de Home Assistant / `tuya-device-handlers`) :

   | Valeurs Tuya `status`                                                                                                                         | État Gladys          |
   | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
   | `cleaning`, `smart_clean`, `smart`, `wall_clean`, `wall_follow`, `spot_clean`, `zone_clean`, `part_clean`, `mop_clean`, `random`, `goto_pos`… | En marche (1)        |
   | `paused`                                                                                                                                      | En pause (2)         |
   | `goto_charge`, `docking`                                                                                                                      | Retour à la base (4) |
   | `charging`                                                                                                                                    | En charge (5)        |
   | `charge_done`, `chargecompleted`, `chargego`                                                                                                  | Sur la base (6)      |
   | `standby`, `sleep`                                                                                                                            | Arrêté (0)           |
   | `fault` ≠ 0                                                                                                                                   | Erreur (3)           |

   Gain immédiat : badge traduit dans le dashboard natif et déclencheurs de scène « état de l'appareil »
   sans rien déclarer de plus.

2. **Retour à la base fiable** : utiliser aussi le DP `switch_charge` (booléen), pas seulement une valeur
   `chargego` du `mode`.
3. **États en mode cloud** : quand la session locale est absente ou tombée, publier quand même les états —
   méthode Smart Life : abonnement MQTT du SDK Python (`Manager.refresh_mq()` + `SharingDeviceListener`,
   messages poussés par le bridge sur stdout) ; méthode API Cloud : interrogation de `getStatus` (≈ 60 s).
   Publier via `publishStates()` en ne gardant que les valeurs qui ont changé.
4. **Capteurs standard manquants** (catégorie `sd`) : `clean_area` (m²), `clean_time` (min), `total_clean_*`,
   `duster_cloth` (usure de la serpillière), boutons `reset_filter` / `reset_edge_brush` / `reset_roll_brush`
   / `reset_duster_cloth` (après un remplacement), interrupteurs `switch_disturb` (ne pas déranger) et
   `voice_switch`. Historique **désactivé** sur les valeurs rapides (cf. Gladys 5.1.2).
5. **Erreur lisible** : décoder le bitmap `fault` avec les libellés fournis par le schéma Tuya
   (`values.label`) plutôt qu'afficher un entier.
6. **Robustesse** associée : restaurer la session après un redémarrage du bridge, isoler les erreurs par
   appareil dans `_serialize_device`, dédupliquer les états.

### Étape 2 — Une vraie carte « Aspirateur » sur le dashboard (v0.4.0, exige Gladys ≥ 5.1.0)

Widget `vacuum` déclaré dans le manifest (réglage : l'aspirateur, `source: "devices"`), contenu produit par
`onWidgetGet`, localisé avec la `language` reçue (ce qui règle aussi le problème des libellés anglais) :

```
┌──────────────────────────────────────────────┐
│ Lubluelu SL68                                │  text (heading)
│  [ 87 % ]   [ 42 m² ]   [ 58 min ]           │  jauge batterie + 2 tuiles, live
│ ● État ............ En nettoyage   (bleu)    │
│ ● Mode ............ Intelligent              │  status (≤ 10 lignes)
│ ● Aspiration ...... Forte                    │
│ ● Filtre .......... 12 %           (orange)  │
│ ● Connexion ....... Locale                   │
│ ( ⏸ Pause ) ( 🏠 Base ) ( 📍 Localiser )      │  boutons (≤ 4)
└──────────────────────────────────────────────┘
```

- Tuiles et jauge liées aux features (`device_feature`) : mises à jour en temps réel sans rafraîchissement.
- Boutons contextuels (« Démarrer » ou « Pause » selon l'état), routés vers le `onSetValue` existant ;
  `requestWidgetRefresh('vacuum')` à chaque changement d'état (limité à 1 / 10 s par le cœur).
- Couleurs sémantiques : erreur en `danger`, consommable < 20 % en `warning`, cloud dégradé en `warning`.
- Test unitaire du contenu avec `validateWidgetContent()` (budget : 8 composants, 6 tuiles, 1 status,
  4 boutons).

### Étape 3 — Des scènes qui comprennent l'aspirateur (v0.4.0 ou v0.5.0, Gladys ≥ 5.1.0)

Déclencheurs (`publishSceneEvent`, un évènement par **transition**, jamais un état) :

| Clé                 | Quand                                           | Variables exposées à la scène        |
| ------------------- | ----------------------------------------------- | ------------------------------------ |
| `cleaning_finished` | passage de « en marche » à « en charge / base » | `duration_min`, `area_m2`, `battery` |
| `vacuum_error`      | apparition d'un défaut (bloqué, roue, bac…)     | `error_code`, `error_message`        |
| `consumable_low`    | un consommable passe sous un seuil (ex. 10 %)   | `consumable`, `remaining_percent`    |

Action (`onSceneAction`) : `start_cleaning` — aspirateur, mode, aspiration, débit d'eau optionnels, appliqués
**ensemble** puis départ (impossible aujourd'hui sans enchaîner plusieurs actions « contrôler un appareil »).
Les options étant statiques dans le manifest, elles utilisent un vocabulaire générique
(intelligent / bords / zone / serpillière ; silencieux / normal / fort / max) traduit vers l'énumération propre
à chaque appareil, avec une erreur explicite si l'appareil ne le gère pas.

Scénarios rendus possibles : « quand tout le monde quitte la maison → `start_cleaning` (intelligent, fort) » ;
« `cleaning_finished` → message “Nettoyage terminé : {{area_m2}} m² en {{duration_min}} min” » ;
« `consumable_low` → rappel de commander un filtre ».

**Attention, les clés sont définitives** (règle du SDK : renommer une clé casse les scènes des utilisateurs) :
les noms ci-dessus doivent être validés avant la première publication.

### Plus tard (à instruire)

- **Nettoyage par pièce** (`TEXT.SELECT`, cas prévu par Gladys) : les DP de pièces/zones Tuya sont propres à
  chaque fabricant, il faut des traces d'un vrai SL68.
- **Carte de nettoyage** dans le widget (`image`, ≤ 300 Ko) : dépend de l'accès aux cartes Tuya, à explorer.
- **Protocole 3.5** dans la liste `protocol_version` (`tuyapi` le gère) — à valider avec la découverte UDP des
  appareils 3.5, qui n'émettent pas tous sur les mêmes ports.
- **Node 26** dès son passage LTS (28 octobre 2026).

## 10. Plan d'action recommandé

1. Merger cette PR (Node LTS, correctifs, garde-fou CI), puis la PR Dependabot #17 (SDK 0.14.0) et #19 (outils
   dev).
2. Étape 1 (v0.3.0) : état, retour à la base, états en mode cloud, capteurs standard — sans changer la version
   minimale de Gladys.
3. Étape 2 puis 3 (v0.4.0+) : passer `gladys_version` à `>=5.1.0`, ajouter le widget puis les scènes, après
   validation des clés.
4. Fin octobre : Node 26 LTS (Dockerfile + `.nvmrc`), et relancer `actions/setup-python` 7 /
   `dependabot/fetch-metadata` 3.
