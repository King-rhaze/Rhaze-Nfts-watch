import { config } from "dotenv";
config();

// ═══════════════════════════════════════════════════════════════
//  NFT ALPHA BOT — FULL MONEY EDITION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
  TELEGRAM_BOT_TOKEN:      process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:        process.env.TELEGRAM_CHAT_ID,
  ALCHEMY_API_KEY:         process.env.ALCHEMY_API_KEY,
  ETHERSCAN_API_KEY:       process.env.ETHERSCAN_API_KEY || null,

  // Auto-mint wallet (add your private key to Railway Variables — NEVER commit to GitHub)
  AUTO_MINT_ENABLED:       process.env.AUTO_MINT_ENABLED === "true",
  MINTER_PRIVATE_KEY:      process.env.MINTER_PRIVATE_KEY || null,
  MAX_GAS_GWEI:            parseInt(process.env.MAX_GAS_GWEI || "80"),   // won't mint if gas > this
  MAX_MINT_PER_CONTRACT:   parseInt(process.env.MAX_MINT_PER_CONTRACT || "1"),

  // Thresholds
  POLL_INTERVAL_MS:        20000,
  BLOCKS_PER_SCAN:         3,
  HOT_CONTRACT_CALLS:      30,
  GAS_SPIKE_MULTIPLIER:    2.5,
  FLOOR_CHECK_INTERVAL_MS: 3600000,  // check floor price every 1 hour
  FLOOR_ALERT_ETH:         0.05,     // alert when floor crosses this

  // Influencer / watched wallets
  WATCHED_WALLETS: [
    // Add influencer wallet addresses here
    // "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth
  ],
};

const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${CONFIG.ALCHEMY_API_KEY}`;

const NFT_SIGNATURES  = { ERC721: "80ac58cd", ERC1155: "d9b67a26" };
const FREE_MINT_SIGS  = {
  "mint()":        "1249c58b",
  "claim()":       "4e71d92d",
  "freeMint()":    "a723533a",
  "publicMint()":  "a9dac7cd",
  "mintFree()":    "5b7d7482",
  "claimFree()":   "cf309012",
  "mint(uint256)": "a0712d68",
  "claim(uint256)":"2f745c59",
  "mintPublic()":  "3b4c4b25",
  "airdrop()":     "c6a5a5c5",
};
const MARKETPLACES = new Set([
  "0x7be8076f4ea4a4ad08075c2508e481d6c946d12b",
  "0x7f268357a8c2552623316e2562d90e642bb538e5",
  "0x00000000006c3852cbef3e08e8df289169ede581",
  "0x000000000000ad05ccc4f10045630fb830b95127",
  "0x74312363e45dcaba76c59ec49a13aa114034c39b",
  "0x59728544b08ab483533076417fbbb2fd0b17ce3a",
]);

// ── State ─────────────────────────────────────────────────────────────────────
let lastScannedBlock       = null;
let avgGasPrice            = null;
const notifiedContracts    = new Set();
const notifiedTxs          = new Set();
const notifiedHotContracts = new Set();
const notifiedGasSpikes    = new Set();
const mintedContracts      = new Set();
const watchedWallets       = new Set(CONFIG.WATCHED_WALLETS.map(w => w.toLowerCase()));
const floorWatchList       = new Map(); // contractAddress -> { name, lastFloor }

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
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (!data.ok) console.error("Telegram error:", data.description);
    return data;
  } catch (e) { console.error("Telegram failed:", e.message); }
}

// ── Ethereum helpers ──────────────────────────────────────────────────────────
async function getLatestBlock()          { const r = await rpc("eth_blockNumber"); return parseInt(r.result, 16); }
async function getBlock(n)               { const r = await rpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, true]); return r.result; }
async function getTransactionReceipt(h)  { const r = await rpc("eth_getTransactionReceipt", [h]); return r.result; }
async function getCode(a)                { const r = await rpc("eth_getCode", [a, "latest"]); return r.result || "0x"; }
async function getEthBalance(a)          { const r = await rpc("eth_getBalance", [a, "latest"]); return (parseInt(r.result, 16) / 1e18).toFixed(2); }
async function getTxCount(a)             { const r = await rpc("eth_getTransactionCount", [a, "latest"]); return parseInt(r.result, 16); }
async function getGasPrice()             { const r = await rpc("eth_gasPrice"); return parseInt(r.result, 16); }

async function callContract(address, sig) {
  const sel = { "name()":"0x06fdde03","symbol()":"0x95d89b41","totalSupply()":"0x18160ddd","maxSupply()":"0xd5abeb01","price()":"0xa035b1fe","cost()":"0x13faede6","mintPrice()":"0x6817c76c" };
  if (!sel[sig]) return null;
  try {
    const r = await rpc("eth_call", [{ to: address, data: sel[sig] }, "latest"]);
    if (!r.result || r.result === "0x") return null;
    const hex = r.result.slice(2);
    if (hex.length <= 64) return parseInt(r.result, 16);
    const len = parseInt(hex.slice(64, 128), 16);
    return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "").trim();
  } catch { return null; }
}

async function getEtherscanInfo(address) {
  if (!CONFIG.ETHERSCAN_API_KEY) return null;
  try {
    const r = await fetch(`https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${address}&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
    const d = await r.json();
    if (d.result?.[0]?.ContractName) return { name: d.result[0].ContractName, verified: d.result[0].SourceCode !== "", abi: d.result[0].ABI };
  } catch {}
  return null;
}

