#!/bin/bash
cd /Users/gersonsebastian/Proyectos/Graft/graft-bench
for r in pocketbase nest django spring-boot; do
  echo "##### $r #####"
  node bench/verify-hypotheses.mjs --repo $r --k 10 2>/dev/null
done
echo "##### ALL DONE #####"
