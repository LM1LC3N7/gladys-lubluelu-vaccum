# Lubluelu SL68 (Tuya)

Contrôlez l'aspirateur robot Lubluelu SL68 — et d'autres robots aspirateurs basés sur Tuya/Smart
Life — depuis Gladys, directement sur votre réseau local. Pas de passerelle supplémentaire, pas
besoin de garder l'application du téléphone ouverte.

## Vue d'ensemble

Le contrôle au quotidien (marche/pause, mode, niveau d'eau, aspiration, retour à la base) passe
directement par le réseau local, chiffré de la même façon que l'application Smart Life/Tuya
Smart — aucun aller-retour cloud une fois la configuration terminée. La configuration initiale a
seulement besoin de joindre votre compte Tuya une fois, pour deux choses :

- récupérer le `local_key` de l'appareil, la clé de chiffrement requise pour le contrôle local
  (elle n'est jamais diffusée sur le réseau local, seulement disponible via votre compte Tuya) ;
- connaître les fonctionnalités réellement présentes sur votre aspirateur (marche/pause, mode,
  niveau d'eau, aspiration, batterie...) — lues depuis le catalogue Tuya de votre appareil, sans
  supposition.

Deux façons d'y arriver — choisissez celle qui vous convient, ou configurez les deux :

- **Compte Smart Life (recommandé)** — aucun compte développeur, rien à copier : scannez un QR
  code avec l'application déjà utilisée pour l'aspirateur, et tous les appareils du compte sont
  découverts automatiquement, exactement comme dans l'application officielle.
- **Compte Tuya Cloud (avancé)** — un projet Tuya IoT Platform gratuit, pour celles et ceux qui
  en ont déjà un ou préfèrent le contrôle explicite par appareil qu'il offre.

Le `local_key` **change** à chaque nouvelle liaison de l'aspirateur au cloud : cette intégration
le revérifie donc périodiquement en arrière-plan (quelle que soit la méthode) — vous n'aurez
jamais à refaire la configuration pour cette raison.

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
- La **« Découverte réseau locale »** (ou équivalent) activée pour l'appareil dans l'application
  Smart Life/Tuya Smart (généralement activée par défaut) — certains modèles ne diffusent leur
  présence sur le réseau local que si cette option est activée.

## Configuration — Compte Smart Life (recommandé)

1. Ouvrez l'application sur votre téléphone, allez dans **Moi > Paramètres > Compte et
   sécurité > Code utilisateur**, et copiez-le.
2. Dans l'écran de configuration de cette intégration, collez-le dans **Code utilisateur Smart
   Life**, enregistrez, puis cliquez sur **Connecter votre compte Smart Life**. Un QR code
   s'ouvre.
3. Dans l'application Smart Life/Tuya Smart, appuyez sur **+ > Scanner**, visez le QR code, puis
   validez **Confirmer la connexion**. L'application peut indiquer que la connexion est pour
   « Home Assistant » — c'est normal, cette intégration utilise le même mécanisme officiel Tuya
   que l'intégration Home Assistant ; ne confirmez que si vous venez de lancer cette connexion
   vous-même.
4. Ouvrez l'onglet **Découverte** et lancez un scan — tous les appareils du compte apparaissent
   automatiquement, avec les fonctionnalités que chacun prend réellement en charge. Ajoutez ceux
   que vous voulez.

Et voilà — ajouter un nouvel aspirateur plus tard, c'est juste : l'appairer dans l'application
Smart Life, puis Découverte > Scanner dans Gladys. Rien à configurer par appareil.

## Configuration — Compte Tuya Cloud (avancé)

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
5. Enregistrez, ouvrez l'onglet **Découverte**, lancez un scan, puis ajoutez le(s) appareil(s).

Les deux méthodes peuvent tourner en même temps ; un identifiant d'appareil configuré via le
compte Tuya Cloud est prioritaire sur le même appareil trouvé via le compte Smart Life.

Une action **Tester la connexion** est disponible depuis l'écran de configuration pour chaque
aspirateur ajouté : elle indique si la session locale est active, et le dernier état connu de
l'aspirateur (ou son état lu via le cloud si la session locale est indisponible).

### Si l'IP locale de l'aspirateur n'est pas trouvée automatiquement

La découverte s'appuie sur l'annonce de l'aspirateur sur le réseau local (la même diffusion que
celle utilisée par l'application du téléphone) — la méthode Compte Smart Life fournit aussi l'IP
connue des serveurs Tuya comme seconde source. Si aucune des deux ne la trouve (diffusion
bloquée entre VLAN, certains réseaux Wi-Fi maillés...), renseignez le champ **IP(s) locale(s)
manuelle(s) (avancé)** : `device_id=ip`, par exemple `eb1234567890abcdef01=192.168.1.42`. Une IP
fixe ou une réservation DHCP pour l'aspirateur est alors recommandée.

## Une seule connexion à la fois

Comme la plupart des outils de contrôle local Tuya, un seul client peut détenir la session TCP
locale de l'aspirateur à la fois. Garder l'application Smart Life/Tuya Smart ouverte sur l'écran
de l'aspirateur en même temps que cette intégration est connectée peut rendre les deux instables —
c'est une limite du micrologiciel de l'aspirateur lui-même, pas quelque chose que cette
intégration peut contourner.

## Dépannage

- **Le QR code n'est pas confirmé / expire** : il expire en 1-2 minutes — rouvrez-le (cliquez à
  nouveau sur Connecter) et scannez rapidement. Si l'application ne le reconnaît pas comme
  valide, essayez de changer **Application du QR (avancé)** entre Smart Life et Tuya Smart dans
  l'écran de configuration puis reconnectez-vous.
- **Découvert mais bloqué sur « non connecté »** : vérifiez le secours d'IP locale manuelle
  ci-dessus, et assurez-vous que rien d'autre (l'application du téléphone, un autre outil
  d'automatisation) ne détient déjà la session locale.
- Badge **« Session locale injoignable, bascule sur l'API cloud Tuya »** : l'intégration continue
  de fonctionner via les commandes/l'état du cloud pendant qu'elle retente la connexion locale en
  arrière-plan — les commandes continuent de fonctionner, avec juste plus de latence et un
  aller-retour cloud jusqu'à ce que la session locale soit rétablie.
- **Une fonctionnalité attendue (ex. Water level) est absente** : le catalogue Tuya de votre
  aspirateur ne signale peut-être pas ce code, ou le signale sous un nom que cette intégration ne
  reconnaît pas encore. Consultez les logs de l'intégration (`LOG_LEVEL=debug`) pour voir le
  schéma brut récupéré depuis Tuya.
- L'intégration journalise tout ce qu'elle fait : consultez les logs de l'intégration depuis
  l'interface Gladys (ou `docker logs` sur l'hôte) avec `LOG_LEVEL=debug` pour le détail complet.
