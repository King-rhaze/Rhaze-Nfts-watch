import { config } from "dotenv";

config();

const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY || null,
  POLL_INTERVAL_MS: 20000,
  BLOCKS_PER_SCAN: 3,

  // ── Whale thresholds ──────────────────────────────────────────────────────
  WHALE_ETH_THRESHOLD: 100,
  WHALE_NFT_ETH_THRESHOLD: 10,

  // ── Free mint thresholds ──────────────────────────────────────────────────
  HOT_CONTRACT_CALLS: 30,       // calls to same contract in one block = hot
  GAS_SPIKE_MULTIPLIER: 2.5,    // gas price X times above average = spike alert

  // ── Watched wallets ───────────────────────────────────────────────────────
  WATCHED_WALLETS: [
    // "0xYourWalletAddress",
  ],
};

const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${CONFIG.ALCHEMY_API_KEY}`;

const NFT_SIGNATURES = { ERC721: "80ac58cd", ERC1155: "d9b67a26" };

// Free mint function signatures
const FREE_MINT_SIGS = {
  "mint()":            "1249c58b",
  "claim()":           "4e71d92d",
  "freeMint()":        "a723533a",
  "publicMint()":      "a9dac7cd",
  "mintFree()":        "5b7d7482",
  "claimFree()":       "cf309012",
  "mint(uint256)":     "a0712d68",
  "claim(uint256)":    "2f745c59",
  "mintPublic()":      "3b4c4b25",
  "airdrop()":         "c6a5a5c5",
};

// NFT marketplace addresses
const MARKETPLACES = new Set([
  "0x7be8076f4ea4a4ad08075c2508e481d6c946d12b",
  "0x7f268357a8c2552623316e2562d90e642bb538e5",
  "0x00000000006c3852cbef3e08e8df289169ede581",
  "0x000000000000ad05ccc4f10045630fb830b95127",
  "0x74312363e45dcaba76c59ec49a13aa114034c39b",
  "0x59728544b08ab483533076417fbbb2fd0b17ce3a",
]);

let lastScannedBlock  = null;
let avgGasPrice       = null;
const notifiedContracts   = new Set();
const notifiedTxs         = new Set();
const notifiedHotContracts= new Set();
const notifiedGasSpikes   = new Set();
const watchedWallets      = new Set(CONFIG.WATCHED_WALLETS.map(w => w.toLowerCase()));

// ── RPC ───────────────────────────────────────────────────────────────────────
async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  return res.json();
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) console.error("Telegram error:", data.description);
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getLatestBlock() {
  const res = await rpc("eth_blockNumber");
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

async function getEthBalance(address) {
  const res = await rpc("eth_getBalance", [address, "latest"]);
  return (parseInt(res.result, 16) / 1e18).toFixed(2);
}

async function callContract(address, funcSig) {
  const selectors = {
    "name()":        "0x06fdde03",
    "symbol()":      "0x95d89b41",
    "totalSupply()": "0x18160ddd",
    "maxSupply()":   "0xd5abeb01",
    "price()":       "0xa035b1fe",
    "cost()":        "0x13faede6",
    "mintPrice()":   "0x6817c76c",
  };
  const data = selectors[funcSig];
  if (!data) return null;
  try {
    const res = await rpc("eth_call", [{ to: address, data }, "latest"]);
    if (!res.result || res.result === "0x") return null;
    const hex = res.result.slice(2);
    if (hex.length <= 64) return parseInt(res.result, 16);
    const len = parseInt(hex.slice(64, 128), 16);
    const str = hex.slice(128, 128 + len * 2);
    return Buffer.from(str, "hex").toString("utf8").replace(/\0/g, "").trim();
  } catch { return null; }
}

async function getEtherscanInfo(address) {
  if (!CONFIG.ETHERSCAN_API_KEY) return null;
  try {
    const res = await fetch(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${address}&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
    const data = await res.json();
    if (data.result?.[0]?.ContractName) {
      return { name: data.result[0].ContractName, verified: data.result[0].SourceCode !== "" };
    }
  } catch {}
  return null;
}


// ── Social link scrapers ──────────────────────────────────────────────────────
function extractSocialLinks(html) {
  const twitter = html.match(/https?:\/\/(www\.)?(twitter\.com|x\.com)\/[A-Za-z0-9_]{1,50}/g);
  const discord = html.match(/https?:\/\/(www\.)?discord\.(gg|com\/invite)\/[A-Za-z0-9_-]+/g);
  const unique  = arr => arr ? [...new Set(arr)] : [];
  return { twitter: unique(twitter).slice(0, 2), discord: unique(discord).slice(0, 2) };
}

async function fetchHTML(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; NFTBot/1.0)" } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function getSocialsFromWebsite(website) {
  if (!website) return { twitter: [], discord: [] };
  const html = await fetchHTML(website);
  if (!html) return { twitter: [], discord: [] };
  return extractSocialLinks(html);
}

async function getSocialsFromGoogle(contractAddress, collectionName) {
  const query = encodeURIComponent((collectionName || contractAddress) + " NFT twitter discord");
  const html  = await fetchHTML("https://www.google.com/search?q=" + query);
  if (!html) return { twitter: [], discord: [] };
  return extractSocialLinks(html);
}

async function getProjectWebsite(address) {
  if (!CONFIG.ETHERSCAN_API_KEY) return null;
  try {
    const res  = await fetch("https://api.etherscan.io/api?module=token&action=tokeninfo&contractaddress=" + address + "&apikey=" + CONFIG.ETHERSCAN_API_KEY);
    const data = await res.json();
    return data.result?.[0]?.website || null;
  } catch { return null; }
}

async function findSocialLinks(contractAddress, collectionName) {
  try {
    const website = await getProjectWebsite(contractAddress);
    let socials = { twitter: [], discord: [] };
    if (website) socials = await getSocialsFromWebsite(website);
    if (socials.twitter.length === 0 && socials.discord.length === 0) {
      socials = await getSocialsFromGoogle(contractAddress, collectionName);
    }
    return { website, ...socials };
  } catch { return { website: null, twitter: [], discord: [] }; }
}

function weiToEth(hex)       { return (parseInt(hex, 16) / 1e18).toFixed(4); }
function weiToGwei(hex)      { return (parseInt(hex, 16) / 1e9).toFixed(2); }
function formatGas(hex)      { return parseInt(hex, 16).toLocaleString(); }
function formatTimestamp(hex){ return new Date(parseInt(hex, 16) * 1000).toUTCString(); }
function shortAddr(addr)     { return addr ? addr.slice(0, 6) + "..." + addr.slice(-4) : "—"; }
function isNFT(b)            { const c = b.toLowerCase(); return c.includes(NFT_SIGNATURES.ERC721) || c.includes(NFT_SIGNATURES.ERC1155); }
function getNFTStd(b)        { const c = b.toLowerCase(); const s = []; if (c.includes(NFT_SIGNATURES.ERC721)) s.push("ERC-721"); if (c.includes(NFT_SIGNATURES.ERC1155)) s.push("ERC-1155"); return s.join(" + "); }
function getMarketName(addr) {
  const m = {
    "0x7be8076f4ea4a4ad08075c2508e481d6c946d12b": "OpenSea v1",
    "0x7f268357a8c2552623316e2562d90e642bb538e5": "OpenSea v2",
    "0x00000000006c3852cbef3e08e8df289169ede581": "OpenSea Seaport",
    "0x000000000000ad05ccc4f10045630fb830b95127": "Blur",
    "0x74312363e45dcaba76c59ec49a13aa114034c39b": "X2Y2",
    "0x59728544b08ab483533076417fbbb2fd0b17ce3a": "LooksRare",
  };
  return m[addr?.toLowerCase()] || "Marketplace";
}

// ── ALERT 1: New NFT Collection ───────────────────────────────────────────────
async function alertNewNFT(tx, receipt, block) {
  const contractAddress = receipt?.contractAddress;
  if (!contractAddress || notifiedContracts.has(contractAddress)) return;
  const bytecode = await getCode(contractAddress);
  if (!isNFT(bytecode)) return;
  notifiedContracts.add(contractAddress);

  const [name, symbol, supply, maxSupply, price, etherscanInfo] = await Promise.all([
    callContract(contractAddress, "name()"),
    callContract(contractAddress, "symbol()"),
    callContract(contractAddress, "totalSupply()"),
    callContract(contractAddress, "maxSupply()"),
    callContract(contractAddress, "price()") || callContract(contractAddress, "cost()") || callContract(contractAddress, "mintPrice()"),
    getEtherscanInfo(contractAddress),
  ]);
  const collNameTemp = etherscanInfo?.name || name || "Unknown";
  const socials = await findSocialLinks(contractAddress, collNameTemp);

  const mintPriceEth = price ? (price / 1e18).toFixed(4) : null;
  const isFree = mintPriceEth === "0.0000" || mintPriceEth === null;
  const priceLabel = isFree ? "🆓 FREE MINT" : `${mintPriceEth} ETH`;
  const collName = etherscanInfo?.name || name || "Unknown";

  // Build social links section
  const twitterLine = socials.twitter.length > 0
    ? `🐦 <b>Twitter:</b> ${socials.twitter.map(t => `<a href="${t}">${t.split("/").pop()}</a>`).join("  |  ")}\n`
    : "";
  const discordLine = socials.discord.length > 0
    ? `💬 <b>Discord:</b> ${socials.discord.map(d => `<a href="${d}">Join Server</a>`).join("  |  ")}\n`
    : "";
  const websiteLine = socials.website ? `🌐 <b>Website:</b> <a href="${socials.website}">${socials.website}</a>\n` : "";
  const noSocials = !twitterLine && !discordLine && !websiteLine ? `🔍 <i>No social links found yet</i>\n` : "";

  const msg =
    `🎨 <b>New NFT Collection Deployed!</b>\n` +
    `${"─".repeat(32)}\n` +
    `📛 <b>Name:</b> ${collName}\n` +
    `🏷 <b>Symbol:</b> ${symbol ? `${symbol}` : "—"}\n` +
    `🔖 <b>Standard:</b> ${getNFTStd(bytecode)}\n` +
    `📋 <b>Verified:</b> ${etherscanInfo?.verified ? "✅ Yes" : "❌ No"}\n` +
    `💰 <b>Mint Price:</b> ${priceLabel}\n` +
    `🔢 <b>Max Supply:</b> ${maxSupply ? Number(maxSupply).toLocaleString() : "—"}\n\n` +
    `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
    `🕐 <b>Time:</b> ${formatTimestamp(block.timestamp)}\n` +
    `⛽ <b>Gas Used:</b> ${formatGas(receipt.gasUsed)}\n\n` +
    `🔑 <b>Contract:</b>\n<code>${contractAddress}</code>\n` +
    `👤 <b>Deployer:</b>\n<code>${tx.from}</code>\n\n` +
    `${"─".repeat(32)}\n` +
    `🌍 <b>Socials</b>\n` +
    websiteLine + twitterLine + discordLine + noSocials +
    `\n🔗 <a href="https://etherscan.io/address/${contractAddress}">Etherscan</a>  |  ` +
    `<a href="https://opensea.io/assets/ethereum/${contractAddress}">OpenSea</a>  |  ` +
    `<a href="https://etherscan.io/address/${tx.from}">Deployer</a>`;

  console.log(`🎨 NFT: ${collName} | Price: ${priceLabel}`);
  await sendTelegram(msg);
}

