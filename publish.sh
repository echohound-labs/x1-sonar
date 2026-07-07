#!/bin/bash
set -e
node apply-pending.js "${1:-pending-registry.json}"
git add registry.json dashboard/registry.json
git commit -m "Registry: bot-approved batch"
git push
