#!/bin/bash

# 1. Check if there are any electron processes running
if pgrep -x "electron" > /dev/null || pgrep -f "electron .*" > /dev/null; then
    echo "Found running electron instances:"
    # List the processes
    ps -ef | grep -i "[e]lectron"

    echo ""
    echo "Killing all electron instances..."
    
    # 2. Force kill all electron processes
    echo "About to kill all processes matching 'electron'."
    read -r -p "Continue? [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || exit 1
    pkill -f electron
    
    # 3. Give them a second to terminate
    sleep 1
    
    # 4. Verify they are dead
    if pgrep -f "electron" > /dev/null; then
        echo "Some instances refused to die. Force killing (SIGKILL)..."
        pkill -9 -f electron
        echo "Done."
    else
        echo "All electron instances successfully terminated."
    fi
else
    echo "No electron instances are currently running."
fi