// ── ALERT 2: Whale ETH Transfer ───────────────────────────────────────────────
async function alertWhaleETH(tx, block) {
  if (notifiedTxs.has(tx.hash + "_eth")) return;
  const ethValue = parseFloat(weiToEth(tx.value));
  const isWatched = watchedWallets.has(tx.from.toLowerCase()) || watchedWallets.has((tx.to || "").toLowerCase());
  if (!isWatched && ethValue < CONFIG.WHALE_ETH_THRESHOLD) return;
  notifiedTxs.add(tx.hash + "_eth");

  const [fromBal, toBal] = await Promise.all([
    getEthBalance(tx.from),
    tx.to ? getEthBalance(tx.to) : Promise.resolve("0"),
  ]);

  const tag = isWatched ? "👁 <b>Watched Wallet Activity</b>" : "🐋 <b>Whale ETH Transfer</b>";

  const msg =
    `${tag}\n` +
    `${"─".repeat(32)}\n` +
    `💸 <b>Amount:</b> ${ethValue} ETH\n` +
    `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
    `🕐 <b>Time:</b> ${formatTimestamp(block.timestamp)}\n\n` +
    `📤 <b>From:</b> <code>${tx.from}</code>\n` +
    `   💰 Balance: ${fromBal} ETH\n` +
    `📥 <b>To:</b> <code>${tx.to || "Contract"}</code>\n` +
    `   💰 Balance: ${toBal} ETH\n\n` +
    `🔗 <a href="https://etherscan.io/tx/${tx.hash}">Transaction</a>  |  ` +
    `<a href="https://etherscan.io/address/${tx.from}">Sender Wallet</a>`;

  console.log(`🐋 Whale ETH: ${ethValue} ETH from ${shortAddr(tx.from)}`);
  await sendTelegram(msg);
}

// ── ALERT 3: Whale NFT Purchase ───────────────────────────────────────────────
async function alertWhaleNFT(tx, receipt, block) {
  if (notifiedTxs.has(tx.hash + "_nft")) return;
  if (!tx.to || !MARKETPLACES.has(tx.to.toLowerCase())) return;
  const ethValue = parseFloat(weiToEth(tx.value));
  const isWatched = watchedWallets.has(tx.from.toLowerCase());
  if (!isWatched && ethValue < CONFIG.WHALE_NFT_ETH_THRESHOLD) return;
  notifiedTxs.add(tx.hash + "_nft");

  let nftContract = null;
  if (receipt?.logs?.length > 0) {
    const transferLog = receipt.logs.find(l => l.topics?.[0]?.startsWith("0xddf252ad"));
    if (transferLog) nftContract = transferLog.address;
  }

  const [name, symbol] = nftContract
    ? await Promise.all([callContract(nftContract, "name()"), callContract(nftContract, "symbol()")])
    : [null, null];

  const tag = isWatched ? "👁 <b>Watched Wallet NFT Buy</b>" : "🐋 <b>Whale NFT Purchase</b>";

  const msg =
    `${tag}\n` +
    `${"─".repeat(32)}\n` +
    `🎨 <b>Collection:</b> ${name || "Unknown"}${symbol ? ` ($${symbol})` : ""}\n` +
    `💸 <b>Price:</b> ${ethValue} ETH\n` +
    `🏪 <b>Marketplace:</b> ${getMarketName(tx.to)}\n` +
    `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
    `🕐 <b>Time:</b> ${formatTimestamp(block.timestamp)}\n\n` +
    `👤 <b>Buyer:</b>\n<code>${tx.from}</code>\n` +
    `${nftContract ? `🔑 <b>Contract:</b>\n<code>${nftContract}</code>\n` : ""}` +
    `\n🔗 <a href="https://etherscan.io/tx/${tx.hash}">Transaction</a>  |  ` +
    `${nftContract ? `<a href="https://opensea.io/assets/ethereum/${nftContract}">OpenSea</a>  |  ` : ""}` +
    `<a href="https://etherscan.io/address/${tx.from}">Buyer Wallet</a>`;

  console.log(`🐋 Whale NFT: ${ethValue} ETH on ${getMarketName(tx.to)}`);
  await sendTelegram(msg);
}

