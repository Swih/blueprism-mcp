# Cadrage : Claude, développeur Blue Prism

Version 2, 28/09/2026. Statut : **brouillon à valider**. Aucun code produit avant validation. La v1 de ce cadrage (MCP de pilotage du Control Room) est résumée en annexe A.

## 1. La démo visée

> « Construis le parcours Blue Prism pour ce site. »

Claude, l'agent d'orchestration, enchaîne sans intervention humaine :

1. **Scanner** le site : pages, formulaires, navigation, états (chargement, erreurs).
2. **Spier proprement** : pour chaque élément utile, calculer les attributs de correspondance Blue Prism (mode navigateur), vérifier qu'ils sont uniques et stables, et écarter les attributs fragiles.
3. **Créer l'objet** selon les bonnes pratiques, ou **s'adapter à un objet existant** : le relire, respecter ses conventions, ajouter seulement ce qui manque.
4. **Le valider en vrai** : import dans Blue Prism, exécution de chaque action sur le navigateur réel via le Runtime Resource, lecture des logs, correction et nouvelle tentative.
5. **Construire le process** à partir d'un template (file de travail, gestion des exceptions), l'importer et l'exécuter de bout en bout.
6. **Livrer** : `.bprelease` importable, rapport (éléments spiés et pourquoi, règles respectées, résultats des tests).

Ce qui rend la démo forte, c'est que l'objet est **prouvé** sur le vrai Blue Prism, pas seulement généré.

## 2. État de l'art (vérifié le 28/09/2026)

- **SS&C** : Blue Prism 7.5 et 7.5.1 n'ont aucune fonction IA de génération d'objet ou de process. Les nouveautés portent sur le spy Chromium, le mode AA dans les navigateurs, XPath et Index, et les webhooks.
- **[bargemohanesh/nl_to_blueprism](https://github.com/bargemohanesh/nl_to_blueprism)** (1 étoile) : un prompt et quelques exemples, puis un LLM qui écrit le XML d'un squelette de process. Pas d'objet, pas de spy, pas de validation.
- **MCP Blue Prism existants** : pilotage seulement, et aucun ne marche sur ton poste (annexe A).
- **Conclusion** : personne ne fait « site → objet spié et validé → process ». La place est libre.

## 3. Ce que ton poste permet déjà (vérifié)

- Blue Prism 7.5.1, runtime personnel XCP-SNACK sur le port 8181, base LocalDB, authentification native.
- Extensions Blue Prism pour Chrome (`hllemklm…`) et Edge (`hndnjjlc…`) installées de force par stratégie, hôte de messagerie natif enregistré. Chrome 153, Edge 154.
- AutomateC : `/import`, `/publish`, `/run` avec `/startp` typé, `/status`, `/getlog`, `/export`. Le process `MCP Test - Echo` a été importé, lancé et lu.
- Format XML d'un objet web (7.0 à 7.4, vu sur des exports publics) :
  - `apptypeinfo` avec l'id `BrowserLaunch`, le chemin du navigateur et l'URL ;
  - des éléments `WebElement` portant les attributs `wId`, `wName`, `wElementType`, `wClass`, `wXPath`, `wCssSelector`, `wPageAddress`, `wValue`… avec `inuse="True"` pour ceux qui servent à la correspondance ;
  - des étapes `Navigate` (Launch), `Write` (WebWrite), `Read` (WebGetText) et `WaitStart`.

## 4. Principe directeur : le LLM décide, le code écrit le XML

Un LLM qui écrit directement du XML Blue Prism, c'est du « code bancal » assuré : GUID incohérents, liens cassés, schéma approximatif. On sépare les rôles :

```
Claude (raisonne)  →  Spécification typée (IR, JSON validé)  →  Générateur déterministe  →  XML 7.5.1
                             ↑                                                              ↓
                      Linter bonnes pratiques                          Import + exécution réelle (AutomateC)
                             ↑                                                              ↓
                      Lecteur XML → IR (objets existants)  ←──────────  Logs, statuts, erreurs
```

- **IR** : une représentation intermédiaire (modèles pydantic) d'un objet (modèle d'application, éléments, pages, étapes) et d'un process. Claude ne manipule que l'IR.
- **Générateur** : IR → XML, GUID stables, disposition automatique des étapes pour un rendu propre dans Studio.
- **Lecteur** : XML → IR. C'est ce qui permet de s'adapter à un objet existant, avec un test aller-retour garanti.
- **Linter** : règles de bonnes pratiques identifiées (section 6), bloquantes ou en avertissement.

