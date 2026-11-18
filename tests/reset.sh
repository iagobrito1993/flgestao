P="psql -h /tmp/pgt -p 5499 -U postgres -q"
$P -c "drop database if exists t" && $P -c "create database t" && $P -d t -f /tmp/pgt/stub.sql >/dev/null
for i in 1 2; do
 $P -d t -v ON_ERROR_STOP=1 -f /home/claude/flgestao/supabase/schema.sql 2>&1 | grep -v NOTICE | tail -3
 $P -d t -v ON_ERROR_STOP=1 -f /home/claude/flgestao/supabase/schema_operacoes.sql 2>&1 | grep -v NOTICE | tail -5
done
echo reset-ok