// ── ALERT 4: Free Mint Detector ───────────────────────────────────────────────
async function alertFreeMint(tx, receipt, block) {
  if (!tx.to || !tx.input || tx.input.length < 10) return;
  const sig = tx.input.slice(2, 10).toLowerCase();
  const fnName = Object.entries(FREE_MINT_SIGS).find(([, s]) => s === sig)?.[0];
  if (!fnName) return;

  const ethValue = parseFloat(weiToEth(tx.value));
  if (ethValue > 0.01) return; // not free if they're paying

  const contractAddress = tx.to;
  if (notifiedTxs.has(contractAddress + "_free")) return;

  const bytecode = await getCode(contractAddress);
  if (!isNFT(bytecode)) return;
  notifiedTxs.add(contractAddress + "_free");

  const [name, symbol, supply, maxSupply] = await Promise.all([
    callContract(contractAddress, "name()"),
    callContract(contractAddress, "symbol()"),
    callContract(contractAddress, "totalSupply()"),
    callContract(contractAddress, "maxSupply()"),
  ]);

  const minted  = supply ? Number(supply).toLocaleString() : "—";
  const maxS    = maxSupply ? Number(maxSupply).toLocaleString() : "—";
  const pct     = supply && maxSupply ? ` (${Math.round((supply / maxSupply) * 100)}% minted)` : "";

  const msg =
    `🆓 <b>FREE MINT DETECTED — ACT NOW!</b>\n` +
    `${"─".repeat(32)}\n` +
    `📛 <b>Name:</b> ${name || "Unknown"}\n` +
    `🏷 <b>Symbol:</b> ${symbol ? `$${symbol}` : "—"}\n` +
    `🔖 <b>Standard:</b> ${getNFTStd(bytecode)}\n` +
    `⚙️ <b>Mint Function:</b> <code>${fnName}</code>\n\n` +
    `🔢 <b>Minted:</b> ${minted} / ${maxS}${pct}\n` +
    `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
    `🕐 <b>Time:</b> ${formatTimestamp(block.timestamp)}\n\n` +
    `🔑 <b>Contract:</b>\n<code>${contractAddress}</code>\n\n` +
    `🔗 <a href="https://etherscan.io/address/${contractAddress}">Etherscan</a>  |  ` +
    `<a href="https://opensea.io/assets/ethereum/${contractAddress}">OpenSea</a>`;

  console.log(`🆓 FREE MINT: ${name || contractAddress} | ${minted}/${maxS}`);
  await sendTelegram(msg);
}

// ── ALERT 5: Hot Contract (surge of calls in one block) ───────────────────────
async function alertHotContract(contractCallMap, block) {
  for (const [contractAddr, txList] of Object.entries(contractCallMap)) {
    if (txList.length < CONFIG.HOT_CONTRACT_CALLS) continue;
    if (notifiedHotContracts.has(contractAddr + block.number)) continue;

    const bytecode = await getCode(contractAddr);
    if (!isNFT(bytecode)) continue;
    notifiedHotContracts.add(contractAddr + block.number);

    const [name, symbol, supply, maxSupply] = await Promise.all([
      callContract(contractAddr, "name()"),
      callContract(contractAddr, "symbol()"),
      callContract(contractAddr, "totalSupply()"),
      callContract(contractAddr, "maxSupply()"),
    ]);

    const avgEth = (txList.reduce((s, t) => s + parseFloat(weiToEth(t.value)), 0) / txList.length).toFixed(4);
    const minted = supply ? Number(supply).toLocaleString() : "—";
    const maxS   = maxSupply ? Number(maxSupply).toLocaleString() : "—";
    const pct    = supply && maxSupply ? ` (${Math.round((supply / maxSupply) * 100)}% minted)` : "";
    const isFree = parseFloat(avgEth) < 0.001;

    const msg =
      `🔥 <b>HOT CONTRACT — ${txList.length} Mints in One Block!</b>\n` +
      `${"─".repeat(32)}\n` +
      `📛 <b>Name:</b> ${name || "Unknown"}\n` +
      `🏷 <b>Symbol:</b> ${symbol ? `$${symbol}` : "—"}\n` +
      `📊 <b>Calls this block:</b> ${txList.length}\n` +
      `💰 <b>Avg Mint Price:</b> ${isFree ? "🆓 FREE" : `${avgEth} ETH`}\n` +
      `🔢 <b>Total Minted:</b> ${minted} / ${maxS}${pct}\n` +
      `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
      `🕐 <b>Time:</b> ${formatTimestamp(block.timestamp)}\n\n` +
      `🔑 <b>Contract:</b>\n<code>${contractAddr}</code>\n\n` +
      `🔗 <a href="https://etherscan.io/address/${contractAddr}">Etherscan</a>  |  ` +
      `<a href="https://opensea.io/assets/ethereum/${contractAddr}">OpenSea</a>`;

    console.log(`🔥 HOT: ${name || contractAddr} — ${txList.length} calls in block ${parseInt(block.number, 16)}`);
    await sendTelegram(msg);
  }
}

