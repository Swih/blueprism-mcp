# Spy dynamique et objets de référence

Relevé du 28 septembre 2026. Les releases privées restent hors du dépôt ; seuls des patterns génériques sont reproduits.

## Structure générée

Les exemples `rpa-challenge.basic-actions.object.json` et `rpa-challenge.form.object.json` séparent le cycle de vie du navigateur des actions du formulaire :

- **Basic Actions** : Launch avec attente de la page, Attach conditionnel, Terminate.
- **Form** : pages privées Attach et Set Field ; sept pages publiques Set Field First Name, Last Name, Company Name, Role in Company, Address, Email et Phone Number ; pages publiques Click Button - Start et Click Button - Submit.
- **Attach** : lire l'état de connexion, tester le flag, attacher seulement si nécessaire, rejoindre le flux. La lecture dépend du mode applicatif : WebIsConnected pour BrowserLaunch, IsConnected pour BrowserAttach dans le catalogue 7.5.1 extrait. Un échec d'Attach remonte au process.
- **Set Field** : appeler Attach, attendre l'existence de la cible, écrire, attendre que WebCheckValue corresponde à `[Value]`, puis relire avec WebGetValue.

Les quatre étapes applicatives de Set Field reçoivent exactement le même `wXPath` dynamique. Les Wait possèdent une branche timeout explicite vers System Exception. Le timeout est un nombre positif littéral ou une référence numérique déclarée, par exemple `[Wait Timeout]` ; la valeur par défaut de l'exemple est 5 secondes. Le process appelant doit fournir un timeout positif. Il n'y a pas de temporisation fixe pour remplacer la vérification d'état.

Les pages publiques encapsulent les XPath propres aux champs. La page privée réutilise la mécanique de saisie. Les chemins d'exception sont séparés du flux principal ; les data items sont dans leur propre colonne et les ancres font 10 × 10.

Le Wait est décalé de 75 unités à gauche de sa condition, selon l'ajustement enregistré dans Studio. Sa taille est explicite (60 × 60), ainsi que celle du timeout (30 × 30). Le bloc d'information est décalé pour garder une marge. Cette disposition évite la superposition du Wait et du libellé de condition sans modifier les liens d'exécution.

Le `WaitEnd` doit aussi précéder le `WaitStart` dans l'ordre XML. Le chargeur 7.5.1 borne la distance de la condition pendant la lecture du WaitStart ; si la fin de son groupe n'est pas encore chargée, cette distance devient zéro, même si le fichier contient 75. Le bouton de condition se superpose alors au Wait et peut réapparaître après une interaction dans Studio. Le chargement natif a confirmé qu'en inversant cet ordre de déclaration, les 75 unités sont conservées. Cela ne change pas l'ordre d'exécution, déterminé par les liens.

Start et Submit vérifient aussi l'état attendu après leur clic. Submit attend le tour suivant identifié par `Next Round XPath`. Un timeout ne relance pas aveuglément le clic : le site peut avoir traité la soumission sans que la confirmation soit encore visible.

## XPath observés sur le site réel

Sur `https://rpachallenge.com/`, chaque input du formulaire est frère de son label, sans liaison `for`/`id` exploitable. Le sélecteur retenu suit cette relation observée :

```xpath
//label[normalize-space(.) = 'First Name']/following-sibling::input
```

Il ne dépend ni de l'ID généré ni de l'ordre du formulaire. L'XPath doit être réévalué pour chaque action ; conserver une référence DOM d'un tour précédent serait une erreur. Le mot **Dynamic** dans Blue Prism signifie que l'étape fournit une expression pour l'attribut, pas que n'importe quel XPath devient robuste.

Vérifications effectuées dans le navigateur, avec des données fictives :

| Observation | Résultat |
| --- | --- |
| 3 chargements × 7 champs | 21 recherches : une cible par XPath |
| Tours 1, 2 et 3 × 7 champs | 21 recherches : une cible par XPath |
| Saisie des 7 champs aux tours 1, 2 et 3 | Valeurs observées dans les champs attendus ; soumissions des tours 1 et 2 |
| ID First Name aux tours 1 → 3 | `tSCwL` → `3V8ux` → `7c7jo` |
| ID Last Name aux tours 1 → 3 | `vXJHB` → `sW7cV` → `475N5` |
| Texte du bouton Start | `Start` dans le DOM, malgré l'affichage CSS `START` |

Ce test vérifie le ciblage face aux redistributions. Ce n'est pas une exécution du challenge complet avec les dix lignes Excel et son score. Une traduction, des libellés dupliqués, un iframe, ou une modification du lien label/input exigeraient un nouveau spy. Ne pas masquer une ambiguïté avec `[1]` ; ajouter un conteneur stable et revérifier l'unicité.

