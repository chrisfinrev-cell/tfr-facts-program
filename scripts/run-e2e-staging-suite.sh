#!/usr/bin/env bash
# Exit immediately if a command exits with a non-zero status
set -e
echo "=================================================="
echo " STARTING FULL E2E STAGING SUITE EXECUTION        "
echo "=================================================="
echo ""
echo "[1/4] Running Step 2: Plaid Pipeline Integration Test..."
node scripts/test-plaid-pipeline.js
echo ""
echo "[2/4] Running Step 3: Sovereign Vault Scaffold & 9-Pod Test..."
node scripts/test-vault-scaffold.js
echo ""
echo "[3/4] Running Step 4: Sovereign Lens & Nightly Discipline Test..."
node scripts/test-sovereign-lens.js
echo ""
echo "[4/4] Running Step 5: Truth in Lending & Compliance Test..."
node scripts/test-truth-in-lending.js
echo ""
echo "=================================================="
echo " ALL E2E AUDIT TESTS PASSED SUCCESSFULLY (EXIT 0) "
echo "=================================================="
