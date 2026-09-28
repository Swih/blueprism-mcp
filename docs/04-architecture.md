# Architecture du socle (contrat pour tout contributeur, humain ou agent)

Nom de travail : **bpdev**. Ce document est la référence. En cas de doute, il prime sur toute autre consigne.

## Principes

1. **Le LLM décide, le code écrit le XML.** Aucun XML Blue Prism n'est produit par concaténation de chaînes ni par un prompt. Tout passe par des modèles typés et des sérialiseurs testés.
2. **Aller-retour sans perte.** Lire un fichier Blue Prism puis le réécrire donne un XML équivalent. C'est la condition pour « s'adapter à un objet existant ».
3. **Déterminisme.** Même entrée, même sortie, octet pour octet (GUID dérivés de chemins stables, ordre stable).
4. **Vérité terrain Blue Prism.** Les règles de format viennent de [01-spikes.md](01-spikes.md) (vérifiées sur 7.5.1) et du catalogue extrait par `bpprobe`. On n'invente pas de format.
5. **Simple, lisible, testé.** De petits modules, pas d'abstraction spéculative. Chaque règle de format a un test.

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
tools/
  bpprobe/                      C# : catalog, apptypes, validate, find, il
docs/
spikes/                         Historique des preuves (non livré)
```

Plus tard : `lint` (intégration de bplint), `scanner` (Playwright), `mcp` (serveur MCP).

Dépendances autorisées : `generator → model, catalog` ; `bridge → model` (optionnel). Aucune dépendance circulaire.

## Règles transverses

- **Pas de secret dans le code, les tests ou les logs.** Les identifiants viennent de l'environnement (`BP_USER`, `BP_PASSWORD`), plus tard du Gestionnaire d'identifiants Windows.
- **Le catalogue AMI n'est pas commité.** Il est extrait des DLL SS&C et contient leurs textes d'aide. Il est généré localement (`.bpdev/catalog/`, gitignoré). Les tests utilisent un **petit sous-ensemble écrit à la main** dans les fixtures.
- **Tests d'intégration Blue Prism** (import, run, validate natif) : marqués et ignorés sauf si `BP_INTEGRATION=1`. La CI ne les exécute pas.
- **Aucune release de référence tierce dans le repo** (voir [02-references.md](02-references.md)). Les fixtures sont uniquement des fichiers produits par nous.
- Pas d'export par défaut, erreurs typées, aucun `console.*` dans les bibliothèques.
- Chaque package a un README court : rôle, API publique, exemple.