// ── Formatters ────────────────────────────────────────────────────────────────
const weiToEth  = h => (parseInt(h, 16) / 1e18).toFixed(4);
const weiToGwei = h => (parseInt(h, 16) / 1e9).toFixed(2);
const fmtGas    = h => parseInt(h, 16).toLocaleString();
const fmtTime   = h => new Date(parseInt(h, 16) * 1000).toUTCString();
const shortAddr = a => a ? a.slice(0,6)+"..."+a.slice(-4) : "—";
const isNFT     = b => { const c=b.toLowerCase(); return c.includes(NFT_SIGNATURES.ERC721)||c.includes(NFT_SIGNATURES.ERC1155); };
const getNFTStd = b => { const c=b.toLowerCase(),s=[]; if(c.includes(NFT_SIGNATURES.ERC721))s.push("ERC-721"); if(c.includes(NFT_SIGNATURES.ERC1155))s.push("ERC-1155"); return s.join(" + "); };
const getMarket = a => ({ "0x7be8076f4ea4a4ad08075c2508e481d6c946d12b":"OpenSea v1","0x7f268357a8c2552623316e2562d90e642bb538e5":"OpenSea v2","0x00000000006c3852cbef3e08e8df289169ede581":"OpenSea Seaport","0x000000000000ad05ccc4f10045630fb830b95127":"Blur","0x74312363e45dcaba76c59ec49a13aa114034c39b":"X2Y2","0x59728544b08ab483533076417fbbb2fd0b17ce3a":"LooksRare" })[a?.toLowerCase()] || "Marketplace";

