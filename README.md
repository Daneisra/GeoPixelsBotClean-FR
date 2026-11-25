# GeoPixelsBotClean-FR

Version française de GhostPixel Bot Clean pour GeoPixels. La version **1.1.16** construit et surveille les images fantômes, suit leur progression et aide à gérer les couleurs et l’énergie. Le script Tampermonkey fonctionne sans serveur supplémentaire. Voir l’[historique des versions](CHANGELOG.md).

## Installation

Installez Tampermonkey, puis ouvrez [le script du dépôt français](https://raw.githubusercontent.com/Daneisra/GeoPixelsBotClean-FR/main/ghostpixel-bot-clean.user.js). Pour tester une version locale, collez le contenu de [`ghostpixel-bot-clean.user.js`](ghostpixel-bot-clean.user.js) dans l’éditeur Tampermonkey et enregistrez-le. Si vous utilisez déjà une autre version de GhostPixel Bot Clean, gardez un seul script actif sur GeoPixels.

## Utilisation

1. Connectez-vous à GeoPixels, puis chargez et positionnez votre image fantôme.
2. Ouvrez le panneau flottant **GhostPixel** et cliquez sur **Synchroniser** pour afficher la progression, l’énergie et le temps estimé.
3. Choisissez les couleurs dans **Palette et filtres** et les zones à traiter sur la carte. Vous pouvez exclure des couleurs, choisir leur ordre de peinture, limiter la sélection aux prioritaires ou privilégier les détails.
4. En mode **Construction**, cliquez sur **Démarrer** pour peindre. Le panneau indique si le prochain groupe attend une recharge et affiche une notification à la fin des envois.

Le bouton **Acheter les couleurs manquantes** vérifie les pixels restants dans les zones sélectionnées et demande confirmation avant chaque lot de cinq couleurs au maximum. Le bouton **Augmenter la capacité d’énergie** utilise le solde de pixels disponible pour acheter des unités de capacité.

### Palette et filtres

Alternez entre **Couleurs du modèle** et **Couleurs du compte**. Chaque ligne affiche un aperçu, le code HEX, la disponibilité et le nombre de pixels du modèle. Après le calcul de la sélection, elle indique aussi le nombre de pixels retenus. La palette s’affiche par pages de vingt couleurs. La recherche par code HEX exact et le bouton **Actualiser** restent disponibles.

La lecture accepte les identifiants numériques, leur équivalent en texte et les codes HEX, dans un tableau ou une liste séparée par des virgules. La réponse du compte a priorité. Si elle omet la liste, le script peut utiliser le profil de la page ou la palette native `Colors` lorsqu’ils sont rattachés au compte actif. La transparence figure séparément des couleurs détenues.

Le panneau distingue **chargement**, **synchronisée**, **indisponible** et **erreur de lecture**. Le diagnostic indique la source retenue, le format détecté, l’état de `Colors` et, s’il est disponible, le code HTTP. Il ne contient ni identifiant de compte ni donnée de session. En cas de problème, cliquez sur **Actualiser** et relevez le diagnostic du panneau. La même fiche est accessible dans la console par `ghostBot.paletteDebug()`.

- **Priorité** fait passer une couleur avant les couleurs sans priorité. **Exclure** la retire de la sélection. Pour peindre ou surveiller uniquement les couleurs prioritaires, activez **Limiter la sélection aux couleurs prioritaires** dans **Règles de sélection**. Une liste prioritaire enregistrée en v1.1.14 ou avant conserve son ancien filtrage lors de la mise à jour. Vous pouvez désactiver ce filtre en gardant vos priorités.
- **Inclure les couleurs de base gratuites** applique la palette de démarrage publiée par GeoPixels. La liste des couleurs détenues vient du compte et est relue après les achats. Les couleurs non détenues sont indiquées comme manquantes uniquement lorsque le compte a pu être vérifié.
- **Inclure les pixels transparents** traite la transparence séparément de la palette de base. En Construction, l’option peut effacer des pixels déjà peints.

Les compteurs se recalculent à partir du modèle et des observations en cache lorsque les filtres changent. Pendant la peinture ou la surveillance, ils se recalculent au prochain passage. Si GeoPixels change le format de sa palette de base, les couleurs détenues restent visibles et leur type est indiqué comme inconnu. Le filtre d’exclusion des couleurs de base demande une palette de base vérifiée.

### Maintenance du modèle

Sélectionnez **Maintenance** puis cliquez sur **Démarrer** pour surveiller le modèle et les zones sélectionnés. Le contrôle inclut les couleurs que vous ne possédez pas. La première lecture établit la référence. Les suivantes utilisent les modifications renvoyées par GeoPixels et affichent le nombre de pixels modifiés depuis le contrôle précédent, jusqu’à cinq exemples avec leurs coordonnées, l’heure du dernier contrôle réussi et l’état de la surveillance. Le mode Maintenance ne lance ni placement ni achat automatique.

Dans **Surveillance du modèle**, réglez l’intervalle entre 10 et 3 600 secondes. La valeur par défaut est de 30 secondes. Vous pouvez aussi activer **Surveiller automatiquement après la construction**. Le script bascule alors seulement après confirmation de tous les pixels sélectionnés. Le mode choisi et les réglages sont conservés. Pour arrêter la surveillance ou reprendre la construction, cliquez sur **Arrêter**, puis choisissez le mode souhaité avant de redémarrer. La surveillance s’exécute tant que l’onglet reste ouvert.

### Gestion de l’énergie

Dans **Réglages de l’énergie**, le mode **Salves** attend 100 % de la capacité du compte au démarrage et à chaque reprise par défaut. Les seuils se règlent séparément en pourcentage ou en unités d’énergie. Un seuil ne peut déclencher une salve que si au moins une unité reste disponible après déduction de la réserve.

La réserve est à zéro par défaut. La taille de groupe `0` utilise l’énergie disponible dans la salve, dans la limite de 5 000 pixels par requête. La salve dépense au plus le budget disponible à son ouverture. À la fin de ce budget, le script attend le seuil de reprise. Le mode **Continu** peint dès que de l’énergie dépasse la réserve et applique la même limite de taille de groupe.

Le panneau affiche **Chargement…** jusqu’à la première lecture de l’énergie actuelle et maximale du compte. Il indique ensuite la phase de la salve, le seuil attendu et le nombre de pixels prévus pour le prochain groupe ou son attente de recharge. Arrêtez la peinture pour modifier ces réglages. La capacité est actualisée en cours de peinture, et le script attend une lecture valide avant tout envoi. Si l’heure du serveur est indisponible, le script se limite à l’énergie déclarée dans la dernière réponse.

Si le résultat d’un envoi est incertain, le script s’arrête. Le bouton **Démarrer** resynchronise alors la carte avant de reprendre. En cas de limitation des envois, le délai indiqué par GeoPixels est respecté avant la reprise. Utilisez un seul onglet pour peindre avec un même compte, car l’énergie est partagée entre les onglets.

### Améliorations automatiques

Dans **Améliorations automatiques**, cochez les achats souhaités et remontez les plus importants avec les flèches. Choisissez ensuite une politique et cliquez sur **Autoriser les achats**. L’autorisation est enregistrée pour le compte GeoPixels actif. Toute modification des réglages d’achat demande une nouvelle autorisation. Les achats sont désactivés par défaut et s’exécutent pendant la peinture, y compris pendant l’attente d’une salve.

- **Désactivé** suspend les achats automatiques.
- **Limité** fixe un plafond cumulé par compte, conservé entre les sessions.
- **Illimité** utilise les Pixels disponibles au-delà de la réserve. Une réserve de `0` permet de dépenser le solde disponible. Si l’amélioration prioritaire dépasse le budget, le script attend que le solde le permette.

Le script lit les tarifs affichés dans la [boutique GeoPixels](https://geopixels.net/) et les données du compte. Il achète une unité à la fois. La vitesse s’arrête au minimum affiché. Pour les couleurs, il tient compte des déblocages gratuits du profil et vérifie sur la carte qu’au moins un pixel sélectionné en a besoin. La recharge de 20 points peut dépasser la capacité lorsque GeoPixels le permet. L’automatisation dépense uniquement les Pixels du jeu.

Le panneau affiche le solde lu, l’ordre actif, le prochain achat, les dépenses confirmées et les blocages. Une confirmation exige une réponse HTTP 200 puis la vérification du débit et de l’amélioration. Une tentative sans confirmation reste en suspens après un rechargement. Si le serveur a renvoyé HTTP 200, une lecture ultérieure du compte peut encore confirmer l’achat. Si la boutique ne fournit plus de tarif lisible ou si le navigateur ne fournit pas le verrou inter-onglets, les achats automatiques sont suspendus. Pour que la vérification des débits reste fiable, effectuez les achats manuels après l’arrêt de la peinture.

Les tests locaux se lancent avec `node --test tests/energy.test.cjs`. Ils simulent GeoPixels et Tampermonkey, y compris les réponses réseau et les achats, en utilisant uniquement des comptes fictifs.

### Grands modèles et progression

Le panneau sépare les pixels confirmés, incorrects, vides et non observés. Les pixels non observés restent dans le total restant et ne sont pas envoyés. Les tuiles sont actualisées par deltas quand un historique complet est disponible. Pendant une séquence d’envois, le script synchronise à intervalles de 30 secondes et avant de reprendre après une attente de recharge. Une réponse de placement sans confirmation déclenche une nouvelle lecture des tuiles concernées au redémarrage. Une modification externe détectée après confirmation peut être traitée au démarrage suivant.

Le temps estimé utilise le débit des groupes confirmés et tient compte du temps d’attente écoulé. L’estimation apparaît dès que deux groupes et deux secondes ont été observés, si tous les pixels restants sont connus. Les grands compteurs sont espacés par milliers. Le bouton **Arrêter** reste accessible pendant le défilement des réglages.

#### Mesures locales

Le [banc d’essai](tests/benchmark.cjs) utilise un modèle synthétique de 1 500 × 1 500 pixels, la priorité intelligente activée et des réponses réseau simulées. Les tuiles sont fournies sous forme de pixels déjà décodés. Les résultats mesurent le travail du userscript sous Node.js 22.23 et excluent la latence réseau, le décodage WebP et le rendu de la carte.

| Traitement | v1.1.12 | v1.1.13 |
| --- | ---: | ---: |
| Analyse et tri initiaux | 14,60 s | 2,62 s |
| Mise à jour à partir de quatre tuiles complètes | 1,86 s | 188 ms |
| Synchronisation par delta | 642 ms | 1 ms |
| 20 mises à jour de progression | 12,83 s | < 1 ms |
| 20 sélections de groupes de 5 000 pixels | 12,96 s | 71 ms |

Dans la même simulation, l’analyse d’un modèle de 4 millions de pixels a pris 4,60 s, avec un intervalle maximal de 16 ms entre les passages de la boucle d’événements pendant l’analyse. La mémoire du cache augmente avec la surface du modèle. Un changement de modèle, de filtres ou de palette peut nécessiter une nouvelle sélection et un nouveau tri.

Pour reproduire la comparaison dans PowerShell, enregistrez le script de la v1.1.12 puis exécutez le même scénario sur les deux fichiers.

```powershell
git show a995066:ghostpixel-bot-clean.user.js | Set-Content -Encoding UTF8 v1.1.12.user.js
node tests/benchmark.cjs v1.1.12.user.js
node tests/benchmark.cjs
```

## Stockage et session

Les réglages du panneau sont enregistrés dans le stockage local de GeoPixels. Les grands modèles utilisent IndexedDB lorsque l’espace disponible dans le stockage local est insuffisant. Le script utilise la session du site pour synchroniser, peindre et effectuer les achats.

Le bouton **Connecter le moniteur** est facultatif. Il transmet l’identifiant du compte et le jeton de session à GhostPixel Monitor sur `127.0.0.1:47631` lorsque vous cliquez dessus.

## Origine et licence

Adaptation française par Daneisra à partir de la version `1.1.9-clean` de [GeoPixelsBotClean](https://github.com/Fox3225/GeoPixelsBotClean), signé Fox3225 et Codex. Distribué sous [licence GNU GPL-3.0](LICENSE).
