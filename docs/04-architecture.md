# Architecture du socle (contrat pour tout contributeur, humain ou agent)

Nom de travail : **bpdev**. Ce document est la référence. En cas de doute, il prime sur toute autre consigne.

## Principes

1. **Le LLM décide, le code écrit le XML.** Aucun XML Blue Prism n'est produit par concaténation de chaînes ni par un prompt. Tout passe par des modèles typés et des sérialiseurs testés.
2. **Aller-retour sans perte.** Lire un fichier Blue Prism puis le réécrire donne un XML équivalent. C'est la condition pour « s'adapter à un objet existant ».
3. **Déterminisme.** Même entrée, même sortie, octet pour octet (GUID dérivés de chemins stables, ordre stable).
4. **Vérité terrain Blue Prism.** Les règles de format viennent de [01-spikes.md](01-spikes.md) (vérifiées sur 7.5.1) et du catalogue extrait par `bpprobe`. On n'invente pas de format.
5. **Simple, lisible, testé.** De petits modules, pas d'abstraction spéculative. Chaque règle de format a un test.
6. **Réutiliser avant de générer.** Pour une capacité nécessaire au scénario en cours, inspecter d'abord les fonctions natives et les objets déjà disponibles, puis chercher un composant adapté sur le Digital Exchange. Le générateur doit savoir appeler une action existante avec sa vraie signature ; il ne doit pas recréer systématiquement son implémentation.

## Prochain jalon et ordre de travail

Priorité précisée le 29/09/2026 : finir une v1 bornée avant publication sous **Swih/blueprism-mcp**, licence **MIT**. L'objectif reste « site → objet BP → process validé ». Un seul scénario sert de fil conducteur : **template → queue → objet web → résultat de l'item**. L'enrichissement API est facultatif pour cette v1.

1. **Consolider le socle** : corriger les défauts de secrets, de résultat indéterminé et d'assertions relevés dans l'audit ; tester le pont et les exemples effectivement montrés. Terminer la validation visuelle des Wait en conservant les ajustements enregistrés dans Studio.
2. **Fermer la boucle MCP sur le scénario existant** : exposer des outils typés pour préparer, valider, importer, lancer, suivre et vérifier. Associer logs, erreur initiale et preuves au run ; tester capture native et diagnostic avant nettoyage. Aucun succès métier déduit du seul statut Completed.
3. **Automatiser le spy** : observer le DOM et vérifier les sélecteurs dans BP. Pour cette v1, produire des versions distinctes et refuser l'écrasement des objets existants. L'ajout automatique de pages ou d'éléments à un objet humain reste une évolution ultérieure.
4. **Faire fonctionner le template avec une queue** : création et alimentation contrôlées, consommation, succès/exception, reprises bornées, arrêt et redémarrage. Ajouter uniquement les credentials et paramètres nécessaires à ce scénario.
5. **Préparer la livraison** : serveur MCP minimal, skill portable, README d'installation, démo enregistrée et vérification du contenu public et de l'historique Git. Le compte BP reste exclusivement dans l'environnement local exclu de Git.
6. **Rejouer et livrer ce scénario via un LLM neuf** : artefacts reproductibles, dépendances identifiées, validation native et résultats métier vérifiés, sans lui fournir notre historique de construction BP.

Le jalon est terminé quand la boucle est dans le code produit, les corrections de revue passent leurs tests et le scénario template/queue/web a un succès, un échec et une reprise vérifiés. Une session Completed ne suffit pas : contrôler le résultat métier et l'absence de double effet. Livrer le MCP, sa skill, la démo et le README. L'[audit MCP](08-audit-mcp.md) conserve l'état initial et les tests détaillés ; les extensions API restent dans [07-api-integrations.md](07-api-integrations.md).

Après cette v1, l'expérience de moteur web/API autonome sera limitée dans le temps et comparée sur le même scénario : temps de construction, résultat face aux perturbations, diagnostic, reprise et coût. D'ici là, conception dans un document uniquement, aucun second produit. Le scanner conserve des observations et sélecteurs neutres ; leur traduction AMI reste dans le générateur BP. Développement original, dépendances tierces identifiées normalement ; crédits à Swih, Codex et Claude, sans dédicace.

Les API entrantes, l'installation Hub/API, les webhooks et la généralisation à d'autres familles d'applications restent prévus après ce jalon, sauf si l'utilisateur change la priorité. Un petit site inédit fait toutefois partie de l'évaluation du MCP, pour vérifier qu'il ne dépend pas uniquement de RPA Challenge. Une recherche DX reste limitée au besoin de l'étape active ; ce n'est pas un chantier d'inventaire exhaustif.

## Utilisation du Digital Exchange

