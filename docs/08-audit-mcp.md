# Audit du produit MCP et plan de qualification

État au 29 septembre 2026, code de référence `70b2676`. Audit du dépôt, lecture des preuves locales et documentation officielle, complétés par trois relectures indépendantes : pont, observabilité BP, navigateur. L'avis d'Opus fourni par l'utilisateur a été confronté au code ; ses conclusions ne sont pas toutes reprises telles quelles.

Cet audit décrit l'état du commit indiqué, avant corrections. Les sections de constat ci-dessous restent historiques ; elles ne décrivent pas automatiquement le code de travail actuel.

**Décision de livraison ultérieure du 29/09/2026 :** finir la v1 BP avant un autre produit. Critères : correctifs de revue testés ; boucle générer/valider/importer/lancer/vérifier dans le produit ; scénario original template/queue/objet web avec échec et reprise vérifiés ; MCP minimal et skill ; démo enregistrée et README publiable. L'appel API du lot 4 est **facultatif** pour cette v1. Publication autorisée sur `Swih/blueprism-mcp`, MIT, après contrôle des secrets dans les fichiers et l'historique. Le plan courant fait foi dans [04-architecture.md](04-architecture.md).

## Contrat produit

Un LLM généraliste, sans notre historique et sans formation spécifique ajoutée sur BP, reçoit un objectif et un site autorisé. Le MCP lui fournit les capacités de l'installation, les conventions et les outils pour observer le site, créer ou adapter un objet, construire un processus, le tester dans BP et expliquer un échec avec ses preuves.

Le moteur doit embarquer le savoir BP : recettes, catalogue réel, modèles validés, erreurs réparables et tests. Une skill peut faciliter l'utilisation, mais ne doit pas constituer une dépendance cachée réservée à notre assistant. « Sans expertise préalable » ne signifie pas que le modèle est dépourvu de toute connaissance BP issue de son entraînement ; cela signifie qu'on n'exige ni cette connaissance ni un fine-tuning pour réussir notre évaluation.

Périmètre initial simple à moyen : navigation web, champs et boutons, attentes sur état, décisions, boucle bornée de consommation d'items, un enrichissement HTTP, credentials référencés, config et gestion d'exceptions. Les familles décision/collection/queue/API restent à implémenter dans le générateur de processus. Les applications Citrix, CAPTCHA, MFA autonome, tous les Shadow DOM et tous les modes de spy ne sont pas des capacités promises pour ce jalon.

Scénario unique : **template → queue → GET d'enrichissement → objet web → résultat de l'item**. L'observation, les tests et le MCP font partie de ce scénario. Hub/API, API entrante et extension maison sont des évolutions conditionnelles, pas trois chantiers à lancer en parallèle.

## État constaté et limites des preuves

| Composant | Ce qui existe | Ce qui manque pour le produit |
| --- | --- | --- |
| XML | Modèle parse/build/serialize et vues de process, objets et releases | Modification métier contrôlée d'un objet existant, conservation des changements Studio, release complète avec dépendances |
| Catalogue | Extraction locale AMI et résolution des opérations selon l'installation | Contrats de test fidèles aux signatures réelles, découverte des actions VBO déjà disponibles, empreinte/version dans chaque artefact |
| Générateur | Objets navigateur, pages privées, Attach conditionnel, paramètres dynamiques, Wait sur état, processus de test multi-objets | Process template, queue, collections prouvées, credentials/config/API, politique de journalisation |
| Pont | Clients AutomateC/listener, parseurs et fixtures | Exports publics, tests, suivi borné, capture, validation native intégrée ; `src/index.ts` ne contient que `export {}` |
| Spy | XPath observés sur RPA Challenge et helpers de construction | Aucun scanner du produit ; l'inspection a utilisé les outils de l'assistant |
| MCP | Aucun package ni serveur dans le dépôt | Contrats d'outils, démarrage local, ressources, erreurs structurées, test avec un client neuf |
| Qualité | 270 tests / 10 fichiers ; lint, typecheck et build locaux réussis lors de cet audit | Zéro test exécutable du pont ; pas de runner `BP_INTEGRATION` ; CI configurée, pas de remote ni d'exécution CI vérifiée |

