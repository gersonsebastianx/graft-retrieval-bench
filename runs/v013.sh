#!/bin/bash
cd /Users/gersonsebastian/Proyectos/Graft/graft-bench
BIN="$(pwd)/vendor/graft-0.13/node_modules/@nanonets/graft/dist/cli.js"
for r in nest django spring-boot; do
  echo "##### $r on 0.13.0 #####"
  node bench/verify-hypotheses.mjs --repo $r --k 10 --graft-bin "$BIN" 2>/dev/null
done
echo "##### ALL DONE #####"