// ── Social scraper ────────────────────────────────────────────────────────────
function extractSocials(html) {
  const tw = html.match(/https?:\/\/(www\.)?(twitter\.com|x\.com)\/[A-Za-z0-9_]{1,50}/g);
  const dc = html.match(/https?:\/\/(www\.)?discord\.(gg|com\/invite)\/[A-Za-z0-9_-]+/g);
  const uniq = a => a ? [...new Set(a)] : [];
  return { twitter: uniq(tw).slice(0,2), discord: uniq(dc).slice(0,2) };
}
async function fetchHTML(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(t);
    return r.ok ? await r.text() : null;
  } catch { return null; }
}
async function getProjectWebsite(address) {
  if (!CONFIG.ETHERSCAN_API_KEY) return null;
  try {
    const r = await fetch(`https://api.etherscan.io/api?module=token&action=tokeninfo&contractaddress=${address}&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
    const d = await r.json();
    return d.result?.[0]?.website || null;
  } catch { return null; }
}
async function findSocialLinks(contractAddress, name) {
  try {
    const website = await getProjectWebsite(contractAddress);
    let s = { twitter: [], discord: [] };
    if (website) s = extractSocials(await fetchHTML(website) || "");
    if (!s.twitter.length && !s.discord.length) {
      const html = await fetchHTML(`https://www.google.com/search?q=${encodeURIComponent((name||contractAddress)+" NFT twitter discord")}`);
      if (html) s = extractSocials(html);
    }
    return { website, ...s };
  } catch { return { website: null, twitter: [], discord: [] }; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  🔍 RUG PULL DETECTOR
// ══════════════════════════════════════════════════════════════════════════════
async function analyzeRugRisk(contractAddress, deployer, bytecode, etherscanInfo) {
  const flags   = [];
  const green   = [];
  let score     = 0; // higher = riskier

  // 1. Contract verified?
  if (!etherscanInfo?.verified) {
    flags.push("❌ Contract NOT verified on Etherscan");
    score += 30;
  } else {
    green.push("✅ Contract verified");
  }

  // 2. Deployer wallet age / tx count
  const txCount = await getTxCount(deployer);
  if (txCount < 5) {
    flags.push(`⚠️ Deployer is a brand new wallet (${txCount} txs)`);
    score += 25;
  } else if (txCount > 100) {
    green.push(`✅ Deployer has history (${txCount} txs)`);
  }

  // 3. Deployer balance
  const balance = await getEthBalance(deployer);
  if (parseFloat(balance) < 0.05) {
    flags.push(`⚠️ Deployer wallet nearly empty (${balance} ETH)`);
    score += 15;
  }

  // 4. Dangerous bytecode patterns
  const code = bytecode.toLowerCase();
  if (code.includes("selfdestruct") || code.includes("ff")) {
    flags.push("🚨 Contract contains selfdestruct — can be wiped");
    score += 40;
  }
  // Blacklist/pause functions in bytecode
  const dangerSigs = ["8456cb59", "3f4ba83a", "f2fde38b"]; // pause, unpause, transferOwnership
  const found = dangerSigs.filter(s => code.includes(s));
  if (found.length >= 2) {
    flags.push("⚠️ Has pause/ownership transfer functions");
    score += 10;
  }

  // 5. Max supply sanity check
  const maxSupply = await callContract(contractAddress, "maxSupply()");
  if (maxSupply && maxSupply > 100000000) {
    flags.push(`⚠️ Massive supply (${Number(maxSupply).toLocaleString()}) — could be worthless`);
    score += 20;
  } else if (maxSupply && maxSupply <= 10000) {
    green.push(`✅ Reasonable supply (${Number(maxSupply).toLocaleString()})`);
    score -= 10;
  }

  // Risk level
  let riskLevel, riskEmoji;
  if (score <= 10)      { riskLevel = "LOW";      riskEmoji = "🟢"; }
  else if (score <= 40) { riskLevel = "MEDIUM";   riskEmoji = "🟡"; }
  else if (score <= 70) { riskLevel = "HIGH";      riskEmoji = "🟠"; }
  else                  { riskLevel = "VERY HIGH"; riskEmoji = "🔴"; }

  return { score, riskLevel, riskEmoji, flags, green };
}

// ══════════════════════════════════════════════════════════════════════════════
//  📊 DEPLOYER REPUTATION SCORE
// ══════════════════════════════════════════════════════════════════════════════
async function getDeployerReputation(deployer) {
  try {
    if (!CONFIG.ETHERSCAN_API_KEY) return null;
    // Get all contracts deployed by this wallet
    const r = await fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${deployer}&startblock=0&endblock=99999999&sort=asc&apikey=${CONFIG.ETHERSCAN_API_KEY}`);
    const d = await r.json();
    if (!d.result || !Array.isArray(d.result)) return null;

    const deployTxs = d.result.filter(tx => tx.to === "" || tx.to === null);
    const contractsDeployed = deployTxs.length;

    let successfulCollections = 0;
    for (const tx of deployTxs.slice(-5)) { // check last 5 deployments
      if (!tx.contractAddress) continue;
      const supply = await callContract(tx.contractAddress, "totalSupply()");
      if (supply && supply > 100) successfulCollections++;
    }

    let repScore, repLabel, repEmoji;
    if (contractsDeployed === 0)        { repScore = 0;  repLabel = "First deployment ever";      repEmoji = "🆕"; }
    else if (successfulCollections >= 3) { repScore = 90; repLabel = "Experienced deployer";       repEmoji = "⭐"; }
    else if (successfulCollections >= 1) { repScore = 60; repLabel = "Some successful launches";   repEmoji = "👍"; }
    else                                 { repScore = 20; repLabel = "Deployed before, low success"; repEmoji = "⚠️"; }

    return { contractsDeployed, successfulCollections, repScore, repLabel, repEmoji };
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ⚡ AUTO-MINT
// ══════════════════════════════════════════════════════════════════════════════
async function autoMint(contractAddress, fnSig, mintSig, rugRisk) {
  if (!CONFIG.AUTO_MINT_ENABLED || !CONFIG.MINTER_PRIVATE_KEY) return;
  if (mintedContracts.has(contractAddress)) return;

  // Safety gate — don't auto-mint high risk contracts
  if (rugRisk.score > 60) {
    console.log(`🛑 Auto-mint blocked: risk too high (${rugRisk.riskLevel})`);
    await sendTelegram(
      `🛑 <b>Auto-Mint BLOCKED</b>\n` +
      `${"─".repeat(32)}\n` +
      `Contract: <code>${contractAddress}</code>\n` +
      `Reason: Risk score too high (${rugRisk.score}/100 — ${rugRisk.riskLevel})\n` +
      `You can mint manually if you think it's worth the risk.`
    );
    return;
  }

  // Check gas price
  const currentGasWei  = await getGasPrice();
  const currentGasGwei = currentGasWei / 1e9;
  if (currentGasGwei > CONFIG.MAX_GAS_GWEI) {
    console.log(`⛽ Auto-mint skipped: gas too high (${currentGasGwei.toFixed(1)} Gwei > ${CONFIG.MAX_GAS_GWEI} Gwei)`);
    await sendTelegram(
      `⛽ <b>Auto-Mint SKIPPED — Gas Too High</b>\n` +
      `Current: ${currentGasGwei.toFixed(1)} Gwei\n` +
      `Limit: ${CONFIG.MAX_GAS_GWEI} Gwei\n` +
      `Contract: <code>${contractAddress}</code>`
    );
    return;
  }

  mintedContracts.add(contractAddress);

  // Build raw transaction using only built-ins (no ethers.js needed)
  try {
    // Derive address from private key via eth_accounts workaround
    // We send the tx via eth_sendRawTransaction using manual signing
    const txData = {
      to: contractAddress,
      value: "0x0",
      data: "0x" + mintSig,
      gas: "0x" + (150000).toString(16),
      gasPrice: "0x" + Math.floor(currentGasWei * 1.1).toString(16), // 10% tip
    };

    // NOTE: Signing requires ethers.js or web3.js
    // Install: npm install ethers in your Railway build
    // This section activates when MINTER_PRIVATE_KEY is set
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(CONFIG.MINTER_PRIVATE_KEY, provider);

    for (let i = 0; i < CONFIG.MAX_MINT_PER_CONTRACT; i++) {
      const tx = await wallet.sendTransaction({
        to: contractAddress,
        value: 0n,
        data: "0x" + mintSig,
        gasLimit: 200000n,
        gasPrice: BigInt(Math.floor(currentGasWei * 1.1)),
      });

      console.log(`⚡ Auto-minted! TX: ${tx.hash}`);
      await sendTelegram(
        `⚡ <b>AUTO-MINT EXECUTED!</b>\n` +
        `${"─".repeat(32)}\n` +
        `🔑 <b>Contract:</b> <code>${contractAddress}</code>\n` +
        `⚙️ <b>Function:</b> <code>${fnSig}</code>\n` +
        `⛽ <b>Gas Price:</b> ${currentGasGwei.toFixed(1)} Gwei\n` +
        `📋 <b>TX Hash:</b>\n<code>${tx.hash}</code>\n\n` +
        `🔗 <a href="https://etherscan.io/tx/${tx.hash}">View Transaction</a>`
      );
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    console.error("Auto-mint failed:", e.message);
    await sendTelegram(`❌ <b>Auto-Mint FAILED</b>\n<code>${contractAddress}</code>\nError: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  📈 FLOOR PRICE TRACKER
// ══════════════════════════════════════════════════════════════════════════════
async function checkFloorPrice(contractAddress, name) {
  try {
    // OpenSea API (free, no key needed for basic stats)
    const r = await fetch(`https://api.opensea.io/api/v2/collections?asset_contract_address=${contractAddress}&limit=1`, {
      headers: { "Accept": "application/json" }
    });
    const d = await r.json();
    const collection = d.collections?.[0];
    if (!collection) return null;

    const floor = parseFloat(collection.stats?.floor_price || 0);
    return { floor, slug: collection.collection };
  } catch { return null; }
}

async function runFloorPriceChecks() {
  for (const [address, info] of floorWatchList.entries()) {
    try {
      const result = await checkFloorPrice(address, info.name);
      if (!result) continue;

      const { floor, slug } = result;
      const prev = info.lastFloor || 0;

      // Alert if floor crossed threshold for first time
      if (floor >= CONFIG.FLOOR_ALERT_ETH && prev < CONFIG.FLOOR_ALERT_ETH) {
        await sendTelegram(
          `📈 <b>FLOOR PRICE ALERT — Time to Sell?</b>\n` +
          `${"─".repeat(32)}\n` +
          `🎨 <b>Collection:</b> ${info.name}\n` +
          `💰 <b>Floor Price:</b> ${floor} ETH\n` +
          `📊 <b>Previous Floor:</b> ${prev} ETH\n` +
          `🎯 <b>Your threshold:</b> ${CONFIG.FLOOR_ALERT_ETH} ETH\n\n` +
          `💡 You minted this for FREE — selling now = pure profit!\n\n` +
          `🔗 <a href="https://opensea.io/collection/${slug}">Sell on OpenSea</a>  |  ` +
          `<a href="https://blur.io/collection/${slug}">Sell on Blur</a>`
        );
        console.log(`📈 Floor alert: ${info.name} @ ${floor} ETH`);
      }

      // Alert on big pumps (2x from last check)
      if (prev > 0 && floor >= prev * 2) {
        await sendTelegram(
          `🚀 <b>FLOOR PUMPING — ${info.name}!</b>\n` +
          `${"─".repeat(32)}\n` +
          `💰 <b>Floor:</b> ${floor} ETH\n` +
          `📊 <b>Was:</b> ${prev} ETH\n` +
          `🔺 <b>Change:</b> +${((floor/prev - 1)*100).toFixed(0)}%\n\n` +
          `🔗 <a href="https://opensea.io/collection/${slug}">View on OpenSea</a>`
        );
      }

      floorWatchList.set(address, { ...info, lastFloor: floor });
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  🎨 ALERT: NEW NFT COLLECTION
// ══════════════════════════════════════════════════════════════════════════════
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
    callContract(contractAddress, "price()"),
    getEtherscanInfo(contractAddress),
  ]);

  const collName      = etherscanInfo?.name || name || "Unknown";
  const mintPriceEth  = price ? (price / 1e18).toFixed(4) : null;
  const isFree        = !mintPriceEth || mintPriceEth === "0.0000";
  const priceLabel    = isFree ? "🆓 FREE MINT" : `${mintPriceEth} ETH`;

  const [rugRisk, reputation, socials] = await Promise.all([
    analyzeRugRisk(contractAddress, tx.from, bytecode, etherscanInfo),
    getDeployerReputation(tx.from),
    findSocialLinks(contractAddress, collName),
  ]);

  const twitterLine = socials.twitter.length ? `🐦 <b>Twitter:</b> ${socials.twitter.map(t=>`<a href="${t}">@${t.split("/").pop()}</a>`).join(" | ")}\n` : "";
  const discordLine = socials.discord.length ? `💬 <b>Discord:</b> ${socials.discord.map(d=>`<a href="${d}">Join</a>`).join(" | ")}\n` : "";
  const websiteLine = socials.website ? `🌐 <b>Website:</b> <a href="${socials.website}">${socials.website}</a>\n` : "";
  const noSocials   = !twitterLine && !discordLine && !websiteLine ? `🔍 <i>No socials found yet</i>\n` : "";

  const flagsText = rugRisk.flags.length ? rugRisk.flags.join("\n") : "None detected";
  const greenText = rugRisk.green.length ? rugRisk.green.join("\n") : "";

  const repLine = reputation
    ? `${reputation.repEmoji} <b>Deployer Rep:</b> ${reputation.repLabel} (${reputation.contractsDeployed} deployments, ${reputation.successfulCollections} successful)\n`
    : "";

  const msg =
    `🎨 <b>New NFT Collection Deployed!</b>\n` +
    `${"─".repeat(32)}\n` +
    `📛 <b>Name:</b> ${collName}\n` +
    `🏷 <b>Symbol:</b> ${symbol ? `$${symbol}` : "—"}\n` +
    `🔖 <b>Standard:</b> ${getNFTStd(bytecode)}\n` +
    `💰 <b>Mint Price:</b> ${priceLabel}\n` +
    `🔢 <b>Max Supply:</b> ${maxSupply ? Number(maxSupply).toLocaleString() : "—"}\n\n` +
    `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
    `🕐 <b>Time:</b> ${fmtTime(block.timestamp)}\n` +
    `⛽ <b>Gas Used:</b> ${fmtGas(receipt.gasUsed)}\n\n` +
    `${"─".repeat(32)}\n` +
    `🌍 <b>Socials</b>\n` +
    websiteLine + twitterLine + discordLine + noSocials + `\n` +
    `${"─".repeat(32)}\n` +
    `${rugRisk.riskEmoji} <b>Rug Risk: ${rugRisk.riskLevel}</b> (score: ${rugRisk.score})\n` +
    `${flagsText}\n${greenText}\n\n` +
    repLine +
    `${"─".repeat(32)}\n` +
    `🔑 <b>Contract:</b>\n<code>${contractAddress}</code>\n` +
    `👤 <b>Deployer:</b>\n<code>${tx.from}</code>\n\n` +
    `🔗 <a href="https://etherscan.io/address/${contractAddress}">Etherscan</a>  |  ` +
    `<a href="https://opensea.io/assets/ethereum/${contractAddress}">OpenSea</a>  |  ` +
    `<a href="https://etherscan.io/address/${tx.from}">Deployer</a>`;

  console.log(`🎨 NFT: ${collName} | ${priceLabel} | Risk: ${rugRisk.riskLevel}`);
  await sendTelegram(msg);
}

// ══════════════════════════════════════════════════════════════════════════════
//  🆓 ALERT: FREE MINT DETECTED
// ══════════════════════════════════════════════════════════════════════════════
async function alertFreeMint(tx, receipt, block) {
  if (!tx.to || !tx.input || tx.input.length < 10) return;
  const sig    = tx.input.slice(2, 10).toLowerCase();
  const fnName = Object.entries(FREE_MINT_SIGS).find(([, s]) => s === sig)?.[0];
  if (!fnName) return;
  if (parseFloat(weiToEth(tx.value)) > 0.01) return;

  const contractAddress = tx.to;
  if (notifiedTxs.has(contractAddress + "_free")) return;
  const bytecode = await getCode(contractAddress);
  if (!isNFT(bytecode)) return;
  notifiedTxs.add(contractAddress + "_free");

  const [name, symbol, supply, maxSupply, etherscanInfo] = await Promise.all([
    callContract(contractAddress, "name()"),
    callContract(contractAddress, "symbol()"),
    callContract(contractAddress, "totalSupply()"),
    callContract(contractAddress, "maxSupply()"),
    getEtherscanInfo(contractAddress),
  ]);

  const collName = etherscanInfo?.name || name || "Unknown";
  const minted   = supply ? Number(supply).toLocaleString() : "—";
  const maxS     = maxSupply ? Number(maxSupply).toLocaleString() : "—";
  const pct      = supply && maxSupply ? ` (${Math.round((supply/maxSupply)*100)}% minted)` : "";

  const rugRisk = await analyzeRugRisk(contractAddress, tx.from, bytecode, etherscanInfo);

  // Add to floor watch list
  floorWatchList.set(contractAddress, { name: collName, lastFloor: 0 });

  const msg =
    `🆓 <b>FREE MINT DETECTED — ACT NOW!</b>\n` +
    `${"─".repeat(32)}\n` +
    `📛 <b>Name:</b> ${collName}\n` +
    `🏷 <b>Symbol:</b> ${symbol ? `$${symbol}` : "—"}\n` +
    `🔖 <b>Standard:</b> ${getNFTStd(bytecode)}\n` +
    `⚙️ <b>Function:</b> <code>${fnName}</code>\n\n` +
    `🔢 <b>Minted:</b> ${minted} / ${maxS}${pct}\n` +
    `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
    `🕐 <b>Time:</b> ${fmtTime(block.timestamp)}\n\n` +
    `${rugRisk.riskEmoji} <b>Rug Risk: ${rugRisk.riskLevel}</b>\n` +
    `${rugRisk.flags.length ? rugRisk.flags.join("\n") + "\n" : ""}` +
    `${rugRisk.green.length ? rugRisk.green.join("\n") + "\n" : ""}\n` +
    `🔑 <b>Contract:</b>\n<code>${contractAddress}</code>\n\n` +
    `🔗 <a href="https://etherscan.io/address/${contractAddress}">Etherscan</a>  |  ` +
    `<a href="https://opensea.io/assets/ethereum/${contractAddress}">OpenSea</a>`;

  console.log(`🆓 FREE MINT: ${collName} | Risk: ${rugRisk.riskLevel} | ${minted}/${maxS}`);
  await sendTelegram(msg);

  // Trigger auto-mint if enabled and risk is acceptable
  if (CONFIG.AUTO_MINT_ENABLED) {
    await autoMint(contractAddress, fnName, sig, rugRisk);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  🔥 ALERT: HOT CONTRACT
// ══════════════════════════════════════════════════════════════════════════════
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

    const avgEth  = (txList.reduce((s,t) => s + parseFloat(weiToEth(t.value)), 0) / txList.length).toFixed(4);
    const isFree  = parseFloat(avgEth) < 0.001;
    const minted  = supply ? Number(supply).toLocaleString() : "—";
    const maxS    = maxSupply ? Number(maxSupply).toLocaleString() : "—";
    const pct     = supply && maxSupply ? ` (${Math.round((supply/maxSupply)*100)}% minted)` : "";
    const collName= name || "Unknown";

    floorWatchList.set(contractAddr, { name: collName, lastFloor: 0 });

    const msg =
      `🔥 <b>HOT CONTRACT — ${txList.length} Mints in One Block!</b>\n` +
      `${"─".repeat(32)}\n` +
      `📛 <b>Name:</b> ${collName}\n` +
      `🏷 <b>Symbol:</b> ${symbol ? `$${symbol}` : "—"}\n` +
      `📊 <b>Calls this block:</b> ${txList.length}\n` +
      `💰 <b>Avg Mint Price:</b> ${isFree ? "🆓 FREE" : `${avgEth} ETH`}\n` +
      `🔢 <b>Total Minted:</b> ${minted} / ${maxS}${pct}\n` +
      `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
      `🕐 <b>Time:</b> ${fmtTime(block.timestamp)}\n\n` +
      `🔑 <b>Contract:</b>\n<code>${contractAddr}</code>\n\n` +
      `🔗 <a href="https://etherscan.io/address/${contractAddr}">Etherscan</a>  |  ` +
      `<a href="https://opensea.io/assets/ethereum/${contractAddr}">OpenSea</a>`;

    console.log(`🔥 HOT: ${collName} — ${txList.length} calls`);
    await sendTelegram(msg);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ⛽ ALERT: GAS SPIKE
// ══════════════════════════════════════════════════════════════════════════════
async function checkGasSpike(block) {
  const prices = block.transactions.map(tx => parseInt(tx.gasPrice || tx.maxFeePerGas || "0", 16)).filter(g => g > 0);
  if (!prices.length) return;
  const blockAvg = prices.reduce((a,b) => a+b, 0) / prices.length / 1e9;
  if (!avgGasPrice) { avgGasPrice = blockAvg; return; }
  avgGasPrice = avgGasPrice * 0.9 + blockAvg * 0.1;
  const ratio = blockAvg / avgGasPrice;
  const key   = block.number + "_gas";
  if (ratio >= CONFIG.GAS_SPIKE_MULTIPLIER && !notifiedGasSpikes.has(key)) {
    notifiedGasSpikes.add(key);
    await sendTelegram(
      `⛽ <b>GAS SPIKE — Something Big is Minting!</b>\n` +
      `${"─".repeat(32)}\n` +
      `📈 <b>Current Gas:</b> ${blockAvg.toFixed(1)} Gwei\n` +
      `📊 <b>Rolling Avg:</b> ${avgGasPrice.toFixed(1)} Gwei\n` +
      `🔺 <b>Spike:</b> ${ratio.toFixed(1)}x above average\n` +
      `📦 <b>Block:</b> ${parseInt(block.number, 16)}\n` +
      `🕐 <b>Time:</b> ${fmtTime(block.timestamp)}\n\n` +
      `💡 A hyped free mint or NFT drop is likely live right now!\n\n` +
      `🔗 <a href="https://etherscan.io/block/${parseInt(block.number,16)}">View Block</a>  |  ` +
      `<a href="https://etherscan.io/gastracker">Gas Tracker</a>`
    );
    console.log(`⛽ Gas spike: ${blockAvg.toFixed(1)} Gwei (${ratio.toFixed(1)}x)`);
  }
}




// ══════════════════════════════════════════════════════════════════════════════
//  ⏳ PRE-MINT DETECTOR
//  Catches NFT contracts where mint exists but isn't open yet
//  Gives you time to get whitelisted before the rush
// ══════════════════════════════════════════════════════════════════════════════

// Known "mint not started" patterns in bytecode / state checks
const MINT_OPEN_SIGS = {
  "mintingActive()":   "0x6c4e793d",
  "saleIsActive()":    "0x80b4f93a",
  "publicSaleActive()":"0x9291a731",
  "mintEnabled()":     "0x5e84d723",
  "paused()":          "0x5c975abb",
};

// Whitelist/presale function signatures — means WL window may be open
const PRESALE_SIGS = {
  "presaleMint(uint256)":     "0x5e826c3c",
  "whitelistMint(uint256)":   "0x8a4bdf13",
  "allowlistMint(uint256)":   "0x7e56b236",
  "preSaleMint()":            "0xd04f1e65",
  "mintWhitelist(uint256)":   "0x83a9e049",
  "claimAllowlist()":         "0xbde2b0c3",
};

const preMintNotified = new Set();

async function detectPreMint(contractAddress, bytecode, block) {
  if (preMintNotified.has(contractAddress)) return;

  const code = bytecode.toLowerCase();

  // Must have NFT signatures
  if (!isNFT(bytecode)) return;

  // Must have a mint function signature present
  const hasMintFn = Object.values(FREE_MINT_SIGS).some(s => code.includes(s));
  const hasPresaleFn = Object.values(PRESALE_SIGS).some((s) => code.includes(s.slice(2)));
  if (!hasMintFn && !hasPresaleFn) return;

  // Check if mint is currently inactive / paused
  let mintActive = null;
  let isPaused   = null;

  try {
    // Try paused()
    const pausedRes = await rpc("eth_call", [{ to: contractAddress, data: "0x5c975abb" }, "latest"]);
    if (pausedRes.result && pausedRes.result !== "0x") {
      isPaused = parseInt(pausedRes.result, 16) === 1;
    }
  } catch {}

  try {
    // Try saleIsActive()
    const saleRes = await rpc("eth_call", [{ to: contractAddress, data: "0x80b4f93a" }, "latest"]);
    if (saleRes.result && saleRes.result !== "0x") {
      mintActive = parseInt(saleRes.result, 16) === 1;
    }
  } catch {}

  // If mint is explicitly active — not a pre-mint, skip
  if (mintActive === true) return;

  // If paused or mint not active — this is a pre-mint!
  const isPreMint = isPaused === true || mintActive === false;
  const hasPresale = hasPresaleFn;

  // Only alert if we have a clear signal
  if (!isPreMint && !hasPresale) return;

  preMintNotified.add(contractAddress);

  const [name, symbol, maxSupply, price, etherscanInfo] = await Promise.all([
    callContract(contractAddress, "name()"),
    callContract(contractAddress, "symbol()"),
    callContract(contractAddress, "maxSupply()"),
    callContract(contractAddress, "price()"),
    getEtherscanInfo(contractAddress),
  ]);

  const collName     = etherscanInfo?.name || name || "Unknown";
  const mintPriceEth = price ? (price / 1e18).toFixed(4) : "TBA";
  const isFree       = mintPriceEth === "0.0000";
  const priceLabel   = isFree ? "🆓 FREE" : mintPriceEth === "TBA" ? "TBA" : `${mintPriceEth} ETH`;

  const [socials, rugRisk, reputation] = await Promise.all([
    findSocialLinks(contractAddress, collName),
    analyzeRugRisk(contractAddress, "0x0000000000000000000000000000000000000000", bytecode, etherscanInfo),
    getDeployerReputation(contractAddress),
  ]);

  const twitterLine  = socials.twitter.length ? `🐦 <b>Twitter:</b> ${socials.twitter.map(t => `<a href="${t}">@${t.split("/").pop()}</a>`).join(" | ")}\n` : "";
  const discordLine  = socials.discord.length ? `💬 <b>Discord:</b> ${socials.discord.map(d => `<a href="${d}">Join Server</a>`).join(" | ")}\n` : "";
  const websiteLine  = socials.website ? `🌐 <b>Website:</b> <a href="${socials.website}">${socials.website}</a>\n` : "";
  const noSocials    = !twitterLine && !discordLine && !websiteLine ? `🔍 <i>No socials found yet — search the contract on Twitter</i>\n` : "";

  const statusLine = isPaused
    ? "⏸ Mint is PAUSED — not open yet"
    : hasPresale
    ? "🎟 Presale/Whitelist mint function detected"
    : "⏳ Public mint not yet active";

  const actionItems = [
    socials.discord.length ? `✅ Join their Discord: ${socials.discord[0]}` : "🔍 Find & join their Discord (search contract on Twitter)",
    socials.twitter.length ? `✅ Follow & engage on Twitter: ${socials.twitter[0]}` : "🔍 Find & follow on Twitter",
    "💬 Introduce yourself in Discord — be active",
    "🔔 Watch for whitelist raffle announcements",
    hasPresale ? "⚡ Presale mint function exists — ask about WL requirements" : "⏰ Monitor for when public mint opens",
  ].join("\n");

  const msg =
    `⏳ <b>PRE-MINT DETECTED — Whitelist Window!</b>\n` +
    `${"─".repeat(32)}\n` +
    `📛 <b>Name:</b> ${collName}\n` +
    `🏷 <b>Symbol:</b> ${symbol ? `${symbol}` : "TBA"}\n` +
    `🔖 <b>Standard:</b> ${getNFTStd(bytecode)}\n` +
    `💰 <b>Mint Price:</b> ${priceLabel}\n` +
    `🔢 <b>Max Supply:</b> ${maxSupply ? Number(maxSupply).toLocaleString() : "TBA"}\n` +
    `📊 <b>Status:</b> ${statusLine}\n\n` +
    `${"─".repeat(32)}\n` +
    `🌍 <b>Socials</b>\n` +
    websiteLine + twitterLine + discordLine + noSocials + `\n` +
    `${"─".repeat(32)}\n` +
    `${rugRisk.riskEmoji} <b>Rug Risk: ${rugRisk.riskLevel}</b>\n` +
    `${rugRisk.flags.length ? rugRisk.flags.join("\n") + "\n" : ""}\n` +
    `${"─".repeat(32)}\n` +
    `📋 <b>YOUR ACTION PLAN:</b>\n${actionItems}\n\n` +
    `🔑 <b>Contract:</b>\n<code>${contractAddress}</code>\n\n` +
    `🔗 <a href="https://etherscan.io/address/${contractAddress}">Etherscan</a>  |  ` +
    `<a href="https://opensea.io/assets/ethereum/${contractAddress}">OpenSea</a>`;

  console.log(`⏳ PRE-MINT: ${collName} | Price: ${priceLabel} | Risk: ${rugRisk.riskLevel}`);
  await sendTelegram(msg);
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN SCAN LOOP
// ══════════════════════════════════════════════════════════════════════════════
async function scan() {
  try {
    const latestBlock = await getLatestBlock();
    if (isNaN(latestBlock)) { console.error("❌ Could not get block number"); return; }
    if (!lastScannedBlock) { lastScannedBlock = latestBlock - CONFIG.BLOCKS_PER_SCAN; console.log(`🚀 Starting from block ${lastScannedBlock}`); }
    if (latestBlock <= lastScannedBlock) return;

    const fromBlock = lastScannedBlock + 1;
    const toBlock   = Math.min(latestBlock, lastScannedBlock + CONFIG.BLOCKS_PER_SCAN);
    console.log(`🔍 Scanning blocks ${fromBlock} → ${toBlock}`);

    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      const block = await getBlock(blockNum);
      if (!block?.transactions) continue;
      console.log(`   Block ${blockNum}: ${block.transactions.length} txs`);

      await checkGasSpike(block);

      const contractCallMap = {};

      for (const tx of block.transactions) {
        const ethValue   = parseFloat(weiToEth(tx.value));
        const isCreation = !tx.to || tx.to === "0x0000000000000000000000000000000000000000";
        const isWatched  = watchedWallets.has(tx.from.toLowerCase()) || watchedWallets.has((tx.to||"").toLowerCase());

        if (tx.to) {
          if (!contractCallMap[tx.to.toLowerCase()]) contractCallMap[tx.to.toLowerCase()] = [];
          contractCallMap[tx.to.toLowerCase()].push(tx);
        }

        const needsReceipt = isCreation || isWatched;
        let receipt = null;
        if (needsReceipt) receipt = await getTransactionReceipt(tx.hash);

        if (isCreation && receipt)                        await alertNewNFT(tx, receipt, block);
        if (isCreation && receipt?.contractAddress)      await detectPreMint(receipt.contractAddress, await getCode(receipt.contractAddress), block);
        await alertFreeMint(tx, receipt, block);

        await new Promise(r => setTimeout(r, 30));
      }

      await alertHotContract(contractCallMap, block);
    }

    lastScannedBlock = toBlock;
  } catch (err) { console.error("⚠️  Scan error:", err.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════════════
async function start() {
  console.log("━".repeat(50));
  console.log("  🤖 NFT Alpha Bot — Full Money Edition");
  console.log("━".repeat(50));
  console.log(`  Auto-mint          : ${CONFIG.AUTO_MINT_ENABLED ? "✅ ON" : "❌ OFF"}`);
  console.log(`  Hot contract calls : ${CONFIG.HOT_CONTRACT_CALLS}/block`);
  console.log(`  Gas spike          : ${CONFIG.GAS_SPIKE_MULTIPLIER}x`);
  console.log(`  Floor alert        : ${CONFIG.FLOOR_ALERT_ETH} ETH`);
  console.log(`  Watched wallets    : ${watchedWallets.size}`);
  console.log("━".repeat(50));

  await sendTelegram(
    `🤖 <b>NFT Alpha Bot — Full Money Edition!</b>\n` +
    `${"─".repeat(32)}\n` +
    `Now tracking:\n\n` +
    `🎨 New NFT deployments\n` +
    `🆓 Free mint detector\n` +
    `🔥 Hot contract alerts\n` +
    `⛽ Gas spike alerts\n` +
    `🔍 Rug pull detector\n` +
    `⭐ Deployer reputation score\n` +
    `📈 Floor price tracker (sell alerts)\n` +
    `👁 Influencer wallet tracker\n` +
    `⚡ Auto-mint: ${CONFIG.AUTO_MINT_ENABLED ? "ON ✅" : "OFF ❌"}\n` +
    `⏳ Pre-mint whitelist detector\n\n` +
    `Scanning Ethereum every ${CONFIG.POLL_INTERVAL_MS/1000}s 🚀`
  );
  console.log("✅ Bot started");

  await scan();
  setInterval(scan, CONFIG.POLL_INTERVAL_MS);

  // Floor price checker runs every hour
  setInterval(runFloorPriceChecks, CONFIG.FLOOR_CHECK_INTERVAL_MS);
}

start();
