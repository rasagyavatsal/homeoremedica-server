# HomeoRemedica

Retrieval-augmented chat over seven historical homoeopathic books (Allen, Boericke, Clarke, Hahnemann,
Kent) that answers with cited passages. Historical reference only; not medical advice.

**Live:** <https://homeoremedica-619837289655.asia-south1.run.app>

This repository is the Hono API (`src/server`) and the React web app (`src/web`). The Qdrant collections
come from [homeoremedica-private](https://github.com/rasagyavatsal/homeoremedica-private); the Android
client is [homeoremedica-android](https://github.com/rasagyavatsal/homeoremedica-android).

## Setup

Requires Node.js 22.18+ (24 recommended), a Qdrant 1.15.2+ cluster with the seven book collections, and
OpenRouter and Z.AI API keys.

```sh
npm ci
cp .env.example .env                      # then set the variables below
gcloud auth application-default login     # only for saved chats locally (Firestore)
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `QDRANT_URL` | Required for chat | Qdrant cluster URL. |
| `QDRANT_API_KEY` | None | Qdrant API key; Qdrant Cloud requires it. |
| `OPENROUTER_API_KEY` | Required for chat | Query embeddings (`voyageai/voyage-4`). |
| `ZAI_API_KEY` | Required for chat | Answer generation. |
| `RAG_MODEL` | `glm-5.3-flash` | Answer model. |
| `RAG_MAX_OUTPUT_TOKENS` | `4096` | Output token limit, 1 to 4096. |
| `FIREBASE_PROJECT_ID` | None | With `FIREBASE_API_KEY`, turns on sign-in and saved chats. |
| `FIREBASE_API_KEY` | None | Public browser key for Firebase Authentication. |
| `FIREBASE_AUTH_DOMAIN` | `<project>.firebaseapp.com` | Hosts the Google sign-in pop-up. |
| `HOST` | `127.0.0.1` | Address `npm start` listens on. |
| `PORT` | `8000` | Port `npm start` listens on. |

Variables come from the environment, `.env` and `.env.local`.

## Run

```sh
npm run dev                 # frontend and API on http://127.0.0.1:5173; restart after editing .env
npm run build && npm start  # built frontend and API on http://127.0.0.1:8000
```

Port 5173 must be free; Vite fails rather than switching ports. The API's routes are in
`src/server/app.ts` and its request and response shapes in `src/server/contracts.ts`.

## Test

```sh
npm run check                     # type-check, unit tests (fakes, no keys or Qdrant), build
npx playwright install chromium   # once, before the e2e tests
npm run e2e                       # built app in Chromium, desktop and phone sizes
npm run e2e -- --ui               # the same, watching them run
npm run e2e:smoke                 # one real question to production with the keys in .env
```

`npm run e2e` needs no keys: `e2e/server.ts` scripts the answers, and Playwright starts the Firebase Auth
and Firestore emulators on ports 9099 and 8086, which need Java 21+. Android's e2e tests use the same
server.

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
VITE_API_ORIGIN=<API URL> npm run build           # web app that calls that API
firebase deploy --only hosting --project prod     # or --project dev
```

Merging release-please's PR on `main` tags a `v*` release, which runs the `Deploy` workflow for prod;
`Deploy dev` runs it for dev on each push to `branch`. Each project trusts only its own branch through
its own Workload Identity pool. The service runs one instance, so the in-memory rate limits hold. It
keeps its configuration between deploys: `QDRANT_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY` and
`WEB_ORIGINS` (the web app's origins, comma-separated) are plain, the other keys come from Secret
Manager, and `.env` is not copied into the image.

One-time setup of a project `$P` (number `$N`), after creating it, linking billing and adding Firebase:

```sh
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com identitytoolkit.googleapis.com \
  firebasehosting.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project $P
gcloud firestore databases create --location asia-south1 --project $P
firebase apps:create WEB "HomeoRemedica Web" --project $P
firebase apps:create ANDROID "HomeoRemedica Android" --package-name com.rasagyavatsal.homeoremedica --project $P
# Then turn on Email/Password and Google sign-in in the Firebase console.

# Secrets, read by the default compute service account
for s in OPENROUTER_API_KEY ZAI_API_KEY QDRANT_API_KEY; do
  gcloud secrets create $s --data-file=- --project $P   # paste the key, then Ctrl-D
done
gcloud projects add-iam-policy-binding $P --role roles/secretmanager.secretAccessor \
  --member serviceAccount:$N-compute@developer.gserviceaccount.com

# First deploy
GCP_PROJECT=$P npm run deploy -- --allow-unauthenticated \
  --set-env-vars "^@^QDRANT_URL=...@FIREBASE_PROJECT_ID=$P@FIREBASE_API_KEY=...@WEB_ORIGINS=https://$P.web.app,https://$P.firebaseapp.com" \
  --set-secrets OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,ZAI_API_KEY=ZAI_API_KEY:latest,QDRANT_API_KEY=QDRANT_API_KEY:latest

# GitHub Actions: only pushes to <branch> may deploy (main for prod, branch for dev)
gcloud iam workload-identity-pools create github --location global --project $P
gcloud iam workload-identity-pools providers create-oidc github --workload-identity-pool github \
  --location global --project $P --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
  --attribute-condition "assertion.repository == 'rasagyavatsal/homeoremedica-app' && assertion.ref == 'refs/heads/<branch>'"
gcloud iam service-accounts create github-deployer --project $P
SA=github-deployer@$P.iam.gserviceaccount.com
for r in run.sourceDeveloper serviceusage.serviceUsageConsumer logging.viewer firebasehosting.admin; do
  gcloud projects add-iam-policy-binding $P --role roles/$r --member serviceAccount:$SA
done
gcloud iam service-accounts add-iam-policy-binding $SA --project $P --role roles/iam.workloadIdentityUser \
  --member principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository/rasagyavatsal/homeoremedica-app
gcloud iam service-accounts add-iam-policy-binding $N-compute@developer.gserviceaccount.com --project $P \
  --role roles/iam.serviceAccountUser --member serviceAccount:$SA

# Sign-in from the web origins
gcloud services api-keys update <browser key id> --project $P \
  --allowed-referrers "https://$P.web.app/*,https://$P.firebaseapp.com/*,https://homeoremedica-$N.asia-south1.run.app/*"
```

## License

Software and documentation: [MIT](LICENSE). The dataset is proprietary and lives in
[homeoremedica-private](https://github.com/rasagyavatsal/homeoremedica-private).
