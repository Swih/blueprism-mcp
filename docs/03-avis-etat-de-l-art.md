# État de l'art et avis (28/09/2026)

## 1. Ce que fait le marché

| Acteur | Ce qu'il fait | Conséquence pour nous |
|---|---|---|
| UiPath Autopilot | Texte vers workflow dans Studio, auto-réparation des sélecteurs (Healing Agent : plusieurs stratégies qui votent, IA + heuristiques) | Les clients UiPath ont un assistant IA de développement. Ceux de Blue Prism non. |
| Power Automate Copilot | Texte vers flux desktop (preview), réparation d'erreurs | Idem |
| SS&C Blue Prism Enterprise | Rien pour générer objets et process. Roadmap : « automatiser des applications en langage naturel », navigateur sans extension. MCP de **pilotage** « Planned » côté Next Gen / WorkHQ. | Le trou est côté **développement**. Le pilotage sera fait par l'éditeur. |
| Blueprint (Assess + Migration) | Analyse de parc (arbres d'appels, complexité, applications à risque) et migration Blue Prism vers UiPath / Power Automate, avec un modèle objet commun | « Diagnostic de parc » : **occupé par un acteur financé**. |
| ValueDX, cabinets | Kits de migration « IA », services | Terrain des intégrateurs, donc de ton employeur. |
| Analyseurs de releases (partenaires Digital Exchange, Release Analyser) | Revue de code payante | Il y a de la demande pour la qualité. L'idée « scanner de code natif » a 30 votes depuis 2023, jamais livrée. |

## 2. Le schéma qui gagne en 2026 : « l'IA compile, le runtime déterministe exécute, on vérifie »

Les projets de référence convergent :
- **workflow-use** (4 200 étoiles) : l'agent réalise la tâche une fois, on en tire un workflow déterministe réutilisable, sans IA à l'exécution. Retour à l'agent seulement si une étape échoue.
- **OpenAdapt** : compile une démonstration en programme ; « VERIFIED » seulement si chaque effet est confirmé par une preuve indépendante ; un humain nommé admet le programme.
- **Stagehand / Playwright MCP** : l'agent observe, on met en cache les actions, on rejoue.
- **Anthropic, « Building effective agents »** : la simplicité d'abord ; boucle évaluateur-optimiseur quand les critères d'évaluation sont clairs ; interface agent-outil soignée. Et dans « Writing tools for agents » : peu d'outils, sans ambiguïté, évalués sur des tâches réelles.

**Blue Prism est exactement un runtime déterministe et gouverné.** Il lui manque le « compilateur » intelligent. C'est notre produit.

## 3. Le workflow recommandé

```
Explorer   → navigateur piloté ; plusieurs chargements pour détecter les attributs volatils
Spier      → attributs uniques ET stables, par ordre de préférence ; unicité vérifiée dans le DOM
IR         → spécification typée (objets par écran + Basic Actions, pages, AWAC)
Générer    → XML déterministe (catalogue AMI 7.5.1, règles de docs/01-spikes.md)
Gate 1     → parseur natif Blue Prism (bpprobe validate)
Gate 2     → bplint (règles existantes + nouvelles règles de spy et de template)
Gate 3     → import + banc de test par action (Attach, Wait, Act, Check), effet vérifié par relecture indépendante
Humain     → relecture dans Studio, publication
```

- Boucle de correction **bornée** (N itérations max), avec un rapport transparent : pourquoi chaque attribut, quelles règles, quels tests.
- Bonnes pratiques Blue Prism intégrées d'office :
  - un objet par écran, plus Basic Actions ;
  - Attach idempotent ;
  - un Wait dynamique avant d'agir, avec un timeout qui lève une System Exception ;
  - aucune logique métier dans les objets ;
  - les exceptions gérées dans le process, via le template ;
  - variables d'environnement et Credentials ;
  - Wait arbitraires interdits.
- Plus tard, l'**auto-réparation gouvernée** : un élément casse en production, on le re-spie, on propose un correctif, il repasse les mêmes gates, puis un humain approuve. C'est l'équivalent Blue Prism du Healing Agent d'UiPath, mais relu avant d'être appliqué.
- **Évaluations** : un banc de sites (RPA Challenge, ACME System 1, the-internet…) avec des métriques. Taux de tests verts, score bplint, nombre de retouches humaines, stabilité après rechargement.

## 4. Place de bplint

bplint devient **la Gate 2** et le juge de la boucle évaluateur-optimiseur. À faire :
1. Un parseur **sans perte**, qui lit aussi `appdef` (aujourd'hui seulement détecté). Il sert à la fois au linter et au générateur, et garantit l'aller-retour.
2. De nouvelles règles **BP-SPY-*** : XPath absolu sans attribut stable, `matchindex`, `wPageAddress` avec query dynamique, élément sans attribut `inuse`, doublons.
3. De nouvelles règles **BP-TPL-*** : conformité au template de file de travail.
4. Re-sourcer les règles « heuristiques », corriger le README (46 contre 43 règles, 62 contre 77 tests).
5. **Avant tout passage en public** : purger les fixtures (`real-release.bprelease`…), qui peuvent contenir des données personnelles (noms, emails, offres scrapées).

## 5. Avis

- **Le cœur** : « Claude, développeur Blue Prism gouverné ». C'est l'angle le plus défendable, avec un trou réel chez l'éditeur, une tendance du marché alignée, et un savoir-faire technique déjà prouvé (catalogue AMI, validateur natif, runtime piloté). bplint en est le garant qualité.
- **Le diagnostic de parc** : une extension plus tard (bplint + explications par LLM), pas le cœur. Il est occupé par Blueprint Assess, et c'est le métier des intégrateurs.
- **Le MCP de pilotage** : ne pas en faire un produit. L'éditeur le planifie, et un repo communautaire existe. On garde seulement les outils nécessaires au banc de test.
- **Langage : je recommande de passer à TypeScript** (au lieu de Python), pour réutiliser bplint, Playwright (natif TypeScript) et le SDK MCP TypeScript dans un seul monorepo. `bpprobe` reste en C#, parce que c'est le pont vers les DLL Blue Prism.

## Sources

- UiPath Autopilot, génération de workflow : https://docs.uipath.com/autopilot/other/latest/user-guide/text-to-workflow
- UiPath Healing Agent : https://docs.uipath.com/agents/automation-cloud/latest/user-guide-ha/what-is-healing-agent
- Power Automate Copilot desktop : https://learn.microsoft.com/en-us/power-automate/desktop-flows/copilot-in-power-automate-for-desktop
- Roadmap SS&C 2026 : https://www.blueprism.com/resources/blog/agentic-automation-roadmap-2026/
- Idée MCP (Planned) : https://community.blueprism.com/t5/Product-Ideas/Blue-Prism-integration-with-MCP-Server/idi-p/123210
- Idée scanner de code (30 votes) : https://community.blueprism.com/t5/Product-Ideas/Request-for-a-Built-In-Code-Scanning-Tool-in-Blue-Prism/idi-p/103171
- Blueprint migration / Assess : https://www.blueprintsys.com/solutions/rpa-migration , https://www.blueprintsys.com/blog/part-1-lifting-the-lid-on-rpa-migration
- ValueDX : https://valuedx.com/blue-prism-bot-migration-to-automationedge/
- Augmenter puis remplacer (RPA vers agents) : https://www.kognitos.com/blog/the-2026-guide-to-replace-rpa-with-ai-agents/
- Bonnes pratiques de développement Blue Prism : https://portal.blueprism.com/system/files/2018-01/Blue%20Prism%20-%20Development%20Best%20Practice.pdf
- workflow-use : https://github.com/browser-use/workflow-use
- OpenAdapt : https://github.com/OpenAdaptAI/OpenAdapt
- Stagehand : https://github.com/browserbase/stagehand
- Anthropic, agents : https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, outils : https://www.anthropic.com/engineering/writing-tools-for-agents
