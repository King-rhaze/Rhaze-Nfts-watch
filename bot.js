/**
 * NFT Collection Watcher Bot
 * Polls Etherscan for new ERC-721 / ERC-1155 contract deployments
 * and sends Telegram notifications when new collections are detected.
 *
 * Usage: node bot.js
 */

require('dotenv').config();

const CONFIG = {
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MS: 20000,
  BLOCKS_PER_SCAN: 5,
};
// ───────────────────────────────────────────────────────────────────────────

// Known NFT contract signatures (function selectors in bytecode)
const NFT_SIGNATURES = {
  ERC721: "80ac58cd",   // supportsInterface(ERC721)
  ERC1155: "d9b67a26",  // supportsInterface(ERC1155)
};

let lastScannedBlock = null;
const notifiedContracts = new Set();

// ── HTTP helper ─────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

// ── Telegram ────────────────────────────────────────────────────────────────
function sendTelegram(message) {
  const body = JSON.stringify({
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Etherscan helpers ────────────────────────────────────────────────────────
async function getLatestBlock() {
  const url = `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
  const res = await get(url);
  return parseInt(res.result, 16);
}

async function getContractCreations(fromBlock, toBlock) {
  // Get internal transactions that are contract creations (to = null)
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=0x0000000000000000000000000000000000000000&startblock=${fromBlock}&endblock=${toBlock}&sort=desc&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
  // Instead, scan the block for contract creation transactions
  const blockUrl = `https://api.etherscan.io/api?module=proxy&action=eth_getBlockByNumber&tag=0x${toBlock.toString(16)}&boolean=true&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
  const res = await get(blockUrl);
  if (!res.result || !res.result.transactions) return [];
  // Contract creations have no "to" address
  return res.result.transactions.filter((tx) => !tx.to || tx.to === "0x0000000000000000000000000000000000000000");
}

async function getContractAddress(txHash) {
  const url = `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
  const res = await get(url);
  return res.result ? res.result.contractAddress : null;
}

async function getContractBytecode(address) {
  const url = `https://api.etherscan.io/api?module=proxy&action=eth_getCode&address=${address}&tag=latest&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
  const res = await get(url);
  return res.result || "0x";
}

async function getContractInfo(address) {
  const url = `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${address}&apikey=${CONFIG.ETHERSCAN_API_KEY}`;
  const res = await get(url);
  if (res.result && res.result[0]) {
    return {
      name: res.result[0].ContractName || "Unknown",
      verified: res.result[0].SourceCode !== "",
    };
  }
  return { name: "Unknown", verified: false };
}

function isNFTContract(bytecode) {
  const code = bytecode.toLowerCase();
  return (
    code.includes(NFT_SIGNATURES.ERC721) ||
    code.includes(NFT_SIGNATURES.ERC1155)
  );
}

function getNFTStandard(bytecode) {
  const code = bytecode.toLowerCase();
  const standards = [];
  if (code.includes(NFT_SIGNATURES.ERC721)) standards.push("ERC-721");
  if (code.includes(NFT_SIGNATURES.ERC1155)) standards.push("ERC-1155");
  return standards.join(" + ");
}

// ── Main scan loop ───────────────────────────────────────────────────────────
async function scan() {
  try {
    const latestBlock = await getLatestBlock();

    if (!lastScannedBlock) {
      lastScannedBlock = latestBlock - CONFIG.BLOCKS_PER_SCAN;
      console.log(`🚀 Starting scan from block ${lastScannedBlock}`);
    }

    if (latestBlock <= lastScannedBlock) return;

    const fromBlock = lastScannedBlock + 1;
    const toBlock = Math.min(latestBlock, lastScannedBlock + CONFIG.BLOCKS_PER_SCAN);

    console.log(`🔍 Scanning blocks ${fromBlock} → ${toBlock}`);

    // Scan each block in range
    for (let block = fromBlock; block <= toBlock; block++) {
      const creations = await getContractCreations(fromBlock, block);

      for (const tx of creations) {
        const contractAddress = await getContractAddress(tx.hash);
        if (!contractAddress || notifiedContracts.has(contractAddress)) continue;

        const bytecode = await getContractBytecode(contractAddress);
        if (!isNFTContract(bytecode)) continue;

        notifiedContracts.add(contractAddress);

        const standard = getNFTStandard(bytecode);
        const info = await getContractInfo(contractAddress);

        const shortAddr = contractAddress.slice(0, 6) + "..." + contractAddress.slice(-4);
        const etherscanLink = `https://etherscan.io/address/${contractAddress}`;
        const opensea = `https://opensea.io/assets/ethereum/${contractAddress}`;

        const msg =
          `🎨 <b>New NFT Collection Detected!</b>\n\n` +
          `📛 <b>Name:</b> ${info.name}\n` +
          `🔖 <b>Standard:</b> ${standard}\n` +
          `📦 <b>Block:</b> ${block}\n` +
          `🔑 <b>Contract:</b> <code>${contractAddress}</code>\n` +
          `✅ <b>Verified:</b> ${info.verified ? "Yes" : "No"}\n\n` +
          `🔗 <a href="${etherscanLink}">Etherscan</a>  |  <a href="${opensea}">OpenSea</a>`;

        console.log(`\n🎨 NFT Found: ${info.name || shortAddr} (${standard})`);
        console.log(`   Contract: ${contractAddress}`);
        console.log(`   Block: ${block}`);

        await sendTelegram(msg);
        console.log(`   ✅ Telegram notification sent`);

        // Slight delay to respect rate limits
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    lastScannedBlock = toBlock;
  } catch (err) {
    console.error("⚠️  Scan error:", err.message);
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  console.log("━".repeat(50));
  console.log("  🤖 NFT Collection Watcher Bot");
  console.log("━".repeat(50));
  console.log(`  Poll interval : ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Blocks/scan   : ${CONFIG.BLOCKS_PER_SCAN}`);
  console.log(`  Network       : Ethereum Mainnet`);
  console.log("━".repeat(50) + "\n");

  // Send startup notification
  try {
    await sendTelegram("🤖 <b>NFT Watcher Bot started!</b>\nMonitoring Ethereum for new NFT collections...");
    console.log("✅ Telegram connected successfully\n");
  } catch (e) {
    console.error("❌ Telegram connection failed:", e.message);
    console.error("   Double-check your BOT_TOKEN and CHAT_ID in CONFIG\n");
  }

  // Run immediately then on interval
  await scan();
  setInterval(scan, CONFIG.POLL_INTERVAL_MS);
}

start();
