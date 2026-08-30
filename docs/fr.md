# Lubluelu SL68 (Tuya)

Contrôlez l'aspirateur robot Lubluelu SL68 — et d'autres robots aspirateurs basés sur Tuya/Smart
Life — depuis Gladys, directement sur votre réseau local. Pas de passerelle supplémentaire, pas
besoin de garder l'application du téléphone ouverte.

## Vue d'ensemble

Le contrôle au quotidien (marche/pause, mode, niveau d'eau, aspiration, retour à la base) passe
directement par le réseau local, chiffré de la même façon que l'application Smart Life/Tuya
Smart — aucun aller-retour cloud une fois la configuration terminée. Le compte Tuya Cloud n'est
nécessaire que pour deux choses :

- récupérer le `local_key` de l'appareil, la clé de chiffrement requise pour le contrôle local
  (elle n'est jamais diffusée sur le réseau local, seulement disponible via votre compte Tuya) ;
- connaître les fonctionnalités réellement présentes sur votre aspirateur (marche/pause, mode,
  niveau d'eau, aspiration, batterie...) — lues depuis le catalogue Tuya de votre appareil, sans
  supposition.

Le `local_key` **change** à chaque nouvelle liaison de l'aspirateur au cloud : cette intégration
le revérifie donc périodiquement en arrière-plan (voir « Intervalle de rafraîchissement Tuya
Cloud » ci-dessous) — vous n'aurez jamais à refaire la configuration pour cette raison.

Ces fonctionnalités apparaissent par aspirateur, automatiquement adaptées à ce que votre appareil
signale réellement (tous les aspirateurs n'ont pas toutes ces fonctions) :

- **Power** — marche/pause du nettoyage en cours.
- **Mode** — un menu déroulant (Intelligent, Le long des murs, Zone ciblée, Pièce unique,
  Serpillière, Retour à la base...).
- **Return to dock** — un bouton en un clic, affiché uniquement si la liste des modes de votre
  aspirateur contient une valeur « retour à la base ».
- **Water level** — débit d'eau de la serpillière, si votre aspirateur a une fonction de lavage.
- **Suction power** — si votre aspirateur signale un niveau d'aspiration.
- **Battery** — lecture seule, 0-100 %.
- **Fault code** — lecture seule, 0 en fonctionnement normal.
- **Find robot** — fait biper l'aspirateur, si pris en charge.
- **Roll brush / Side brush / Filter** — usure restante, si votre aspirateur la signale.

## Prérequis

- L'aspirateur déjà configuré et fonctionnel dans l'application **Smart Life** ou **Tuya Smart**.
- Un compte **Tuya IoT Platform** gratuit (distinct de votre compte Smart Life) — le portail
  développeur de Tuya, utilisé uniquement pour lire la clé/le schéma de votre appareil, jamais
  pour le contrôler.
- La **« Découverte réseau locale »** (ou équivalent) activée pour l'appareil dans l'application
  Smart Life/Tuya Smart (généralement activée par défaut) — certains modèles ne diffusent leur
  présence sur le réseau local que si cette option est activée.

## Configuration

1. Rendez-vous sur [iot.tuya.com](https://iot.tuya.com/), créez un projet **Cloud** (le modèle
   gratuit « Smart Home » suffit).
2. Dans l'onglet **Devices** du projet, choisissez **Link Tuya App Account** et scannez le QR
   code avec l'application Smart Life/Tuya Smart utilisée pour l'aspirateur. Ses appareils
   apparaissent alors dans **All Devices**.
3. Copiez l'**Access ID/Client ID** et l'**Access Secret/Client Secret** du projet (onglet
   Overview) dans l'écran de configuration de cette intégration, ainsi que la **région** dans
   laquelle le projet a été créé (visible dans l'URL du projet : eu/us/cn/in).
4. Copiez le **Device ID** de l'aspirateur depuis la liste All Devices dans le champ
   **Identifiant(s) d'appareil** (séparés par des virgules si plusieurs aspirateurs).
5. Enregistrez. Ouvrez l'onglet **Découverte** et lancez un scan — l'aspirateur doit apparaître
   avec les fonctionnalités réellement prises en charge par votre appareil. Ajoutez-le.
6. Deux actions sont alors disponibles depuis l'écran de configuration :
   - **Tester la connexion** — indique si la session locale est active, et le dernier état connu
     de l'aspirateur (ou son état lu via l'API Cloud Tuya si la session locale est indisponible).

### Si l'IP locale de l'aspirateur n'est pas trouvée automatiquement

La découverte s'appuie sur l'annonce de l'aspirateur sur le réseau local (la même diffusion que
celle utilisée par l'application du téléphone). Si votre réseau bloque la diffusion entre segments
(VLAN, certains réseaux Wi-Fi maillés) ou si la « Découverte réseau locale » est désactivée dans
l'application, renseignez le champ **IP(s) locale(s) manuelle(s) (avancé)** :
`device_id=ip`, par exemple `eb1234567890abcdef01=192.168.1.42`. Une IP fixe ou une réservation
DHCP pour l'aspirateur est alors recommandée.

## Une seule connexion à la fois

Comme la plupart des outils de contrôle local Tuya, un seul client peut détenir la session TCP
locale de l'aspirateur à la fois. Garder l'application Smart Life/Tuya Smart ouverte sur l'écran
de l'aspirateur en même temps que cette intégration est connectée peut rendre les deux instables —
c'est une limite du micrologiciel de l'aspirateur lui-même, pas quelque chose que cette
intégration peut contourner.

## Dépannage

- **Découvert mais bloqué sur « non connecté »** : vérifiez le secours d'IP locale manuelle
  ci-dessus, et assurez-vous que rien d'autre (l'application du téléphone, un autre outil
  d'automatisation) ne détient déjà la session locale.
- Badge **« Session locale injoignable, bascule sur l'API cloud Tuya »** : l'intégration continue
  de fonctionner via les commandes/l'état de l'API Cloud Tuya pendant qu'elle retente la connexion
  locale en arrière-plan — les commandes continuent de fonctionner, avec juste plus de latence et
  un aller-retour cloud jusqu'à ce que la session locale soit rétablie.
- **Une fonctionnalité attendue (ex. Water level) est absente** : le catalogue Tuya de votre
  aspirateur ne signale peut-être pas ce code, ou le signale sous un nom que cette intégration ne
  reconnaît pas encore. Consultez les logs de l'intégration (`LOG_LEVEL=debug`) pour voir le
  schéma brut récupéré depuis le Cloud Tuya.
- L'intégration journalise tout ce qu'elle fait : consultez les logs de l'intégration depuis
  l'interface Gladys (ou `docker logs` sur l'hôte) avec `LOG_LEVEL=debug` pour le détail complet.
