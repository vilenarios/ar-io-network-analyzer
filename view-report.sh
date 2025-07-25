#!/bin/bash

# Script to open the latest HTML report in the default browser

# Find the most recent HTML report
LATEST_REPORT=$(ls -t gateway-centralization-report-*.html 2>/dev/null | head -n1)

if [ -z "$LATEST_REPORT" ]; then
    echo "❌ No HTML report found. Please run the analyzer first:"
    echo "   npm run analyze"
    exit 1
fi

echo "🌐 Opening report: $LATEST_REPORT"

# Detect OS and open in default browser
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    open "$LATEST_REPORT"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if command -v xdg-open > /dev/null; then
        xdg-open "$LATEST_REPORT"
    elif command -v gnome-open > /dev/null; then
        gnome-open "$LATEST_REPORT"
    else
        echo "Please open $LATEST_REPORT in your browser manually"
    fi
elif [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    # Windows
    start "$LATEST_REPORT"
else
    echo "Please open $LATEST_REPORT in your browser manually"
fi