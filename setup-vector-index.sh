#!/usr/bin/env bash
set -euo pipefail
for collection in chunks systemCheckChunks; do
  gcloud firestore indexes composite create --project=ntpc-ai-seag --database='(default)' --collection-group="$collection" --query-scope=COLLECTION --field-config=field-path=recordType,order=ASCENDING --field-config=field-path=configHash,order=ASCENDING --field-config=field-path=searchReady,order=ASCENDING --field-config='field-path=embedding,vector-config={"dimension":1536,"flat":{}}'
done
gcloud firestore indexes composite list --project=ntpc-ai-seag --database='(default)' --format='table(name,state)'