Les essais BP déjà réalisés sont décrits dans [06-dynamic-spy.md](06-dynamic-spy.md). Les journaux ont été relus pendant l'audit :

- Session `bd3186d4-7044-420e-aa97-5c9db72c9b95`, Completed : trois tours, 21 saisies avec vérification d'état/relecture, deux soumissions et fermeture. Une sortie a aussi été relue indépendamment par le listener. Ce n'est pas le challenge complet avec dix lignes et un score de 100 %.
- Session `c1aa57e6-2672-4169-8463-b50d91823356`, échec attendu : deuxième demande Start, timeout, un Recover, nettoyage puis propagation. Le nettoyage n'a pas échoué dans cet essai.
- Le correctif d'ordre XML `WaitEnd` avant `WaitStart` conserve la distance de condition au chargement natif. Sa dernière version doit encore être réimportée et vérifiée visuellement, sans remplacer les corrections humaines enregistrées.

`bpprobe validate` charge le XML avec un catalogue d'objets externes vide ([Validate.cs](../tools/bpprobe/Validate.cs)). Un chargement réussi ne prouve ni la résolution de toutes les dépendances, ni une validation Studio complète, ni la réussite métier. La sonde repose sur les DLL installées : sa compatibilité doit rester liée au build BP testé.

L'environnement précédemment inspecté dans BP affiche Evaluation, valable jusqu'au 28 octobre 2026, 15 processus publiés, deux sessions simultanées et une ressource runtime. Cela ne prouve pas que Hub ou le serveur REST est installé. Deux sessions ne donnent pas deux bureaux navigateur indépendants.

## Corrections prioritaires vérifiées

P0 désigne ici un préalable à l'exposition des opérations à un LLM et aux essais avec secrets. Les tests actuels réussissent malgré ces défauts.

