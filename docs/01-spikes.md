# Phase 1 : résultats des spikes (28/09/2026, Blue Prism 7.5.1)

## Outils obtenus (contournements)

- **`spikes/bpprobe`** : petit outil C#, compilé avec le Roslyn livré dans Blue Prism, qui charge les DLL de l'installation en lecture seule.
  - `catalog` : catalogue officiel du mode navigateur depuis `AMI.dll`. 16 types d'éléments web ; pour chacun, actions, lectures, écriture, conditions de Wait avec leurs arguments ; plus les 38 identifiants `w*`. Résultat dans `spikes/ami-catalog-browser.json`.
  - `apptypes` : types d'application (Launch et Attach) et leurs paramètres.
  - `validate` : charge un process ou un objet avec **le parseur de Blue Prism** (`BluePrismProcess.FromXmlThrowsErrors`) et montre ce qu'il a réellement lu. Il a reproduit à l'identique une erreur du runtime, en quelques secondes et sans lancer de session.
  - `find` et `il` : recherche de méthodes et mini-désassemblage (chaînes et appels). C'est ce qui a permis de trouver l'origine de « Can't execute stage ».
- **AutomateC + base en lecture seule** : import, publish, run, status, getlog, et raison d'échec lue dans `BPASession`.

## Résultats

| Spike | Résultat |
|---|---|
| S1 : format 7.5.1 | ✅ Obtenu **depuis les DLL**, sans attendre d'export manuel. Un export de référence reste utile pour recouper. |
| S2 : import d'un objet généré | ✅ Import sans erreur, parsing confirmé par Blue Prism. |
| S3 : le runtime pilote Chrome | ✅ **Complet** (28/09 21:43). Enchaînement Launch (profil robot isolé), Wait `WebCheckExists` sur START via `wCssSelector`, Read, Wait sur First Name, **Write**, Read de relecture, Close. Session `Completed`, sorties lues via le listener : `Echo = "Claude"`, `Start Text = "START"`. Aucun Chrome robot restant après le run. |
| S4 : attributs calculés depuis le DOM | En cours. `wCssSelector` fonctionne comme sélecteur, ce qui permet de cibler `ng-reflect-name` sur RPA Challenge, où `id` et `name` sont aléatoires à chaque chargement. |

## Règles découvertes (elles deviennent des règles du générateur ou du linter)

1. L'élément racine du modèle d'application doit être typé : `type` et `basetype` à `Application`, `datatype` à `unknown`, plus `diagnose`. Sinon `Launch` lève une NullReference.
2. `BrowserLaunch` en 7.5 a **5 paramètres**, dont `prelaunchbrowser` (absent des exports 7.4).
3. Chaque étape applicative doit porter **tous** les arguments que le catalogue déclare pour son action, même vides.
4. Chaque élément web porte les 38 identifiants dans l'ordre du catalogue, avec `inuse` seulement sur ceux de correspondance.
5. Les paramètres des étapes `Action` ont un `friendlyname`.
6. La page principale porte une étape `ProcessInfo`. Pour un objet, elle inclut aussi les options de code (références, imports, langage).
7. **Les GUID d'étapes sont uniques.** Une collision (étape nommée comme sa page) fait exécuter l'étape d'info de la page : « Can't execute stage ».
8. `loginhibit` coupe le log. Il n'est utilisé que volontairement.
9. Navigateur du robot : **profil Chrome dédié** (`--user-data-dir`) pour ne jamais toucher au Chrome de l'utilisateur. Un profil neuf doit d'abord télécharger l'extension Blue Prism, installée par stratégie : le premier lancement est lent. Ça se prépare avant la démo.
10. Tout process de test **ferme toujours son navigateur**, via Recover, puis Terminate, puis on relance l'exception. Sans ça, chaque run raté laisse des onglets ouverts.
11. Listener du runtime (TCP 8181) : l'authentification par nom d'utilisateur s'écrit `user name <nom>`, puis `password <mdp>`. Un simple `user <x>` attend un GUID. C'est le bug du MCP de wasiakgrzes. Ensuite, `outputs <sessionId>` renvoie les sorties en XML.

## Protocole de test (à la demande de l'utilisateur : « du calme »)

- Un seul run navigateur à la fois, annoncé avant d'être lancé.
- Validation hors ligne (`bpprobe validate`) avant tout import.
- Le navigateur du robot est fermé à la fin de chaque run, succès ou échec.
