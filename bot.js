import https from "https";
import { config } from "dotenv";

config();

const CONFIG = {
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY || "YourApiKeyToken",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "YOUR_CHAT_ID",
  POLL_INTERVAL_MS: 20000,
  BLOCKS_PER_SCAN: 5,
};

// DEBUG - shows what keys Railway can see (safe - only shows first 6 chars)
console.log("🔑 ETHERSCAN_API_KEY:", CONFIG.ETHERSCAN_API_KEY ? CONFIG.ETHERSCAN_API_KEY.slice(0,6) + "..." : "❌ NOT FOUND");
console.log("🔑 TELEGRAM_BOT_TOKEN:", CONFIG.TELEGRAM_BOT_TOKEN ? CONFIG.TELEGRAM_BOT_TOKEN.slice(0,6) + "..." : "❌ NOT FOUND");
console.log("🔑 TELEGRAM_CHAT_ID:", CONFIG.TELEGRAM_CHAT_ID || "❌ NOT FOUND");

const NFT_SIGNATURES = { ERC721: "80ac58cd", ERC1155: "d9b67a26" };
let lastScannedBlock = null;
const notifiedContracts = new Set();

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("JSON parse error")); } });
    }).on("error", reject);
  });
}

function sendTelegram(message) {
  const body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML", disable_web_page_preview: false });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data))); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getLatestBlock() {
  const res = await get(`https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
  return parseInt(res.result, 16);
}

async function getContractCreations(block) {
  const res = await get(`https://api.etherscan.io/api?module=proxy&action=eth_getBlockByNumber&tag=0x${block.toString(16)}&boolean=true&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
  if (!res.result || !res.result.transactions) return [];
  return res.result.transactions.filter((tx) => !tx.to || tx.to === "0x0000000000000000000000000000000000000000");
}

async function getContractAddress(txHash) {
  const res = await get(`https://api.etherscan.io/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
  return res.result ? res.result.contractAddress : null;
}

async function getContractBytecode(address) {
  const res = await get(`https://api.etherscan.io/api?module=proxy&action=eth_getCode&address=${address}&tag=latest&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
  return res.result || "0x";
}

async function getContractInfo(address) {
  const res = await get(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${address}&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
  if (res.result && res.result[0]) return { name: res.result[0].ContractName || "Unknown", verified: res.result[0].SourceCode !== "" };
  return { name: "Unknown", verified: false };
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
    if (!lastScannedBlock) { lastScannedBlock = latestBlock - CONFIG.BLOCKS_PER_SCAN; console.log(`🚀 Starting from block ${lastScannedBlock}`); }
    if (latestBlock <= lastScannedBlock) return;
    const fromBlock = lastScannedBlock + 1;
    const toBlock = Math.min(latestBlock, lastScannedBlock + CONFIG.BLOCKS_PER_SCAN);
    console.log(`🔍 Scanning blocks ${fromBlock} → ${toBlock}`);
    for (let block = fromBlock; block <= toBlock; block++) {
      const creations = await getContractCreations(block);
      for (const tx of creations) {
        const contractAddress = await getContractAddress(tx.hash);
        if (!contractAddress || notifiedContracts.has(contractAddress)) continue;
        const bytecode = await getContractBytecode(contractAddress);
        if (!isNFTContract(bytecode)) continue;
        notifiedContracts.add(contractAddress);
        const standard = getNFTStandard(bytecode);
        const info = await getContractInfo(contractAddress);
        const msg = `🎨 <b>New NFT Collection Detected!</b>\n\n📛 <b>Name:</b> ${info.name}\n🔖 <b>Standard:</b> ${standard}\n📦 <b>Block:</b> ${block}\n🔑 <b>Contract:</b> <code>${contractAddress}</code>\n✅ <b>Verified:</b> ${info.verified ? "Yes" : "No"}\n\n🔗 <a href="https://etherscan.io/address/${contractAddress}">Etherscan</a>  |  <a href="https://opensea.io/assets/ethereum/${contractAddress}">OpenSea</a>`;
        console.log(`🎨 NFT Found: ${info.name} (${standard}) - ${contractAddress}`);
        await sendTelegram(msg);
        console.log(`✅ Telegram notification sent`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    lastScannedBlock = toBlock;
  } catch (err) { console.error("⚠️  Scan error:", err.message); }
}

async function start() {
  console.log("━".repeat(50));
  console.log("  🤖 NFT Collection Watcher Bot");
  console.log("━".repeat(50));
  console.log(`  Poll interval : ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Blocks/scan   : ${CONFIG.BLOCKS_PER_SCAN}`);
  console.log(`  Network       : Ethereum Mainnet`);
  console.log("━".repeat(50));
  try {
    await sendTelegram("🤖 <b>NFT Watcher Bot started!</b>\nMonitoring Ethereum for new NFT collections...");
    console.log("✅ Telegram connected successfully");
  } catch (e) {
    console.error("❌ Telegram connection failed:", e.message);
    console.error("   Double-check your BOT_TOKEN and CHAT_ID in Railway Variables");
  }
  await scan();
  setInterval(scan, CONFIG.POLL_INTERVAL_MS);
}

start();
