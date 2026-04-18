#!/bin/bash
cd "$(dirname "$0")"

echo "Setting up git..."
git init
git config user.name "ayoubouddaf-creator"
git config user.email "ayoub.ouddaf@gmail.com"

echo "Adding remote..."
git remote remove origin 2>/dev/null
git remote add origin https://github.com/ayoubouddaf-creator/gmail-organizer-extension.git

echo "Staging files..."
git add .
git commit -m "feat: Gmail Organizer v2.0.0 — full release build"

echo "Pushing to GitHub (you may be asked for your GitHub password or token)..."
git push -f origin main

echo ""
echo "Done! Visit https://github.com/ayoubouddaf-creator/gmail-organizer-extension"