## 5. Composants à construire

| # | Composant | Rôle |
|---|---|---|
| C1 | `bpdev-core` (bibliothèque Python) | IR, générateur, lecteur, linter. Aucune dépendance à Blue Prism, testable partout. |
| C2 | Scanner web | Script DOM injecté dans le navigateur. Pour chaque élément, il calcule les attributs `w*` exactement comme le spy Blue Prism (même format de XPath), le libellé associé et le nombre de correspondances par combinaison d'attributs. C'est le « spy propre ». |
| C3 | Pont Blue Prism | AutomateC (import, publish, export, run, status, getlog) et listener TCP. Secrets dans le Gestionnaire d'identifiants Windows, jamais dans les logs. |
| C4 | Banc de test d'objet | Génère un process de test par action, l'exécute sur le runtime, lit le log et renvoie un verdict structuré par action. C'est la boucle d'auto-correction. |
| C5 | Serveur MCP `bpdev` | Expose C1 à C4 comme outils (scan, lint, build, import, test, export, read). N'importe quel agent peut alors le faire : Claude Code, Claude Desktop. |
| C6 | Skill « développeur Blue Prism » | Le mode opératoire de l'orchestrateur : étapes, conventions de nommage, règles, template, critères d'arrêt. |

## 6. Bonnes pratiques à coder dans le linter (première liste)

**Objets**
- Un objet par application ou zone d'application. **Aucune logique métier** dans un objet.
- Actions standard : `Launch`, `Attach`, `Terminate`, `Wait for <écran>`.
- Chaque navigation est suivie d'une **étape Wait avec condition** et d'un timeout qui lève une `System Exception`. Jamais d'attente fixe arbitraire.
- **Attributs de correspondance** : le plus petit ensemble **unique et stable**. Priorité à `wId`, puis `wName` + `wElementType`, puis un libellé ou un CSS stable. `wXPath` indexé seulement en dernier recours. Jamais `wPageAddress` avec une query dynamique. Attributs dynamiques `[ ]` pour les lignes de tableau.
- Nommage des éléments : `<Écran> - <Champ> <Type>`, par exemple `Login - Username Field`.
- Entrées et sorties documentées (narratives), préconditions et postconditions renseignées.
- Pas de mot de passe dans les data items : passer par le Credential Manager Blue Prism.
- URL et paramètres d'environnement en variables d'environnement.
- Mode d'exécution cohérent (Foreground ou Exclusive pour un navigateur).

**Process**
- Construit sur le template : boucle de file de travail, contrôle de demande d'arrêt, distinction Business et System Exception, retries, fermeture des applications sur exception, compteur d'exceptions consécutives.

**Adaptation d'un objet existant**
- On relit l'objet, on détecte ses conventions (nommage, style d'attach, gestion d'erreurs) et on les prolonge au lieu d'imposer les nôtres. Ce qui existe n'est jamais modifié sans que ce soit signalé.

## 7. Inconnues à lever d'abord (spikes, dans l'ordre)

