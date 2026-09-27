import { readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { parseEnvFile } from "/Users/z/tacit/scripts/env.mjs";

const env = parseEnvFile("/Users/z/tacit/.env") || {};
const priv = env.WALLET_PRIV.startsWith("0x") ? env.WALLET_PRIV : "0x" + env.WALLET_PRIV;
const account = privateKeyToAccount(priv);
console.log("relay address:", account.address);

const pv = "0x" + readFileSync("/tmp/final_pv.hex", "utf8").trim();
const proof = "0x" + readFileSync("/tmp/final_proof.hex", "utf8").trim();
console.log("pv bytes:", (pv.length - 2) / 2, "proof bytes:", (proof.length - 2) / 2);

const POOL = "0x000000000Ed1eabD231Be41d93b719056F7febFC";
const ABI = [{
  type: "function", name: "attestBitcoinStateProven", stateMutability: "nonpayable",
  inputs: [{ name: "publicValues", type: "bytes" }, { name: "proofBytes", type: "bytes" }],
  outputs: [],
}];

const RPC = "https://ethereum-rpc.publicnode.com";
const publicClient = createPublicClient({ chain: mainnet, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(RPC) });

console.log("estimating gas...");
const gas = await publicClient.estimateContractGas({
  address: POOL, abi: ABI, functionName: "attestBitcoinStateProven", args: [pv, proof], account,
});
console.log("estimated gas:", gas.toString());

const txHash = await walletClient.writeContract({
  address: POOL, abi: ABI, functionName: "attestBitcoinStateProven", args: [pv, proof],
  gas: (gas * 125n) / 100n,
});
console.log("SUBMITTED tx:", txHash);
