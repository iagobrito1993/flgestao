pkill -f "node server.js" 2>/dev/null; sleep 0.5
bash /tmp/pgt/reset.sh 2>&1 | grep -v -i "already\|notice"
psql -h /tmp/pgt -p 5499 -U postgres -d t -q -v ON_ERROR_STOP=1 -f /tmp/uitest/seed.sql >/dev/null && echo seeded
cd /tmp/uitest && (node server.js > server.log 2>&1 &) && sleep 1
timeout 600 node ui.test.js