| Priorité | Constat et preuve | Correction et critère d'acceptation |
| --- | --- | --- |
| P0 | Timeout `/run` : [process.ts](../packages/bridge/src/process.ts) rejette en perdant stdout partiel ; [client.ts](../packages/bridge/src/automatec/client.ts) n'examine le GUID qu'après terminaison. Reproduit par le relecteur avec un processus simulé émettant un GUID puis restant bloqué. | Conserver le GUID dès réception. Sans preuve de création ou de rejet, résultat indéterminé ; aucune relance automatique. Tester timeout avant/après GUID et sortie non nulle après GUID. Tuer AutomateC ne prouve pas l'arrêt du robot. |
| P0 | Masquage avant parsing : un secret égal à `Session` détruit le marqueur. Les sorties listener `password`, leur XML et certaines entités décodées peuvent restituer des secrets ([parseurs](../packages/bridge/src/listener/parsers.ts)). Reproductions en mémoire par le relecteur. | Parser dans une frontière interne, puis filtrer résultats, XML imbriqué, logs et erreurs avant exposition. Les buffers bruts restent internes, jamais dans une erreur publique. Tester secrets courts, marqueurs, entités XML et collections. |
| P0 | Un paramètre `password` avec valeur par défaut est accepté et sérialisé littéralement ; `date: "not-a-date"` aussi. Reproduction locale avec valeurs fictives, via l'API publique du générateur ([résolution](../packages/generator/src/resolve-object.ts)). | Refuser les valeurs par défaut de secrets, référencer le credential BP ; définir et valider le format des dates supportées. Remplacer la garantie actuelle « aucun loginhibit » par une politique de logs testée avant credentials. |
| P0 | Les valeurs de `expect` du harness ne sont jamais comparées : [resolve-harness.ts](../packages/generator/src/resolve-harness.ts) ne lit que les clés. Remplacer `START` par une valeur impossible produit exactement le même XML ; aucun manifeste d'assertions n'est retourné. | Générer des assertions ou un manifeste consommé par le runner. Prouver qu'une session Completed avec sortie incorrecte échoue au test métier. Distinguer assertion non exécutée, sortie absente et valeur incorrecte. |
| P0 | Une lecture catalogue renvoyant `collection` est acceptée mais produit un stage `Data` typé collection. Reproduction avec `WebElement.WebGetBounds`. Ce format n'a pas été qualifié nativement. | Refuser cette capacité jusqu'à preuve d'un vrai modèle Collection, aller-retour natif et test de consommation. Les futures queues dépendent de ce travail. |
| P1 | Le pont n'a pas d'entrée publique utilisable, de tests ni de limite mémoire pour `/getlog`. La CI ne construit pas le package distribué. | API publique minimale, tests de fixtures/transport et import depuis le package construit. Borner volume et durée, signaler toute troncature, conserver le contexte d'erreur. |
| P1 | Les tests ne chargent pas les deux JSON de la démo récente. `basic-actions` échoue avec le catalogue de fixtures, faute de `AttachApplication` et `WebIsConnected`, mais les deux exemples passent avec le catalogue local. | Tester ces fichiers exacts ; fixtures de signatures compatibles sans copier les textes SS&C. Contrôle natif local séparé et explicite. |
| P1 | [dynamic.test.ts](../packages/generator/test/dynamic.test.ts) remplace les signatures Attach par des versions synthétiques. L'installation donne six arguments à AttachApplication et zéro à IsConnected en BrowserAttach ; le test en fournit respectivement deux et un. | Conserver les tests synthétiques utiles à la généralité, ajouter les vrais contrats 7.5.1 et distinguer BrowserLaunch/WebIsConnected de BrowserAttach/IsConnected. |
| P1 | [harness.ts](../packages/generator/src/harness.ts) nettoie avant de propager ; aucune capture n'est produite et un échec du cleanup peut remplacer l'erreur initiale. | Figer l'erreur, capturer avant nettoyage, isoler les défaillances de diagnostic/cleanup et vérifier une propagation unique de l'erreur initiale. |
| P1 | Génération depuis zéro uniquement au niveau métier ; pas de patch transactionnel d'un objet existant. | Base exportée et empreinte, modification ciblée, diff, validation, détection d'un changement concurrent, sauvegarde récupérable avant import. |

Nuances apportées à l'avis d'Opus :

- Le modèle XML sait déjà construire et modifier un arbre ; ses vues sont en lecture seule. Le manque est un ensemble d'opérations métier sûres, pas l'impossibilité technique de modifier du XML.
- Le JSON récent Basic Actions contient déjà `--user-data-dir="{robotProfileDir}"`. L'affirmation selon laquelle ce chemin précis serait non protégé n'est donc pas confirmée. La construction générale de `CommandLineParams` reste une jointure de chaînes : qualifier les espaces/guillemets et l'exemple ancien avec de vrais arguments Windows.
- Une fixture avec GUID invalide peut servir à tester un parseur isolé ; elle n'est pas intrinsèquement inutilisable. Les fixtures bpprobe peuvent devenir des contrats quand l'adaptateur existe.
- Découper `resolveAction`, figer quelques GUID et éliminer du code inutilisé est utile, après les correctifs de comportement. Le nombre de lignes seul ne justifie pas une refonte.

Autres points à inclure dans la qualification du pont : fragmentation TCP et caractères multioctets, ligne finale sans retour, notifications et séparation des réponses, fermeture prématurée, sortie volumineuse, encodage CLI, noms ressemblant à des options. Le transport listener actuel est du TCP clair : le produit local doit refuser un hôte distant tant qu'un transport approprié n'est pas qualifié. Les mots de passe CLI d'authentification **et** de démarrage passent dans les arguments du processus ; la redaction des logs ne supprime pas cette propriété.

## Observer BP et expliquer un blocage

### Moyens natifs et portée

