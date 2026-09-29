# API entrantes et appels API dans les process

Relevé du 29 septembre 2026. Périmètre demandé : recevoir des demandes externes **et** récupérer des données par API à n'importe quelle étape d'un workflow BP. Ce document décrit la conception et les validations à réaliser ; aucun service HTTP nouveau n'a été installé ou exposé.

Ordre global : suivre le [jalon de l'architecture](04-architecture.md#prochain-jalon-et-ordre-de-travail). L'appel API enrichit le scénario de consommation de queue ; la réception et l'infrastructure Hub/API restent des étapes ultérieures. Avant de créer une intégration, vérifier les composants natifs/installés et le Digital Exchange pour ce besoin précis.

## Trois fonctions distinctes

| Besoin | Fonction BP / composant envisagé | Rôle du générateur |
| --- | --- | --- |
| Consulter une API externe pendant un process | Web API Services, appel depuis un stage Action | Créer/adopter la définition, les références de credentials et les étapes d'appel |
| Recevoir un appel vers un objet ou process | Exposition native en web service SOAP ; façade REST facultative | Préparer la signature, le traitement et la configuration d'exposition |
| Administrer et superviser le parc | API REST Blue Prism v7, avec Authentication Server | Adaptateur de pilotage complémentaire à AutomateC/listener |

L'API REST de supervision n'est pas un prérequis aux appels HTTP sortants du process. Le MCP exposera ces capacités au LLM ; il n'est pas le transport obligatoire des échanges métier.

Sources : [Web API definitions](https://documentation.blueprism.com/bp-7-5/en-us/Web%20API/HTML/configure-api-definition.htm), [installation et composants optionnels](https://documentation.blueprism.com/bp-7-5/en-us/installation/bp-enterprise/installation.htm).

## Installation et éditions

La documentation décrit Trial et Learning comme le même logiciel, différencié par la licence, avec un digital worker : Trial 30 jours / 15 processus ; Learning 180 jours / 5 processus. Learning conserve les capacités de développement mais désactive notamment le serveur applicatif et le Scheduler.

Mise à jour locale vérifiée le 29/09/2026 dans System > License, après installation de la Trial par l'utilisateur : licence active « Evaluation », 15 processus publiables, 2 sessions concurrentes et 1 runtime resource. La ligne de licence affiche aussi « Standalone: Yes ». Les capacités de concurrence des tests doivent donc tenir compte de ces droits effectifs et du run mode des objets. Cette lecture n'établit pas la possibilité d'installer Hub/API ni de démarrer le serveur applicatif ; cela reste à vérifier séparément. Aucun droit ni réglage n'a été modifié pendant cette inspection.

La configuration documentée de l'API REST requiert Authentication Server et un serveur applicatif actif pour synchroniser les comptes de service. Le blocage du serveur applicatif en Learning empêche donc de présumer que cette installation complète est disponible. Pour Trial, les droits de téléchargement de Hub/API et les prérequis système restent à vérifier ; « fully functional » n'établit pas à lui seul l'accès aux installateurs.

Les appels Web API et l'exposition SOAP sont des candidats au test local ; ne pas annoncer leur validation sur cette licence avant un appel réel. Le 29/09, la commande locale `AutomateC.exe /help /locale en-US` confirme `/publishws <processname> <servicename>` et `/unpublishws`. Aucun service n'a été publié par cette vérification.

Il n'existe pas, dans les sources examinées, de statistique permettant d'affirmer que la majorité des clients utilise ou n'utilise pas Hub/API. Ces composants sont optionnels. Le poste autonome avec LocalDB est une configuration de développement ; ne pas l'assimiler à l'architecture d'un parc de production.

Sources : [Trial/Learning](https://documentation.blueprism.com/en-us/trial-learning/tr-introduction.htm), [configuration API](https://documentation.blueprism.com/bp-7-5/en-us/Guides/bp-api/api-configuration.htm), [architecture de référence](https://documentation.blueprism.com/en-us/product-architecture/standard-deployment-architecture.htm).

## Appels sortants : première extension API à valider

Exemple : Get Next Item → lire une référence client → appeler Get Customer → valider les données → remplir l'application web → terminer l'item. Le même appel peut exister avant la queue, au milieu d'un traitement ou dans une page de contrôle.

La définition Web API contient URL, paramètres, authentification, actions HTTP, timeouts et extraction de réponse. Les réponses peuvent être converties par JSONPath en data items typés. Les secrets restent dans Credential Manager ; les paramètres/configurations transportent des noms de credentials. L'adresse de base et les délais doivent pouvoir varier entre environnements, après vérification de leur représentation exportée.

Un objet d'intégration réutilisable doit isoler la signature technique de l'API du process métier : entrées explicites, sorties typées, validation des champs nécessaires et traduction des erreurs selon le contrat du service. Un 404 peut être une absence métier attendue ou une erreur technique selon l'opération ; aucune classification universelle.

Point BP à traiter explicitement : un timeout ou une réponse 4xx/5xx déclenche une exception et ne produit pas les sorties du stage Web API. Le statut, les en-têtes et le corps figurent dans le message d'erreur standard. Il faut tester le décodage de cette erreur et masquer ses données sensibles avant journalisation. Ne pas construire un flux qui lit des outputs supposés disponibles après échec.

La politique de reprise reste bornée par un budget global avec la queue : pas de multiplication implicite des retries HTTP et des tentatives de traitement. Les opérations de lecture sûres peuvent être reprises après erreur transitoire ; une mutation nécessite une garantie d'idempotence ou une réconciliation. Un timeout ne prouve pas que le serveur n'a rien exécuté. Le traitement de 429/Retry-After doit respecter la disponibilité des en-têtes et le délai maximal accepté.

Sources : [actions, réponses et erreurs](https://documentation.blueprism.com/bp-7-5/en-us/Web%20API/HTML/api-actions.htm), [timeouts](https://documentation.blueprism.com/bp-7-5/en-us/Web%20API/HTML/api-basic-settings.htm), [credentials API](https://documentation.blueprism.com/bp-7-5/en-us/Web%20API/HTML/web-api-credentials.htm).

## Exposition native et notifications 7.5

L'exposition d'un processus/objet se configure dans System > Processes / Objects > Exposure. Le runtime présente le catalogue et les liens WSDL sous `http(s)://<runtime>:<port>/ws/`. L'authentification des services exposés utilise les comptes natifs BP ou Active Directory, indépendamment d'Authentication Server. HTTPS nécessite un certificat sur le runtime.

Le guide Web Services distribué avec la documentation 7.5 est encore estampillé 6.3 : ses détails de cycle de session doivent être recoupés sur notre 7.5.1. Il décrit une session par appel de processus ; pour un objet, un mode manuel Initialise → actions avec bpInstance → CleanUp, ou un mode automatique à état partagé. Les appels directs attendent leur résultat. Il faut mesurer l'occupation de session et la libération après erreur avant de retenir l'objet SOAP comme chargeur de queue.

Les webhooks introduits en 7.5 sont des notifications **BP vers un callback externe** sur les événements d'un item de queue. Ils exigent une connexion Blue Prism Server et un abonnement via l'API BP. Ils ne remplacent pas un endpoint de réception métier ni un appel Web API de lecture au milieu d'un process. Ils ne sont donc pas un prérequis de notre première démo sur LocalDB.

Sources : [exposition](https://documentation.blueprism.com/bp-7-5/en-us/frmWebServiceExpose.htm), [authentification](https://documentation.blueprism.com/bp-7-5/en-us/Guides/authentication-server/auth-server-introduction.htm), [guide Web Services](https://documentation.blueprism.com/bp-7-5/en-us/z-pdf/web-services/en-us/blue-prism-6-3-web-services-user-guide.pdf), [webhooks](https://documentation.blueprism.com/bp-7-5/en-us/helpWebhooks.htm).

## Réception : contrat proposé

Deux chemins à distinguer : une consultation courte peut répondre directement ; un traitement long par robot doit avoir un contrat asynchrone. Pour ce dernier, la façade REST proposée accepte un payload validé et retourne un identifiant permettant de consulter l'avancement.

| Endpoint proposé | Comportement attendu |
| --- | --- |
| `POST /v1/jobs` | Authentification, schéma validé, opération autorisée, enregistrement durable puis `202` avec `jobId` et URL de statut |
| `GET /v1/jobs/{jobId}` | Statut accessible au demandeur autorisé et résultat métier filtré |

États distincts : `accepted` (demande durable dans la façade), `queued` (item BP confirmé), `running`, `completed`, `failed`. `202` ne signifie ni « déjà inséré dans BP » ni « traitement réussi ».

La façade conserverait les demandes reçues pendant que l'unique worker est occupé. Un adaptateur les remettrait à BP via un chargeur contrôlé, ou via l'API officielle si disponible. L'exposition SOAP sera évaluée comme autre transport, en tenant compte de sa consommation de sessions/licences. Aucune écriture directe dans les tables SQL BP.

L'idempotence doit être vérifiée avec des appels simultanés : clé par demandeur/opération, empreinte du payload, contrainte d'unicité dans le stockage de la façade et identifiant de corrélation transmis à BP. La clé métier d'une work queue ne constitue pas à elle seule une preuve de déduplication atomique. Une coupure après insertion BP mais avant réception de l'accusé exige une réconciliation avant toute nouvelle insertion.

La façade n'accepte pas de commande AutomateC libre, de XML arbitraire ou de nom de process non autorisé. Les opérations métier sont déclarées et versionnées. Authentification, TLS hors localhost, autorisations par opération, limites de taille et de débit font partie de son contrat. Les secrets BP ne sont pas transmis aux clients.

## Intégration dans le projet

1. Créer dans BP une définition Web API minimale avec données fictives ; l'exporter en release et étudier son format avec le modèle XML existant.
2. Étendre les modèles typés aux définitions et références API réellement observées, avec conservation des champs inconnus et test d'aller-retour.
3. Générer un objet d'intégration et un process court utilisant la réponse ; importer et exécuter dans BP.
4. Intégrer l'appel au template de consommation de queue, avec la politique d'exceptions/reprises décidée pour le template.
5. Valider séparément l'exposition SOAP, puis le contrat REST asynchrone si nécessaire. L'installation Hub/API reste une piste indépendante.

La démo cible peut réunir les deux sens : demande entrante → queue → appel API pour enrichir les données → objet web → résultat consultable. Cette extension ne change pas le principe du projet : le LLM choisit les opérations et le code produit des artefacts typés et validés.

## Preuves attendues avant de dire « testé »

| Cas | Preuve attendue |
| --- | --- |
| GET valide au milieu du process | Valeurs typées utilisées dans l'étape suivante et résultat vérifié |
| Credential fictif valide/invalide | Succès ou erreur attendue, aucun secret dans logs/exports/retours MCP |
| Données absentes ou schéma incorrect | Branche métier ou exception explicitement prévue |
| 401, 429, 500 et timeout | Traitements distincts, nombre de reprises et délai total bornés |
| Mutation dont la réponse est perdue | Aucune répétition aveugle ; résultat réconcilié ou statut indéterminé explicite |
| Réception lorsque le worker est occupé | Demande conservée puis remise à BP sans session supplémentaire supposée |
| Rejeu et doublons concurrents | Même demande reconnue, conflit si payload différent, pas de double effet métier |
| Redémarrage entre acceptation et insertion BP | Reprise ou réconciliation prouvée |
| SOAP | WSDL réel, appel authentifié, permissions, traitement d'erreur et libération de session |

Ces tests restent à exécuter. Les validations RPA Challenge précédentes ne les couvrent pas.
