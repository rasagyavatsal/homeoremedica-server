# HomeoRemedica API

The API behind HomeoRemedica: retrieval-augmented chat over seven historical homoeopathic books (Allen,
Boericke, Clarke, Hahnemann, Kent) that answers with cited passages. Historical reference only; not
medical advice.

**Live:** <https://homeoremedica-619837289655.asia-south1.run.app/api/health>

The web app is [homeoremedica-web](https://github.com/rasagyavatsal/homeoremedica-web) and the Android
client [homeoremedica-android](https://github.com/rasagyavatsal/homeoremedica-android). The Qdrant
collections come from [homeoremedica-private](https://github.com/rasagyavatsal/homeoremedica-private).

## Setup

Requires Node.js 22.18+ (24 recommended), a Qdrant 1.15.2+ cluster with the seven book collections, and
an OpenRouter API key.

```sh
npm ci
cp .env.example .env                      # then set the variables below
gcloud auth application-default login     # only for saved chats locally (Firestore)
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `QDRANT_URL` | Required for chat | Qdrant cluster URL. |
| `QDRANT_API_KEY` | None | Qdrant API key; Qdrant Cloud requires it. |
| `OPENROUTER_API_KEY` | Required for chat | Embeddings, answers and the models that prepare a search. |
| `RAG_MODEL` | `openai/gpt-6-luna` | OpenRouter answer model. |
| `RAG_MAX_OUTPUT_TOKENS` | `8192` | Output token limit, 1 to 8192. |
| `FIREBASE_PROJECT_ID` | None | With `FIREBASE_API_KEY`, turns on sign-in and saved chats. |
| `FIREBASE_API_KEY` | None | Public browser key for Firebase Authentication. |
| `FIREBASE_AUTH_DOMAIN` | `<project>.firebaseapp.com` | Hosts the Google sign-in pop-up. |
| `WEB_ORIGINS` | None | Web app origins allowed through CORS, comma-separated. |
| `MIN_ANDROID_VERSION_CODE` | `0` | Android builds below this versionCode must update first. |
| `HOST` | `127.0.0.1` | Address `npm start` listens on. |
| `PORT` | `8000` | Port `npm start` listens on. |

Variables come from the environment, `.env` and `.env.local`.

## Run

```sh
npm run dev     # API on http://127.0.0.1:8000, restarting on edits; restart after editing .env
npm start       # the same, without watching
curl http://127.0.0.1:8000/api/health
```

The routes are in `src/app.ts` and the request and response shapes in `src/contracts.ts`. The web repo
keeps a copy of `src/contracts.ts` and its deploy fails when the two differ.

## Test

```sh
npm run check         # type-check and unit tests (fakes, no keys or Qdrant)
node e2e/server.ts    # e2e API on http://127.0.0.1:8100 with scripted answers
npx --yes firebase-tools@15.32.1 emulators:start --config e2e/firebase.json \
  --project demo-homeoremedica --only auth,firestore   # accounts for the e2e API
```

The e2e server needs no keys. It and the Firebase Auth and Firestore emulators (ports 9099 and 8086,
Java 21+) are what the web app's `npm run e2e` and Android's `./e2e.sh` start from a sibling
`../homeoremedica-server` checkout. `e2e/scenario.ts` holds what they agree on.

## Deploy

| | Prod | Dev |
|---|---|---|
| Project | `homeoremedica` | `homeoremedica-dev-1` |
| Web (Firebase Hosting) | `https://homeoremedica.com` | `https://homeoremedica-dev-1.web.app` |
| API (Cloud Run, `asia-south1`) | `https://homeoremedica-619837289655.asia-south1.run.app` | `https://homeoremedica-119730286024.asia-south1.run.app` |
| Deploys on | a release from `main` | every push to `branch` |

```sh
npm run deploy                                    # API to prod's Cloud Run service
GCP_PROJECT=homeoremedica-dev-1 npm run deploy    # API to dev's
```

Merging release-please's PR on `main` tags a `v*` release, which runs the `Deploy` workflow for prod;
`Deploy dev` runs it for dev on each push to `branch`. The web repo deploys Hosting the same way. Each
project trusts only its own branch of the two repos through its own Workload Identity pool. The service runs one instance, so the in-memory rate limits hold. It
keeps its configuration between deploys: `QDRANT_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY` and
`WEB_ORIGINS` (the web app's origins, comma-separated) are plain, the other keys come from Secret
Manager, and `.env` is not copied into the image.

Before a deploy that breaks older Android builds, ask them to update:

```sh
gcloud run services update homeoremedica --region asia-south1 --project $P \
  --update-env-vars MIN_ANDROID_VERSION_CODE=<oldest versionCode that works>
```

One-time setup of a project `$P` (number `$N`), shared with the web app, after creating it, linking
billing and adding Firebase:

```sh
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com identitytoolkit.googleapis.com \
  firebasehosting.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project $P
gcloud firestore databases create --location asia-south1 --project $P
firebase apps:create WEB "HomeoRemedica Web" --project $P
firebase apps:create ANDROID "HomeoRemedica Android" --package-name com.rasagyavatsal.homeoremedica --project $P
# Then turn on Email/Password and Google sign-in in the Firebase console.

# Secrets, read by the default compute service account
for s in OPENROUTER_API_KEY QDRANT_API_KEY; do
  gcloud secrets create $s --data-file=- --project $P   # paste the key, then Ctrl-D
done
gcloud projects add-iam-policy-binding $P --role roles/secretmanager.secretAccessor \
  --member serviceAccount:$N-compute@developer.gserviceaccount.com

# First deploy
GCP_PROJECT=$P npm run deploy -- --allow-unauthenticated \
  --set-env-vars "^@^QDRANT_URL=...@FIREBASE_PROJECT_ID=$P@FIREBASE_API_KEY=...@WEB_ORIGINS=https://$P.web.app,https://$P.firebaseapp.com" \
  --set-secrets OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,QDRANT_API_KEY=QDRANT_API_KEY:latest

# GitHub Actions: only pushes to <branch> may deploy (main for prod, branch for dev)
gcloud iam workload-identity-pools create github --location global --project $P
gcloud iam workload-identity-pools providers create-oidc github --workload-identity-pool github \
  --location global --project $P --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
  --attribute-condition "assertion.repository in ['rasagyavatsal/homeoremedica-server', 'rasagyavatsal/homeoremedica-web'] && assertion.ref == 'refs/heads/<branch>'"
gcloud iam service-accounts create github-deployer --project $P
SA=github-deployer@$P.iam.gserviceaccount.com
for r in run.sourceDeveloper serviceusage.serviceUsageConsumer logging.viewer firebasehosting.admin; do
  gcloud projects add-iam-policy-binding $P --role roles/$r --member serviceAccount:$SA
done
for repo in homeoremedica-server homeoremedica-web; do
  gcloud iam service-accounts add-iam-policy-binding $SA --project $P --role roles/iam.workloadIdentityUser \
    --member principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository/rasagyavatsal/$repo
done
gcloud iam service-accounts add-iam-policy-binding $N-compute@developer.gserviceaccount.com --project $P \
  --role roles/iam.serviceAccountUser --member serviceAccount:$SA

# Sign-in from the web origins
gcloud services api-keys update <browser key id> --project $P \
  --allowed-referrers "https://$P.web.app/*,https://$P.firebaseapp.com/*,https://homeoremedica-$N.asia-south1.run.app/*"
```

## License

Software and documentation: [MIT](LICENSE). The dataset is proprietary and lives in
[homeoremedica-private](https://github.com/rasagyavatsal/homeoremedica-private).
