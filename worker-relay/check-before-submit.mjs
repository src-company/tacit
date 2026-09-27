import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const pv = "0x" + readFileSync("/tmp/final_pv.hex", "utf8").trim();
const proof = "0x" + readFileSync("/tmp/final_proof.hex", "utf8").trim();

const POOL = "0x000000000Ed1eabD231Be41d93b719056F7febFC";
const RELAY = "0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7";
const ABI = [{
  type: "function", name: "attestBitcoinStateProven", stateMutability: "nonpayable",
  inputs: [{ name: "publicValues", type: "bytes" }, { name: "proofBytes", type: "bytes" }],
  outputs: [],
}];

const publicClient = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com", { timeout: 15000 }) });

try {
  const gas = await publicClient.estimateContractGas({
    address: POOL, abi: ABI, functionName: "attestBitcoinStateProven", args: [pv, proof], account: RELAY,
  });
  console.log("WOULD_SUCCEED gas:", gas.toString());
} catch (e) {
  console.log("WOULD_REVERT:", e.shortMessage || e.message);
  process.exitCode = 1;
}
