// Writing a batch's Merkle root on chain: one transaction on Ethereum Sepolia (a test network: its ether has no value),
// from Join's own address to itself, sending nothing, with the data "JOIN" + the 32-byte root. No contract and no
// token: the transaction is only a public, timestamped place for the root.
// Configure ANCHOR_RPC_URL (any Sepolia RPC) and ANCHOR_PRIVATE_KEY (a key made only for this, holding a little Sepolia
// ether from a faucet for fees). Without them, batches are still made and signed, and say they are not anchored.
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const PREFIX = "4a4f494e"; // "JOIN"
export const explorer = (tx) => `https://sepolia.etherscan.io/tx/${tx}`;

export function sepoliaAnchor({ rpcUrl = process.env.ANCHOR_RPC_URL, privateKey = process.env.ANCHOR_PRIVATE_KEY } = {}) {
  if (!rpcUrl || !privateKey) return null;
  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  const reader = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const send = async (root) => {
    const hash = await wallet.sendTransaction({ to: account.address, value: 0n, data: `0x${PREFIX}${root}` });
    const r = await reader.waitForTransactionReceipt({ hash, timeout: 120e3 });
    return { chain: "sepolia", chainId: sepolia.id, tx: hash, block: Number(r.blockNumber), from: account.address, status: r.status, url: explorer(hash) };
  };
  send.address = account.address;
  return send;
}

// Reading a root back from a transaction, for verifiers
export async function rootInTx(rpcUrl, tx) {
  const reader = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const t = await reader.getTransaction({ hash: tx });
  const data = String(t.input).toLowerCase();
  return data.startsWith(`0x${PREFIX}`) ? { root: data.slice(2 + PREFIX.length), from: t.from, block: Number(t.blockNumber) } : null;
}
