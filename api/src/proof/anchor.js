// Writing a Merkle root on an EVM chain: one transaction from Join's own address to itself, sending nothing, with the
// data "JOIN" + the 32-byte root. No contract and no token: the transaction is only a public, timestamped place for the
// root. Any chain works: a local Hardhat or Anvil node for development, a public one for the single production proof.
//   ANCHOR_RPC_URL       the chain's RPC (http://127.0.0.1:8545 for Hardhat / Anvil)
//   ANCHOR_PRIVATE_KEY   a key made only for this (locally, one of the node's development accounts)
//   ANCHOR_MODE          "each": every batch goes on chain (the default on a local chain, chain id 31337)
//                        "seal": batches stay off chain until one transaction seals all of them (the default elsewhere)
import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const PREFIX = "4a4f494e"; // "JOIN"
const KNOWN = {
  1: { name: "Ethereum", explorer: "https://etherscan.io" },
  11155111: { name: "Ethereum Sepolia", explorer: "https://sepolia.etherscan.io" },
  8453: { name: "Base", explorer: "https://basescan.org" },
  84532: { name: "Base Sepolia", explorer: "https://sepolia.basescan.org" },
  421614: { name: "Arbitrum Sepolia", explorer: "https://sepolia.arbiscan.io" },
  31337: { name: "local chain (Hardhat / Anvil)", explorer: null },
};
export const chainName = (id) => KNOWN[id]?.name || `EVM chain ${id}`;
export const explorer = (id, tx) => (KNOWN[id]?.explorer ? `${KNOWN[id].explorer}/tx/${tx}` : null);
const chainOf = (id, rpcUrl) => defineChain({ id, name: chainName(id), nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });

// The anchor for this server, or null when no chain is configured
export async function evmAnchor({ rpcUrl = process.env.ANCHOR_RPC_URL, privateKey = process.env.ANCHOR_PRIVATE_KEY, mode = process.env.ANCHOR_MODE } = {}) {
  if (!rpcUrl || !privateKey) return null;
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const id = await probe.getChainId();
  const chain = chainOf(id, rpcUrl), account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  const send = async (root) => {
    const hash = await wallet.sendTransaction({ to: account.address, value: 0n, data: `0x${PREFIX}${root}` });
    const r = await reader.waitForTransactionReceipt({ hash, timeout: 120e3 });
    return { chain: chainName(id), chainId: id, tx: hash, block: Number(r.blockNumber), from: account.address, status: r.status, url: explorer(id, hash) };
  };
  send.address = account.address;
  send.chainId = id;
  send.chain = chainName(id);
  send.mode = mode === "each" || mode === "seal" ? mode : id === 31337 ? "each" : "seal";
  return send;
}

// Reading a root back from a transaction, for verifiers
export async function rootInTx(rpcUrl, tx) {
  const reader = createPublicClient({ transport: http(rpcUrl) });
  const t = await reader.getTransaction({ hash: tx });
  const data = String(t.input).toLowerCase();
  return data.startsWith(`0x${PREFIX}`) ? { root: data.slice(2 + PREFIX.length), from: t.from, block: Number(t.blockNumber) } : null;
}
