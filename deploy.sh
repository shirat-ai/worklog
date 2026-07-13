#!/usr/bin/env bash
# פריסת המערכת ל-Firebase Hosting (shirat-worklog.web.app) — hosting בלבד, לא נוגע בנתונים/rules.
set -e
cd "$(dirname "$0")"
mkdir -p site
cp index.html site/index.html
cp logo.png  site/logo.png
firebase deploy --only hosting --project shirat1
echo ""
echo "✓ נפרס ל-https://shirat-worklog.web.app  (no-cache — מתעדכן מיד)"
echo "  לגיבוי-קוד ב-GitHub Pages:  git add index.html && git commit && git push origin main"
