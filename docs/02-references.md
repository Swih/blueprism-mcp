# Releases de référence : ce qu'elles nous apprennent

Quatre releases réelles (Blue Prism 7.4) ont été fournies le 28/09/2026 comme vérité terrain. **Elles restent hors du repo**, pour trois raisons :
- elles contiennent des noms de personnes dans des chemins ;
- elles contiennent des données scrapées, dont des emails ;
- elles sont le travail de tiers.

Ce document n'en garde que des enseignements génériques.

## 1. Pratique réelle du spy : ce qu'on reprend et ce qu'on vérifie

Sur ~90 éléments web :
- une combinaison fréquente est **`wXPath` + `matchindex`** (39 fois dans le premier relevé), puis `wElementType + wXPath` ;
- `wId` n'apparaît que 13 fois, et **`wCssSelector` jamais**.

Ce décompte ne suffit pas à juger la qualité du spy. La première lecture confondait présence de XPath et fragilité : les objets WttJ et LinkedIn contiennent aussi des XPath sémantiques et des attributs dynamiques réutilisés par les étapes. On reprend leur organisation et leur paramétrage, puis on vérifie chaque cible sur le DOM réel.

Un XPath ancré sur un libellé stable peut résister aux déplacements. Un ID aléatoire ou un CSS fondé sur la position peut casser. Les indices restent possibles pour parcourir une liste, à condition de vérifier le contexte et l'identité de l'item. Le choix XPath/CSS ne remplace donc ni le contrôle d'unicité ni les essais après changement d'état.

Pour RPA Challenge, les sept champs ont été vérifiés avec `//label[normalize-space(.) = 'First Name']/following-sibling::input` et ses variantes. Les identifiants et positions ont changé entre trois chargements puis entre les tours 1, 2 et 3 ; les sélecteurs sont restés uniques. Voir [le relevé et ses limites](06-dynamic-spy.md).

Il y a aussi des éléments **UIA** (Window, UIAButton, UIAComboBox…) pour les fenêtres natives (dialogues, Excel). Il faudra un second mode, après le navigateur.

## 2. Conventions d'objets à reproduire (profil de style par défaut)

- **Un objet par écran** (`<App> - Log In`, `<App> - Search`, `<App> - Search Results`) plus un objet **`<App> - Basic Actions`** : Launch, Attach, Activate, Navigate, Refresh, Detach, Terminate, contrôle de connexion.
- Chaque objet d'écran commence par une page **`Attach`** ou **`AttachIfNot`**.
- Nommage des pages : `Set Field <X>`, `Click Button - <X>`, `Get <X>`, `Navigate to <X>`, `Check <X>`.
- `runmode="Exclusive"`, Wait de **5 s** par défaut sur `WebCheckExists`.
- Exceptions : `System Exception` pour les erreurs techniques (en grande majorité), `Business Exception` pour les règles métier, `System Unavailable Exception` quand l'application est indisponible. Relance de l'exception en cours (`usecurrent`) dans les Recover.
- Documentation abondante : Blocks, Notes et Anchors. Le générateur devra produire des pages **lisibles** dans Studio, pas seulement exécutables.

Ces règles seront un **profil de style configurable**. Une autre équipe pourra fournir le sien.

## 3. Template de process (file de travail)

- **Page principale** : Start Up, Launch Application, puis boucle `Get Next Item` (Validate Item, Work Step 1 à N, Mark Item As Completed, Parent Queue Handling, Reset Global Data), puis contrôle d'arrêt (`IsStopRequested()`, nombre max d'items, heure limite), puis Close Down.
- **Recover de la page principale** : on mémorise l'exception, puis Mark Item As Exception, choix selon le type (Business ou System), puis on reprend la boucle. En cas d'erreur fatale : email, puis on relance l'exception.
- **Chaque Work Step a son Recover** : en cas de System Exception ou d'Internal, nouvel essai (Kill Process, relance de l'application) jusqu'à la limite ; sinon on relance.
- **Start Up** : verrou d'environnement (`Acquire Lock`) avec plusieurs tentatives.
- Dépendances : objets internes (`Work Queues`, `Environment Locking`) et VBO Digital Exchange (`Utility - Environment`, `Utility - General`, `MS Outlook Email VBO`), **absents de la base locale**.

**Conséquence pour le générateur** : on ne génère pas le process. On **lit le template en IR**, puis on ne remplit que les points d'extension :
- Launch Application et Close Down, vers l'objet Basic Actions ;
- les Work Steps, vers les actions des objets d'écran ;
- Validate Item et Populate Queue.

La mécanique de la file et des exceptions reste celle du template.

## 4. Cibles de démo

1. **RPA Challenge** : formulaire à champs mouvants. Cible simple, idéale pour montrer le spy propre.
2. **ACME System 1** (`acme-test.uipath.com`) : cible « complexe » classique en RPA (login, tableau de bord, recherche, résultats, file de travail). On dispose d'un jeu d'objets faits à la main pour la comparaison et pour le scénario « s'adapter à un objet existant ».
