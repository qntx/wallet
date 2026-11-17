#!/usr/bin/env bash
# Audit GS: probes public upstreams with requests the gateway contract accepts.
# Run from anywhere: bash audit/gateway-supply/upstream-probe.sh
set -uo pipefail
rpc() { curl -s -m 20 -o /tmp/gs-probe.txt -w "http=%{http_code} " -H content-type:application/json -d "$2" "$1"; head -c 140 /tmp/gs-probe.txt | tr '\n' ' '; echo; }

echo "== GS-C: gateway-valid requests an upstream answers with a non-2xx status (counted as a provider failure)"
for u in https://ethereum-sepolia-rpc.publicnode.com https://base-sepolia-rpc.publicnode.com https://eth.drpc.org; do
  printf '%s id:null eth_chainId      ' "$u"; rpc "$u" '{"jsonrpc":"2.0","id":null,"method":"eth_chainId","params":[]}'
  printf '%s eth_getBalance ["0xzz"]  ' "$u"; rpc "$u" '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xzz","latest"]}'
done

echo "== GS-B: blocks between the finalized/safe tags and latest"
for u in https://arb1.arbitrum.io/rpc https://mainnet.base.org https://mainnet.optimism.io https://ethereum-rpc.publicnode.com; do
  n() { curl -s -m 10 -H content-type:application/json -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"$1\",false]}" "$u" | jq -r .result.number; }
  l=$(n latest); f=$(n finalized); s=$(n safe)
  echo "$u finalized->latest=$(( l - f )) safe->latest=$(( l - s ))"
done

echo "== GS-D: size of one gateway-valid Solana mainnet getBlock"
slot=$(curl -s -m 10 -H content-type:application/json -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}' https://api.mainnet-beta.solana.com | jq .result)
curl -s -m 60 -o /dev/null -w "getBlock slot=$((slot - 50)) http=%{http_code} bytes=%{size_download}\n" -H content-type:application/json \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBlock\",\"params\":[$((slot - 50)),{\"encoding\":\"json\",\"transactionDetails\":\"full\",\"maxSupportedTransactionVersion\":1,\"rewards\":false}]}" \
  https://api.mainnet-beta.solana.com