| Spike | Question | Critère de réussite |
|---|---|---|
| S1 | Format exact d'un objet navigateur **7.5.1** : types d'éléments, IDs d'actions (WebWrite, WebClick…), conditions de Wait, attributs | Un objet de référence **spié à la main dans ton 7.5.1** et exporté, qui devient notre fichier « golden » |
| S2 | Un objet généré s'importe-t-il proprement et reste-t-il lisible dans Studio ? | Import AutomateC sans erreur, ouverture propre dans Studio |
| S3 | Le runtime personnel pilote-t-il Chrome ou Edge via l'extension depuis un process lancé par AutomateC ? | Un process lance le site, écrit dans un champ, clique, lit une valeur, le tout vérifié dans le log |
| S4 | Nos attributs calculés depuis le DOM correspondent-ils à ceux du spy Blue Prism ? | Mêmes valeurs que S1 pour les éléments de référence, en particulier le format du XPath |
| S5 | Template de process : lecture en IR puis régénération identique (aller-retour) | Diff XML nul, ou seulement cosmétique |

S1 à S4 sont la preuve de faisabilité. Si S3 ou S4 échoue, on le saura en jours, pas en semaines.

## 8. Découpage

1. **Phase 0** : ce document, à valider.
2. **Phase 1, spikes S1 à S4** et golden files. Création du repo propre : CI Windows, uv, ruff, mypy strict, pytest.
3. **Phase 2** : IR objet, générateur, lecteur (aller-retour sur les golden files), linter v1.
4. **Phase 3** : scanner web et banc de test d'objet, avec la boucle scan → objet → test → correction sur le site de démo.
5. **Phase 4** : IR process et template (S5), génération et exécution de bout en bout.
6. **Phase 5** : serveur MCP, skill, scénario de démo répété et filmé.

**Terminé** veut dire :
- tests unitaires sur les golden files réels ;
- tests d'intégration contre ton Blue Prism local ;
- aucune dépendance sans version figée ;
- chaque règle du linter a un test ;
- la démo passe 3 fois de suite sans intervention.

## 9. Risques

- **Format non documenté** : le XML n'est pas un contrat officiel. Les golden files par version (7.5.1) et les tests aller-retour détectent toute dérive.
- **Sites instables** : le choix du site de démo compte. Il faut aussi un site local maîtrisé pour les tests reproductibles.
- **Runtime personnel** : il pilote ton écran. Pendant les tests, le navigateur s'ouvre devant toi.
- **Licence** : `maxnumconcproc = 1`, une session à la fois.
- **Propriété intellectuelle** : c'est exactement le métier de Devoteam. Tout se fait sur ton temps et ton matériel, sans aucun élément client, et tu vérifies ta clause de contrat avant de publier.

## 10. Décisions à prendre

- **D1. Site de démo.** Proposition : [RPA Challenge](https://rpachallenge.com), connu de tous les développeurs RPA. Les champs changent de place à chaque tour, ce qui prouve la qualité du spy. On ajoute un mini-site local pour les tests automatisés.
- **D2. Objet de référence (S1).** Il faut ~15 min de ta part : spier 4 ou 5 éléments du site de démo dans ton 7.5.1 et exporter l'objet. C'est la vérité terrain du format.
- **D3. Template de process.** Le tien plus tard, ou celui de SS&C sur Digital Exchange, qui demande un compte.
- **D4. Repo** public dès le départ, ou privé jusqu'à la démo ?

---

## Annexe A : conclusions de la v1 (MCP de pilotage)

- Seulement 2 MCP Blue Prism existent.
  - [Lewis-Nield/blue-prism-v7-mcp](https://github.com/Lewis-Nield/blue-prism-v7-mcp) : bien conçu, mais exige Hub et l'API v7, et n'a jamais été lancé en réel.
  - [wasiakgrzes/blueprism-mcp-server](https://github.com/wasiakgrzes/blueprism-mcp-server) : testé et cassé sur la 7.5.1. Il lance le robot puis répond « erreur » en cherchant « Session ID ». Statut illisible en français, sorties vides.
- On ne s'appuie sur ni l'un ni l'autre. Le pont AutomateC (C3) reprend les enseignements :
  - forcer `/locale en-US` ;
  - parser strictement chaque sortie ;
  - ne jamais répondre « échec » quand une session a été créée ;
  - typer les paramètres de `/startp`.
