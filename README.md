# GeoPixelsBotClean-FR

Version française de GhostPixel Bot Clean pour GeoPixels. Ce script Tampermonkey peint des images fantômes, suit leur progression et aide à gérer les couleurs et l’énergie. Les fonctions principales utilisent la session GeoPixels ouverte dans le navigateur et fonctionnent sans serveur supplémentaire.

## Installation

Installez Tampermonkey, puis ouvrez [le script du dépôt français](https://raw.githubusercontent.com/Daneisra/GeoPixelsBotClean-FR/main/ghostpixel-bot-clean.user.js). Pour tester une version locale, collez le contenu de [`ghostpixel-bot-clean.user.js`](ghostpixel-bot-clean.user.js) dans l’éditeur Tampermonkey et enregistrez-le. Si vous utilisez déjà une autre version de GhostPixel Bot Clean, gardez un seul script actif sur GeoPixels.

## Utilisation

1. Connectez-vous à GeoPixels, puis chargez et positionnez votre image fantôme.
2. Ouvrez le panneau flottant **GhostPixel** et cliquez sur **Synchroniser** pour afficher la progression, l’énergie et le temps estimé.
3. Choisissez les couleurs et les zones à traiter. Vous pouvez exclure des couleurs, limiter la peinture à une liste de couleurs, privilégier les détails ou corriger d’abord les pixels déjà peints dans une mauvaise couleur. Définissez les zones sur la carte ou saisissez leurs coordonnées.
4. Cliquez sur **Démarrer**. Le script attend la recharge si nécessaire et affiche une notification à la fin.

Le bouton **Acheter les couleurs manquantes** vérifie les pixels restants dans les zones sélectionnées et demande confirmation avant chaque lot de cinq couleurs au maximum. Le bouton **Augmenter la capacité d’énergie** utilise le solde de pixels disponible pour acheter des unités de capacité.

## Stockage et session

Les réglages du panneau sont enregistrés dans le stockage local de GeoPixels. Les grands modèles utilisent IndexedDB lorsque l’espace disponible dans le stockage local est insuffisant. Le script utilise la session du site pour synchroniser, peindre et effectuer les achats.

Le bouton **Connecter le moniteur** est facultatif. Il transmet l’identifiant du compte et le jeton de session à GhostPixel Monitor sur `127.0.0.1:47631` lorsque vous cliquez dessus.

## Origine et licence

Adaptation française par Daneisra à partir de la version `1.1.9-clean` de [GeoPixelsBotClean](https://github.com/Fox3225/GeoPixelsBotClean), signé Fox3225 et Codex. Distribué sous [licence GNU GPL-3.0](LICENSE).