Les helpers `xpathLiteral`, `xpathByAttribute`, `xpathByText`, `xpathByClassToken` et `xpathByLabel` échappent les valeurs. `xpathByLabel` concerne uniquement les liaisons explicites `for`/`id` : il ne convient pas à ce DOM particulier. `assessXPath` émet des avertissements heuristiques ; il ne prouve ni la syntaxe ni la robustesse. Les contrôles sur le DOM restent nécessaires.

## Encodage Blue Prism et validation

Application Modeller : `comparisontype="dynamic"`, `inuse="True"`. Chaque référence d'élément dans Wait/Write/Read/Navigate contient un `elementparameter` avec `name`, `expression`, `datatype` et `comparisontype`.

Les valeurs attendues des Wait utilisent `choice expression="..."`, le format normalisé. Le parseur 7.5.1 distingue cette forme du champ `reply` localisé. Les expressions sont encodées XML sans ajouter des guillemets de chaîne BP autour de `[Value]` ou `True`.

Le parseur natif de Blue Prism 7.5.1 a accepté les deux objets générés (26 et 104 stages). La sonde confirme qu'il conserve `wXPath=[Field XPath]`, type text, comparaison Equal, dans les deux Wait, le Write et le Read, ainsi que `WebCheckValue` comparé à `[Value]`.

L'inspection dans Object Studio a révélé une lecture de connexion inadaptée à BrowserAttach. Elle a été corrigée en séparant les racines Application des deux modes dans le catalogue. Le contrôle natif des stages ne rapporte plus l'erreur 79 correspondante. Ce contrôle hors ligne garde des diagnostics de préconditions/postconditions non renseignées et de type d'exception non défini dans son environnement ; il ne constitue pas une validation complète dans Studio. Les noms des stages et l'espacement ont aussi été ajustés ; cette dernière mise en page reste à revoir visuellement.

## Exécutions réelles dans Blue Prism 7.5.1

Les objets et deux process de test ont été importés sous des noms BPDEV, puis exécutés par le runtime local avec l'extension navigateur Blue Prism et un profil Chrome dédié. Les objets privés de référence n'ont pas été remplacés.

| Scénario | Résultat observé |
| --- | --- |
| Trois tours avec données fictives | Session Completed : 21 saisies avec attente de valeur et relecture, deux soumissions, puis fermeture du navigateur |
| Relecture indépendante via le listener, avant et après correction BrowserAttach | Sortie `Actual Value` : `0100000000` |
| Même scénario après correction BrowserAttach | Session `bd3186d4-7044-420e-aa97-5c9db72c9b95` : Completed |
| Timeout volontaire : demander Start une deuxième fois après le début | Session `c1aa57e6-2672-4169-8463-b50d91823356` : Failed attendu, détail `Start button was not available.` |
| Chemin de récupération du timeout | Un Recover, fermeture du navigateur, rethrow de l'erreur initiale ; aucune boucle de récupération |

Le chemin testé est `Recover → Terminate → rethrow`, sans Resume avant la relance. Resume rendrait la récupération normale à nouveau active, avec le risque de repasser dans le même Recover. Le nettoyage a réussi dans ce test ; un échec du nettoyage peut encore remplacer l'erreur initiale.

Les journaux locaux sont `success-run.log`, `timeout-run.log` et `success-run-final.log` dans `.bpdev/generated/reference-style/`. Le test utilise des données fictives et s'arrête au troisième tour ; il ne prouve pas encore un score de 100 % sur les dix lignes du challenge.

## Reproduire la génération

Génération locale, après extraction du catalogue de l'installation :

```powershell
npm run build
node packages/generator/examples/generate-rpa-demo.js
tools/bpprobe/bin/bpprobe.exe validate '.bpdev/generated/reference-style/BPDEV RPA Challenge - Form.bpobject'
```

Les sorties et le catalogue de l'éditeur restent dans `.bpdev/`, ignoré par Git. Le script n'importe rien dans la base et ne démarre pas de session.

Références officielles : [paramètres dynamiques](https://documentation.blueprism.com/bp-7-5/en-us/frmElementParams.htm), [propriétés des Wait](https://documentation.blueprism.com/bp-7-4/en-us/frmStagePropertiesWait.htm), [ajustement des attributs](https://documentation.blueprism.com/bp-7-4/en-us/Guides/attribute-tuning/attribute-tuning-example.htm), [conventions Wireframer](https://documentation.blueprism.com/hub-interact/5-1/en-us/alm/wireframer/wireframer-complete.htm), [récupération des exceptions](https://documentation.blueprism.com/bp-6-10/en-us/helpExceptions.htm).
