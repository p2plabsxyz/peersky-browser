#!/bin/bash
#
# Session Usage Regression Prevention Script
# 
# This script prevents direct usage of session.defaultSession in the codebase,
# enforcing the use of getBrowserSession() utility instead.
#
# Usage: ./scripts/check-session.sh
# Exit codes: 0 = clean, 1 = violations found

echo "🔍 Checking for session.defaultSession usage..."

# Search for direct session.defaultSession usage, excluding the utils file
violations=$(grep -RIn "session\.defaultSession" src/ | grep -v "utils/session")

if [ -n "$violations" ]; then
    echo "❌ Direct session.defaultSession usage found:"
    echo "$violations"
    echo ""
    echo "💡 Use getBrowserSession() from src/utils/session.js instead"
    echo "   Example: const userSession = getBrowserSession();"
    exit 1
else
    echo "✅ No session.defaultSession violations found"
    exit 0
fi