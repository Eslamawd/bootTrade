const ccxt = require("ccxt").pro;
const fs = require("fs");

require("dotenv").config();

// --- Configuration ---
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const LOG_FILE = "arbitrage_success.txt";

const exchange = new ccxt.binance({
  apiKey: API_KEY,
  secret: SECRET_KEY,
  enableRateLimit: true,
});

const assets = [
  "USDT",
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "XRP",
  "ADA",
  "DOGE",
  "LINK",
  "AVAX",
];
const orderBooks = {};
const INITIAL_BALANCE = 1500;
let lastLoggedRoi = 0; // لمنع تكرار تسجيل نفس الفرصة مية مرة في الثانية

function generatePaths(base) {
  let paths = [];
  for (let a of assets) {
    if (a === base) continue;
    for (let b of assets) {
      if (b === base || b === a) continue;
      paths.push([
        { s: `${a}/${base}`, side: "buy", target: a },
        { s: `${b}/${a}`, side: "buy", target: b },
        { s: `${b}/${base}`, side: "sell", target: base },
      ]);
    }
  }
  return paths;
}

const matrix = generatePaths("USDT");

async function main() {
  console.log("==================================================");
  console.log("🚀 PERMANENT RADAR STARTING ON VPS...");
  console.log(`📝 Success logs will be saved to: ${LOG_FILE}`);
  console.log("==================================================");

  const markets = await exchange.loadMarkets();
  const symbols = [
    ...new Set(matrix.flatMap((p) => p.map((step) => step.s))),
  ].filter((s) => markets[s]);

  symbols.forEach((symbol) => {
    (async () => {
      while (true) {
        try {
          const book = await exchange.watchOrderBook(symbol, 5);
          if (book && book.asks?.[0] && book.bids?.[0]) {
            orderBooks[symbol] = book;
            analyze();
          }
        } catch (e) {
          break;
        }
      }
    })();
  });
}

function analyze() {
  let bestRoi = -999;
  let bestPathStr = "";

  for (let path of matrix) {
    let balance = INITIAL_BALANCE;
    let valid = true;

    for (let step of path) {
      if (
        !orderBooks[step.s] ||
        !orderBooks[step.s].asks[0] ||
        !orderBooks[step.s].bids[0]
      ) {
        valid = false;
        break;
      }
      const book = orderBooks[step.s];
      const price = step.side === "buy" ? book.asks[0][0] : book.bids[0][0];
      balance =
        step.side === "buy"
          ? (balance / price) * 0.999
          : balance * price * 0.999;
    }

    if (valid) {
      let roi = ((balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
      if (roi > bestRoi) {
        bestRoi = roi;
        bestPathStr = `USDT → ${path.map((s) => s.target).join(" → ")}`;
      }
    }
  }

  if (bestRoi > -999) {
    // --- نظام الحفظ في الملف ---
    // بنسجل بس لو الربح حقيقي (أكبر من 0) وفيه تغيير ملحوظ عن آخر تسجيل عشان الملف ميبقاش ضخم
    if (bestRoi > 0 && Math.abs(bestRoi - lastLoggedRoi) > 0.001) {
      const timestamp = new Date().toLocaleString();
      const logEntry = `[${timestamp}] 💰 PROFIT: ${bestRoi.toFixed(
        4
      )}% | Route: ${bestPathStr}\n`;

      fs.appendFileSync(LOG_FILE, logEntry);
      console.log(`\n✅ Saved to Log: ${bestRoi.toFixed(4)}% Profit Found!`);

      lastLoggedRoi = bestRoi; // تحديث لآخر ربح متسجل
    }
  }
}

main().catch(console.error);
