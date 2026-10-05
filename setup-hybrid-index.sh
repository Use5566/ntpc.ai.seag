#!/bin/sh
set -eu
for collection in chunks systemCheckChunks; do
 gcloud firestore indexes composite create --project=ntpc-ai-seag --database='(default)' --collection-group="$collection" --query-scope=COLLECTION --field-config=field-path=recordType,order=ASCENDING --field-config=field-path=configHash,order=ASCENDING --field-config=field-path=searchReady,order=ASCENDING --field-config=field-path=keywordTokens,array-config=CONTAINS --async
done
gcloud firestore indexes composite list --project=ntpc-ai-seag --database='(default)' --format='table(name,state)'