| Voie | Capacité documentée | Choix pour le produit |
| --- | --- | --- |
| AutomateC | `/status`, `/resourcestatus`, `/getlog` ; pas de mode follow trouvé | Premier adaptateur local. Mesurer disponibilité et fraîcheur des logs pendant un run ; taille et fréquence bornées. |
| Listener runtime | Statut, disponibilité et variables de session exposées | Complément pour les résultats. Ne pas le présenter comme un accès garanti à toutes les variables ou au stage courant. |
| API officielle 7.5.1 | Session avec `latestStage`, `stageStarted` et détails d'exception ; `/logs` et `/logslight` paginés | Adaptateur facultatif lorsque déployé ; simplifie le suivi. `latestStage` reste le dernier stage rapporté, sans promesse de temps réel. |
| Studio / Control Room | Debug pas à pas, logs, dernier écran capturé | Outils de qualification humaine ; leur disponibilité n'équivaut pas à un outil MCP implémenté. |

Sources : [CLI](https://documentation.blueprism.com/bp-7-5/en-us/helpCommandLine.htm), [listener](https://documentation.blueprism.com/bp-7-5/en-us/helpResourcePCCommands.htm), [API 7.5.1](https://documentation.blueprism.com/bp-7-5/en-us/bp-api/bpe-7-5-1-api-spec.html). L'API requiert son propre déploiement et ses prérequis, pas seulement une licence Evaluation ([prérequis officiels](https://documentation.blueprism.com/bp-7-5/en-us/Guides/bp-api/api-prerequisites.htm)). Le premier parcours ne dépend pas de son installation.

BP possède aussi un seuil d'avertissement sur la durée passée dans un stage. Ce signal peut aider, mais ne prouve pas un blocage ([réglages système](https://documentation.blueprism.com/bp-7-5/en-us/sysman-settings.html)). Un Wait de 30 secondes n'est pas un échec à la dixième seconde. Le MCP comparera délai attendu, fraîcheur de l'observation et statut ; il distinguera « absence de progrès observé », « source indisponible » et « échec confirmé ».

### Capture sur exception et récupération

La fonction native est l'option **Save screen capture du stage Exception**, activable par le réglage **Allow latest Runtime Resource screen capture**. La documentation détaillée accessible en 7.4 indique stockage en base, dernière image seulement par ressource et capture pendant une exécution Control Room ; le debug Studio signale la capture dans les logs sans prendre d'image. Le réglage existe toujours en 7.5 : vérifier ces comportements sur notre 7.5.1. [Exception stage 7.4](https://documentation.blueprism.com/bp-7-4/en-us/frmStagePropertiesException.htm), [System settings 7.5](https://documentation.blueprism.com/bp-7-5/en-us/sysman-settings.html).

Control Room propose **Show latest screen capture**, sous permission adéquate ([Resources](https://documentation.blueprism.com/bp-7-5/en-us/ctlresources.htm?TocPath=Interface%7CControl%7C_____2)). Aucun endpoint public de capture à la demande ou de téléchargement d'image n'a été établi par cette recherche. Ne pas inventer `CaptureScreen()` ni un endpoint à partir d'une permission. Une image ancienne ne doit jamais être attribuée au dernier échec sans corrélation vérifiée.

Plan d'instrumentation, à prouver avant génération automatique :

1. Figer type, détail, stage d'origine et corrélation dès Recover, avant tout Resume et toute action pouvant échouer.
2. Capturer avant fermeture/navigation/nettoyage. Pour un timeout généré, qualifier directement l'option native sur son stage Exception. Pour une autre erreur interceptée, qualifier séparément le chemin de capture puis propagation.
3. Isoler les diagnostics et le cleanup dans des chemins possédant leur propre traitement borné. Conserver leurs erreurs comme secondaires.
4. Propager une fois l'erreur initiale. `Preserve type and detail` exige que cette erreur soit encore courante ; sinon utiliser les valeurs sauvegardées. Une reprise ne doit jamais réinjecter l'exception dans le même Recover en boucle.

Ces contraintes découlent du comportement documenté de Recover/Resume et de la remontée d'une nouvelle exception pendant la récupération ([exceptions BP](https://documentation.blueprism.com/bp-7-5/en-us/helpExceptions.htm)). Le graphe exact, notamment les frontières des blocs et la propagation après Resume, doit être validé avec une panne injectée dans chaque étape de diagnostic.

Si la capture native est visible mais inexploitable par le MCP, qualifier une action VBO locale de diagnostic : chercher d'abord un utilitaire installé ou DX revu, sinon construire une petite action dédiée, avec chemin d'artefact borné et retour d'erreur secondaire. Ne pas interroger directement la base pour récupérer ses images. L'action doit capturer le bureau de la ressource concernée, pas supposer que le bureau de l'assistant est celui du robot. Le verrouillage/RDP et l'échec de capture font partie des tests ; une capture absente est un résultat explicite, pas une réussite silencieuse.

### Contrat de suivi proposé

Chaque lancement reçoit un `runId` durable local, une empreinte de l'artefact et, dès qu'il est connu, son `bpSessionId`. Une même clé de demande ne redéclenche pas un run. Après coupure dans la fenêtre de création de session, la réconciliation doit précéder toute relance ; on ne promet pas une exécution exactement une fois à partir du seul client CLI.

Le dossier de preuves contient : statut BP brut et date d'observation, état normalisé, dernière progression connue et provenance, erreur initiale, erreurs secondaires, dernières entrées de log avec curseur, assertions attendues/observées, captures disponibles et leurs horodatages. La notion de curseur est celle de l'adaptateur ; `/getlog` ne devient pas paginé parce que notre contrat l'est.

Séparer `executionState` (running/completed/failed/unknown…), `verificationState` (passed/failed/not_run) et `observationHealth` (fresh/stale/unavailable). Une capture reçue après le cleanup est étiquetée comme telle. Les payloads MCP sont filtrés et bornés ; les artefacts ont une rétention configurable et restent locaux par défaut. Une console ou une image peut contenir des secrets même si les champs password ont été masqués.

## Navigateur : exécuter avec BP, observer utilement

L'extension officielle fournit à BP son intégration navigateur et utilise un hôte Native Messaging. Cela ne constitue pas une API publique pour un MCP ou une autre extension. Le manifest local consulté déclare l'hôte et les origines des extensions officielles ; il ne prouve pas leur activation dans chaque profil. [Intégration SS&C](https://documentation.blueprism.com/bp-7-5/en-us/Guides/chrome-firefox/chrome-firefox.htm), [Native Messaging Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

BP 7.5 propose aussi **Chromium spy**, distinct du Browser spy avec extension. Les modes et leur catalogue doivent être explicitement enregistrés ; leur compatibilité ne se déduit pas l'un de l'autre. Insert/Invoke JavaScript exige une configuration supplémentaire, notamment remote debugging, driver compatible et profil non standard pour Chrome récent. Cela n'est pas requis pour chaque action du spy classique. [Intégration et prérequis JavaScript](https://documentation.blueprism.com/bp-7-5/en-us/Guides/chrome-firefox/chrome-firefox.htm).

| Option | Décision et preuve nécessaire |
| --- | --- |
| BP exécute ; navigateur d'exploration distinct observe | Première voie pour préparer le spy. Son DOM peut différer du navigateur robot : validation finale dans BP obligatoire. Les outils navigateur disponibles à l'assistant aujourd'hui ne sont pas automatiquement une dépendance livrable du MCP. |
| Observateur CDP sur un profil robot dédié | POC ciblé pour DOM, cadres, console et erreurs dans la vraie session. BP garde clics/saisies/navigation pendant le run. Mesurer la coexistence avec BP/JavaScriptInvoker et la déconnexion de l'observateur. |
| Extension complémentaire propre | À envisager si les deux voies précédentes laissent un besoin mesuré. Extracteurs embarqués, permissions minimales, reprise MV3 ; aucun détournement du protocole privé de l'extension BP. |

Les logs de l'extension vers DevTools sont documentés ; cela ne garantit pas un flux des erreurs de l'application web accessible depuis BP ([diagnostic SS&C](https://documentation.blueprism.com/bp-7-5/en-us/Guides/chrome-firefox/troubleshooting.htm)). CDP expose notamment `Runtime.consoleAPICalled` et `Runtime.exceptionThrown` ; ce serait un adaptateur à construire et tester ([Runtime CDP](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)). Observer ne donne pas le droit de concurrencer les actions du robot. Le profil doit être dédié ; ne pas collecter cookies, stockage ou trafic réseau par défaut ([remote debugging Chrome](https://developer.chrome.com/blog/remote-debugging-port)).

Chaque élément produit conservera contexte de page/cadre, mode BP, attributs observés, sélecteurs candidats, justification et résultat de validation. Préférer les attributs stables lorsqu'ils suffisent ; un XPath relatif fondé sur un label est utile quand la structure observée le permet ([attributs BP](https://documentation.blueprism.com/bp-7-5/en-us/attributes-webpage.htm)). Rechercher une correspondance unique après rerender et redistribution ; pas de `[1]` pour dissimuler une ambiguïté. `Dynamic` désigne une valeur fournie à l'exécution, pas une garantie de robustesse.

## MCP utilisable par un LLM neuf

Contrat proposé, noms provisoires. Les opérations mutantes passent par des artefacts validés et des identifiants connus, pas une commande système libre.

| Famille d'outils | Résultat utile au LLM |
| --- | --- |
| Inspecter l'environnement | Version/build, catalogue, objets/actions réutilisables, ressources disponibles, capacités supportées/non vérifiées et recette de départ |
| Inspecter le site / vérifier une cible | Observation bornée, contexte de cadre, candidats et preuve d'unicité ; vérification dans BP distincte |
| Préparer une création ou modification | Spécification métier typée, artefacts, dépendances, diff sur base connue et erreurs localisées |
| Valider puis importer | Résultats séparés : schéma, contrat catalogue, XML natif, références/Studio et qualité ; niveau non exécuté clairement indiqué |
| Lancer, consulter, demander l'arrêt | `runId`, session, statuts, progression, curseur et preuves ; demande d'arrêt différente d'un arrêt confirmé |
| Vérifier et diagnostiquer | Assertions métier, erreur initiale, capture/console disponibles, causes possibles étayées et réparation bornée |

Le serveur embarque des recettes versionnées : cycle de vie Basic Actions, pages métier et privées, Wait avant action et contrôle après action, conventions de nommage/mise en page inspirées des références WTTJ/LinkedIn, template de consommation. Les fichiers privés ne sont pas redistribués. Réutiliser les signatures d'actions installées, éviter d'obliger le LLM à inventer des identifiants AMI ou du XML.

Les descriptions d'outils et leurs erreurs donnent les prochaines étapes utiles ; des ressources seules ne garantissent pas leur lecture par tous les clients. Sorties structurées, schémas et références d'artefacts suivent le [contrat MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Débuter avec un serveur local stdio, `runId` et polling borné ; les transports distants et fonctions optionnelles de tâches ne sont pas nécessaires au premier test.

Pour adapter un objet : exporter → vérifier empreinte → modifier des éléments/pages ciblés → conserver GUID, positions et champs inconnus hors périmètre → diff et validation → import de la version prévue. Si un humain sauvegarde entre-temps, suspendre l'application du patch et reconstruire le diff. Tester explicitement l'ajustement visuel des Wait et un champ XML inconnu.

## Plan séquencé et critères de passage

Chaque lot se termine par une preuve enregistrée. Les sous-agents peuvent relire des surfaces indépendantes ; un seul auteur par fichier partagé. Les modifications concurrentes nécessitent des branches/checkouts isolés, pas plusieurs agents écrivant le même fichier.

| Lot | Livrable | Tests de passage |
| --- | --- | --- |
| 0 — Fiabilité | Correctifs P0, tests du pont et des deux exemples, exports du package, build dans la CI | Timeout avant/après GUID sans double lancement ; aucun secret synthétique dans XML/retours/logs publics ; valeur attendue fausse fait échouer le test ; collection non qualifiée refusée ; fixtures réelles Attach ; import du package construit |
| 1 — Boucle MCP et diagnostic | Serveur local minimal sur le scénario existant, import/run/status/logs/résultats, capture qualifiée | Un succès métier et un timeout déclenchés par le MCP ; preuve située avant cleanup ; capture/cleanup en panne sans perte de l'erreur initiale ; indisponibilité du listener signalée ; arrêt demandé puis état final vérifié ; aucun script privé nécessaire |
| 2 — Spy et adaptation | Scanner livrable, correspondance DOM → BP, patch d'objet | IDs et ordre variables, rerender, doublons, apostrophes et iframe ; résolution unique ou refus explicite ; objet édité dans Studio conservé ; test avec et sans observateur sur le profil robot |
| 3 — Template et queue | Modèle Collection prouvé, appels aux actions existantes, création/consommation queue, config et credentials minimaux | Item valide, donnée invalide, erreur technique, reprise bornée, stop/redémarrage, item verrouillé, succès enregistré après effet métier confirmé ; perte d'accusé sans double effet |
| 4 — Enrichissement API | Un GET via Web API Services ou composant retenu, réponse typée, références de credentials | Données utilisées dans le formulaire ; 401/429/500/timeout et schéma invalide ; secret absent des diagnostics ; budget de reprises commun avec le template |
| 5 — Démo reproductible | Package installable, dépendances documentées, exemples publics originaux, rapport d'évaluation | Depuis un client LLM neuf, génération et exécution sur RPA Challenge complet puis un petit site de test inédit ; cas d'échec expliqués avec preuves ; résultats contrôlés indépendamment |

Qualification complémentaire du lot 1 : comparer capture Control Room et Studio, vérifier disponibilité des logs pendant une attente connue, contrôler l'âge de la dernière image, puis tester bureau verrouillé/RDP sur l'environnement de test. Une capacité absente devient une limite détectable du produit.

Pour le lot 3, définir une recette à partir du template fourni et des conventions existantes : Init/config → obtenir item → traiter → marquer succès ou exception → item suivant → fin. Les erreurs métier et système doivent être distinguées, le nombre de tentatives et le délai total explicités. Les credentials sont résolus par référence dans BP ; les variables d'environnement et le fichier de config contiennent les paramètres non secrets et ont une priorité documentée. L'absence d'un paramètre requis doit échouer avant un effet métier. Les règles DX de [l'architecture](04-architecture.md#utilisation-du-digital-exchange) s'appliquent à toute dépendance.

Les sources et tests API sont détaillés dans [07-api-integrations.md](07-api-integrations.md). Le lot 4 reste un seul appel de lecture dans le parcours ; ne pas mélanger le besoin de supervision REST BP et celui d'appeler une API depuis le processus.

### Évaluation finale : vérifier l'autonomie, pas la mise en scène

Figer les versions BP/navigateur/catalogue et le jeu de tests avant l'essai. Donner au LLM uniquement l'objectif, le site, les données fictives et l'accès au MCP ; pas nos commandes internes ni les solutions XPath du site inédit. Préparer des résultats attendus indépendants du plan que le LLM génère.

Proposition initiale de qualification : deux parcours (simple puis moyen), trois sessions LLM neuves chacun, budget annoncé de trois corrections automatiques par parcours. Le rapport conserve chaque échec et intervention humaine, pas seulement la meilleure tentative. Pour les cas critiques de sélecteurs et de transport, exécuter séparément une campagne de répétitions sur fixtures contrôlées ; le nombre d'essais ne constitue pas une garantie statistique de fiabilité.

Mesurer réussite métier exacte, erreurs correctement diagnostiquées, mauvaises cibles/doubles effets, nombre de réparations, temps total et interventions humaines. Le processus doit être lisible à l'ouverture dans Studio et réexécutable après export/import. Un résultat non vérifiable, une sortie absente ou un run indéterminé ne peuvent être présentés comme un succès. La publication GitHub et la CI distante viendront lorsque la destination du dépôt sera définie ; elles n'ont pas été effectuées par cet audit.
