import { config } from "dotenv";

config();

const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
  POLL_INTERVAL_MS: 20000,
  BLOCKS_PER_SCAN: 3,
};

console.log("🔑 TELEGRAM_BOT_TOKEN:", CONFIG.TELEGRAM_BOT_TOKEN ? CONFIG.TELEGRAM_BOT_TOKEN.slice(0,6) + "..." : "❌ NOT FOUND");
console.log("🔑 TELEGRAM_CHAT_ID:", CONFIG.TELEGRAM_CHAT_ID || "❌ NOT FOUND");
console.log("🔑 ALCHEMY_API_KEY:", CONFIG.ALCHEMY_API_KEY ? CONFIG.ALCHEMY_API_KEY.slice(0,6) + "..." : "❌ NOT FOUND");

const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${CONFIG.ALCHEMY_API_KEY}`;

const NFT_SIGNATURES = { ERC721: "80ac58cd", ERC1155: "d9b67a26" };
let lastScannedBlock = null;
const notifiedContracts = new Set();

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  return res.json();
}

async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  return res.json();
}

async function getLatestBlock() {
  const res = await rpc("eth_blockNumber");
  console.log("📦 RPC response:", JSON.stringify(res).slice(0, 80));
  return parseInt(res.result, 16);
}

async function getBlock(blockNum) {
  const res = await rpc("eth_getBlockByNumber", [`0x${blockNum.toString(16)}`, true]);
  return res.result;
}

async function getTransactionReceipt(txHash) {
  const res = await rpc("eth_getTransactionReceipt", [txHash]);
  return res.result;
}

async function getCode(address) {
  const res = await rpc("eth_getCode", [address, "latest"]);
  return res.result || "0x";
}

function isNFTContract(bytecode) {
  const code = bytecode.toLowerCase();
  return code.includes(NFT_SIGNATURES.ERC721) || code.includes(NFT_SIGNATURES.ERC1155);
}

function getNFTStandard(bytecode) {
  const code = bytecode.toLowerCase();
  const s = [];
  if (code.includes(NFT_SIGNATURES.ERC721)) s.push("ERC-721");
  if (code.includes(NFT_SIGNATURES.ERC1155)) s.push("ERC-1155");
  return s.join(" + ");
}

async function scan() {
  try {
    const latestBlock = await getLatestBlock();
    if (isNaN(latestBlock)) { console.error("❌ Could not get block number"); return; }

    if (!lastScannedBlock) {
      lastScannedBlock = latestBlock - CONFIG.BLOCKS_PER_SCAN;
      console.log(`🚀 Starting from block ${lastScannedBlock}`);
    }

    if (latestBlock <= lastScannedBlock) return;

    const fromBlock = lastScannedBlock + 1;
    const toBlock = Math.min(latestBlock, lastScannedBlock + CONFIG.BLOCKS_PER_SCAN);
    console.log(`🔍 Scanning blocks ${fromBlock} → ${toBlock}`);

    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      const block = await getBlock(blockNum);
      if (!block || !block.transactions) continue;

      const contractCreations = block.transactions.filter(tx => !tx.to || tx.to === "0x0000000000000000000000000000000000000000");
      console.log(`   Block ${blockNum}: ${block.transactions.length} txs, ${contractCreations.length} contract creations`);

      for (const tx of contractCreations) {
        const receipt = await getTransactionReceipt(tx.hash);
        const contractAddress = receipt?.contractAddress;
        if (!contractAddress || notifiedContracts.has(contractAddress)) continue;

        const bytecode = await getCode(contractAddress);
        if (!isNFTContract(bytecode)) continue;

        notifiedContracts.add(contractAddress);
        const standard = getNFTStandard(bytecode);

        const msg =
          `🎨 <b>New NFT Collection Detected!</b>\n\n` +
          `🔖 <b>Standard:</b> ${standard}\n` +
          `📦 <b>Block:</b> ${blockNum}\n` +
          `🔑 <b>Contract:</b> <code>${contractAddress}</code>\n\n` +
          `🔗 <a href="https://etherscan.io/address/${contractAddress}">Etherscan</a>  |  ` +
          `<a href="https://opensea.io/assets/ethereum/${contractAddress}">OpenSea</a>`;

        console.log(`🎨 NFT Found! (${standard}) - ${contractAddress}`);
        await sendTelegram(msg);
        console.log(`✅ Telegram notification sent`);
        await new Promise(r => setTimeout(r, 300));
      }
    }

    lastScannedBlock = toBlock;
  } catch (err) {
    console.error("⚠️  Scan error:", err.message);
  }
}

async function start() {
  console.log("━".repeat(50));
  console.log("  🤖 NFT Collection Watcher Bot");
  console.log("━".repeat(50));
  console.log(`  RPC           : Alchemy`);
  console.log(`  Poll interval : ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Blocks/scan   : ${CONFIG.BLOCKS_PER_SCAN}`);
  console.log("━".repeat(50));

  try {
    await sendTelegram("🤖 <b>NFT Watcher Bot started!</b>\nMonitoring Ethereum mainnet for new NFT collections...");
    console.log("✅ Telegram connected");
  } catch (e) {
    console.error("❌ Telegram failed:", e.message);
  }

  await scan();
  setInterval(scan, CONFIG.POLL_INTERVAL_MS);
}

start();