// ── ALERT 6: Gas Spike ────────────────────────────────────────────────────────
async function checkGasSpike(block) {
  const blockGasPrices = block.transactions
    .map(tx => parseInt(tx.gasPrice || tx.maxFeePerGas || "0", 16))
    .filter(g => g > 0);

  if (blockGasPrices.length === 0) return;

  const blockAvgGwei = blockGasPrices.reduce((a, b) => a + b, 0) / blockGasPrices.length / 1e9;

  if (!avgGasPrice) { avgGasPrice = blockAvgGwei; return; }

  // Rolling average
  avgGasPrice = avgGasPrice * 0.9 + blockAvgGwei * 0.1;

  const ratio = blockAvgGwei / avgGasPrice;
  const blockKey = block.number + "_gas";

  if (ratio >= CONFIG.GAS_SPIKE_MULTIPLIER && !notifiedGasSpikes.has(blockKey)) {
    notifiedGasSpikes.add(blockKey);

    const msg =
      `⛽ <b>GAS SPIKE DETECTED — Something Big is Minting!</b>\n` +
      `${"─".repeat(32)}\n` +
      `📈 <b>Current Gas:</b> ${blockAvgGwei.toFixed(1)} Gwei\n` +
      `📊 <b>Rolling Avg:</b> ${avgGasPrice.toFixed(1)} Gwei\n` +
      `🔺 <b>Spike:</b> ${ratio.toFixed(1)}x above average\n` +
      `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
      `🕐 <b>Time:</b> ${formatTimestamp(block.timestamp)}\n\n` +
      `💡 <b>Tip:</b> A gas spike often means a hyped free mint or NFT drop is happening right now. Check what's hot!\n\n` +
      `🔗 <a href="https://etherscan.io/block/${parseInt(block.number, 16)}">View Block</a>  |  ` +
      `<a href="https://etherscan.io/gastracker">Gas Tracker</a>`;

    console.log(`⛽ Gas Spike! ${blockAvgGwei.toFixed(1)} Gwei (${ratio.toFixed(1)}x avg)`);
    await sendTelegram(msg);
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────
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
    const toBlock   = Math.min(latestBlock, lastScannedBlock + CONFIG.BLOCKS_PER_SCAN);
    console.log(`🔍 Scanning blocks ${fromBlock} → ${toBlock}`);

    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      const block = await getBlock(blockNum);
      if (!block?.transactions) continue;

      console.log(`   Block ${blockNum}: ${block.transactions.length} txs`);

      // Gas spike check
      await checkGasSpike(block);

      // Build contract call frequency map for hot contract detection
      const contractCallMap = {};

      for (const tx of block.transactions) {
        const ethValue  = parseFloat(weiToEth(tx.value));
        const isCreation= !tx.to || tx.to === "0x0000000000000000000000000000000000000000";
        const isWatched = watchedWallets.has(tx.from.toLowerCase()) || watchedWallets.has((tx.to || "").toLowerCase());
        const isMarket  = tx.to && MARKETPLACES.has(tx.to.toLowerCase());

        // Track contract call frequency
        if (tx.to) {
          if (!contractCallMap[tx.to.toLowerCase()]) contractCallMap[tx.to.toLowerCase()] = [];
          contractCallMap[tx.to.toLowerCase()].push(tx);
        }

        const needsReceipt = isCreation || isMarket || isWatched;
        let receipt = null;
        if (needsReceipt) receipt = await getTransactionReceipt(tx.hash);

        // 1. New NFT collection
        if (isCreation && receipt) await alertNewNFT(tx, receipt, block);

        // 2. Whale ETH
        if (ethValue >= CONFIG.WHALE_ETH_THRESHOLD || (isWatched && ethValue > 0)) {
          await alertWhaleETH(tx, block);
        }

        // 3. Whale NFT buy
        if (isMarket && receipt) await alertWhaleNFT(tx, receipt, block);

        // 4. Free mint
        await alertFreeMint(tx, receipt, block);

        await new Promise(r => setTimeout(r, 30));
      }

      // 5. Hot contract (after processing full block)
      await alertHotContract(contractCallMap, block);
    }

    lastScannedBlock = toBlock;
  } catch (err) {
    console.error("⚠️  Scan error:", err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log("━".repeat(50));
  console.log("  🤖 NFT Alpha Bot — Full Edition");
  console.log("━".repeat(50));
  console.log(`  Whale ETH threshold  : ${CONFIG.WHALE_ETH_THRESHOLD} ETH`);
  console.log(`  Whale NFT threshold  : ${CONFIG.WHALE_NFT_ETH_THRESHOLD} ETH`);
  console.log(`  Hot contract trigger : ${CONFIG.HOT_CONTRACT_CALLS} calls/block`);
  console.log(`  Gas spike multiplier : ${CONFIG.GAS_SPIKE_MULTIPLIER}x`);
  console.log(`  Watched wallets      : ${watchedWallets.size}`);
  console.log(`  Poll interval        : ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
  console.log("━".repeat(50));

  try {
    await sendTelegram(
      `🤖 <b>NFT Alpha Bot — Full Edition Started!</b>\n` +
      `${"─".repeat(32)}\n` +
      `Now monitoring:\n\n` +
      `🎨 New NFT deployments (with mint price)\n` +
      `🆓 Free mint detector\n` +
      `🔥 Hot contract alerts (${CONFIG.HOT_CONTRACT_CALLS}+ calls/block)\n` +
      `⛽ Gas spike alerts (${CONFIG.GAS_SPIKE_MULTIPLIER}x above avg)\n` +
      `🐋 Whale ETH transfers (≥${CONFIG.WHALE_ETH_THRESHOLD} ETH)\n` +
      `🐋 Whale NFT buys (≥${CONFIG.WHALE_NFT_ETH_THRESHOLD} ETH)\n` +
      `👁 Watched wallet activity\n\n` +
      `Scanning Ethereum every ${CONFIG.POLL_INTERVAL_MS / 1000}s 🚀`
    );
    console.log("✅ Telegram connected");
  } catch (e) {
    console.error("❌ Telegram failed:", e.message);
  }

  await scan();
  setInterval(scan, CONFIG.POLL_INTERVAL_MS);
}

start();