Le [Digital Exchange](https://digitalexchange.blueprism.com/) rassemble des composants SS&C et de partenaires ([présentation officielle](https://www.blueprism.com/products/digital-exchange/)). Une fiche DX constitue un candidat à évaluer ; la version réellement téléchargée et son comportement doivent être vérifiés sur notre BP 7.5.1.

Pour chaque dépendance retenue, conserver sa source, son fournisseur, sa version, ses dépendances, les conditions de redistribution et le résultat d'un test ciblé. Inspecter les entrées/sorties et le comportement d'erreur avant de générer un appel. Réutiliser l'objet installé compatible ; toute mise à jour doit être motivée et vérifiée pour les processus qui en dépendent.

Exigence utilisateur du 29/09/2026 : évaluer la confiance accordée à chaque asset DX. Relever les validations/approbations effectivement affichées et leur portée, les revues disponibles, les retours d'utilisation, le volume de téléchargements s'il est accessible, ainsi que la maintenance. Un fournisseur connu ou un grand nombre de téléchargements ne prouve pas à lui seul qu'une version a été revue ou qu'elle convient à notre environnement ; toute information absente reste « non vérifiée ».

Privilégier les composants maintenus par SS&C ou un fournisseur identifié, avec des preuves de revue et d'utilisation. Un asset sans approbation vérifiable, sans revue et sans usage établi reste candidat à l'inspection, sans import ni exécution automatique. Si son intérêt justifie de continuer, inspecter ses Code Stages, dépendances, accès fichiers/réseau et traitement des credentials, puis effectuer un essai isolé avec données fictives avant intégration. La version retenue est figée pour la démo.

Les files de travail et les credentials utilisent d'abord les capacités natives BP. Pour l'appel API, comparer Web API Services à un connecteur DX adapté ; les utilitaires HTTP/JSON ne sont ajoutés que s'ils apportent quelque chose au scénario. Aucun asset tiers n'est recopié dans le dépôt public sans droits établis ; ses références et instructions d'installation peuvent y figurer.

## Stack

- Node 24, TypeScript `strict`, ESM, **npm workspaces**.
- Tests : Vitest. Lint : ESLint (typescript-eslint) + Prettier. Build : `tsc -b` (project references).
- Validation des schémas : **zod**.
- CI : GitHub Actions sur **`windows-latest`** (Blue Prism ne tourne que sous Windows) : install, lint, typecheck, test.
- `tools/bpprobe` : C# compilé avec le Roslyn livré dans Blue Prism. C'est le pont en lecture seule vers les DLL.

## Découpage

```
packages/
  model/      @bpdev/model      Document XML Blue Prism sans perte (parse ↔ serialize) + vues typées
  catalog/    @bpdev/catalog    Catalogue AMI (types d'éléments, actions, arguments, conditions, identifiants)
  generator/  @bpdev/generator  IR (zod) → XML via @bpdev/model ; règles de 01-spikes.md
  bridge/     @bpdev/bridge     AutomateC, listener du runtime (TCP 8181), bpprobe, identifiants
  scanner/    @bpdev/scanner    Observation DOM bornée et prévalidation XPath dans Chrome
  runner/     @bpdev/runner     Artefacts, déploiement, lancement idempotent, suivi et assertions
  mcp/        @bpdev/mcp        Serveur local stdio, contrats typés pour le LLM
tools/
  bpprobe/                      C# : catalog, apptypes, validate, find, il
docs/
spikes/                         Historique des preuves (non livré)
```

Les packages `mcp`, `scanner` et `runner` existent désormais ; leur présence n'est pas une preuve de qualification complète. Le scanner utilise un Chrome séparé et ne remplace pas la validation des sélecteurs par l'extension BP. `lint` reste une évolution distincte.

Dépendances autorisées : `generator → model, catalog` ; `bridge → model` (optionnel). Aucune dépendance circulaire.

## Règles transverses

- **Pas de secret dans le code, les tests ou les logs.** Les identifiants viennent de l'environnement (`BP_USER`, `BP_PASSWORD`), plus tard du Gestionnaire d'identifiants Windows.
- **Le catalogue AMI n'est pas commité.** Il est extrait des DLL SS&C et contient leurs textes d'aide. Il est généré localement (`.bpdev/catalog/`, gitignoré). Les tests utilisent un **petit sous-ensemble écrit à la main** dans les fixtures.
- **Tests d'intégration Blue Prism** : runner produit et scripts de démonstration sous `tools/demo`, désactivés par défaut et absents de la CI publique. `BP_INTEGRATION=1` autorise explicitement ces scripts à importer et exécuter des artefacts BPDEV. Les résultats et profils restent sous des chemins locaux exclus de Git.
- **Aucune release de référence tierce dans le repo** (voir [02-references.md](02-references.md)). Les fixtures sont uniquement des fichiers produits par nous.
- Pas d'export par défaut, erreurs typées, aucun `console.*` dans les bibliothèques.
- Chaque package a un README court : rôle, API publique, exemple.
