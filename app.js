const ccxt = require("ccxt").pro;
const fs = require("fs");
require("dotenv").config();

// --- الإعدادات الذكية ---
const LOG_FILE = "arbitrage_radar.txt";
const EVAL_FILE = "trade_evaluation.csv";
const WHALE_LOG = "whale_alerts.txt";
const INITIAL_BALANCE = 100;
const MIN_DISPLAY_ROI = 0.002; // الحد الأدنى لعرض الصفقة (عشان الهدوء)
const TRACKING_TIME = 3 * 60 * 1000; // تم التعديل لـ 1 دقيقة بناءً على طلبك

const exchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
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
  "DOT",
  "MATIC",
  "LTC",
  "SHIB",
  "TRX",
  "NEAR",
  "OP",
  "ARB",
  "INJ",
  "TIA",
  "ORDI",
  "PEPE",
  "RNDR",
  "SUI",
  "APT",
  "STX",
  "KAS",
  "FET",
  "IMX",
  "TAO",
];
const orderBooks = {};
const whaleWatchlist = new Map();
let activeTrackers = new Set();
let lastLoggedRoi = 0;

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

// --- 1. رادار الحيتان الديناميكي ---
function detectWhales(symbol, book) {
  if (!book.bids || book.bids.length < 10) return false;
  let totalVolume = 0;
  for (let i = 0; i < 10; i++) totalVolume += book.bids[i][0] * book.bids[i][1];
  const averageOrder = totalVolume / 10;
  const bestBid = book.bids[0];
  const wallValue = bestBid[0] * bestBid[1];

  if (wallValue > averageOrder * 6 || wallValue > 500000) {
    if (whaleWatchlist.has(symbol)) return false;
    const entryPrice = bestBid[0];
    whaleWatchlist.set(symbol, true);

    const startMsg = `[${new Date().toLocaleTimeString()}] 🐋 WHALE: ${symbol} | Wall: $${(
      wallValue / 1000
    ).toFixed(1)}K | Power: ${(wallValue / averageOrder).toFixed(
      1
    )}x | Price: ${entryPrice}`;
    fs.appendFileSync(WHALE_LOG, startMsg + "\n");

    setTimeout(async () => {
      try {
        const currentBook = orderBooks[symbol];
        if (currentBook && currentBook.bids[0]) {
          const exitPrice = currentBook.bids[0][0];
          const priceChange = ((exitPrice - entryPrice) / entryPrice) * 100;
          const resultMsg = `[${new Date().toLocaleTimeString()}] 📊 IMPACT (10m): ${symbol} | Change: ${priceChange.toFixed(
            3
          )}% | Price: ${exitPrice}\n`;
          fs.appendFileSync(WHALE_LOG, resultMsg);
        }
      } finally {
        whaleWatchlist.delete(symbol);
      }
    }, TRACKING_TIME);
    return true;
  }
  return false;
}

// --- 2. نظام تقييم الفرص ---
function trackOpportunity(route, entryRoi) {
  const routeKey = route.map((s) => s.s).join("|");
  if (activeTrackers.has(routeKey)) return;
  activeTrackers.add(routeKey);

  setTimeout(async () => {
    let balance = INITIAL_BALANCE;
    let valid = true;
    for (let step of route) {
      const book = orderBooks[step.s];
      if (!book || !book.asks[0]) {
        valid = false;
        break;
      }
      const price = step.side === "buy" ? book.asks[0][0] : book.bids[0][0];
      balance =
        step.side === "buy"
          ? (balance / price) * 0.999
          : balance * price * 0.999;
    }
    if (valid) {
      const finalRoi = ((balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
      const status = finalRoi > entryRoi ? "📈 GAINED" : "📉 DROPPED";
      const logEntry = `${new Date().toLocaleTimeString()}, ${routeKey}, Entry: ${entryRoi.toFixed(
        4
      )}%, Final: ${finalRoi.toFixed(4)}%, ${status}\n`;
      if (!fs.existsSync(EVAL_FILE))
        fs.writeFileSync(
          EVAL_FILE,
          "Time, Route, Entry ROI, Final ROI, Status\n"
        );
      fs.appendFileSync(EVAL_FILE, logEntry);
    }
    activeTrackers.delete(routeKey);
  }, TRACKING_TIME);
}

// --- 3. المحلل الرئيسي المعدل ---
function analyze() {
  let qualityPaths = [];

  for (let path of matrix) {
    let balance = INITIAL_BALANCE;
    let valid = true;

    for (let step of path) {
      const book = orderBooks[step.s];
      if (!book || !book.asks[0] || !book.bids[0]) {
        valid = false;
        break;
      }
      const price = step.side === "buy" ? book.asks[0][0] : book.bids[0][0];
      balance =
        step.side === "buy"
          ? (balance / price) * 0.999
          : balance * price * 0.999;
    }

    if (valid) {
      let roi = ((balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
      let profitUsd = balance - INITIAL_BALANCE;

      if (roi > MIN_DISPLAY_ROI) {
        let hasWhale = path.some((step) => whaleWatchlist.has(step.s));
        qualityPaths.push({
          roi: roi,
          profitUsd: profitUsd,
          path: path,
          routeStr: path.map((s) => s.target).join(" -> "),
          isGolden: hasWhale && roi > 0.01,
        });
      }
    }
  }

  qualityPaths.sort((a, b) => b.roi - a.roi);

  process.stdout.write("\x1B[2J\x1B[0;0H");
  console.log(
    `====================================================================`
  );
  console.log(
    `🎯 QUALITY SCANNER | ${new Date().toLocaleTimeString()} | Bal: $${INITIAL_BALANCE}`
  );
  console.log(
    `====================================================================`
  );

  if (qualityPaths.length === 0) {
    console.log("\n   Waiting for profitable opportunities... ⏳\n");
  } else {
    console.log(` Rank |   ROI %   | Profit $ | Status   | Path Schedule`);
    console.log(
      `--------------------------------------------------------------------`
    );
    qualityPaths.slice(0, 12).forEach((item, index) => {
      const tag = item.isGolden ? "🔥 GOLD " : "✅ OK   ";
      const roiStr = item.roi.toFixed(3).padStart(7, " ");
      const prfStr = item.profitUsd.toFixed(2).padStart(6, " ");
      console.log(
        ` [#${(index + 1)
          .toString()
          .padEnd(2)}] | ${roiStr}% | $${prfStr}  | ${tag} | ${item.routeStr}`
      );
    });
  }

  if (qualityPaths.length > 0 && qualityPaths[0].roi > 0.02) {
    const best = qualityPaths[0];
    if (Math.abs(best.roi - lastLoggedRoi) > 0.005) {
      fs.appendFileSync(
        LOG_FILE,
        `[${new Date().toLocaleString()}] ROI: ${best.roi.toFixed(
          4
        )}% | $${best.profitUsd.toFixed(2)} | ${best.routeStr}\n`
      );
      trackOpportunity(best.path, best.roi);
      lastLoggedRoi = best.roi;
    }
  }
}

async function main() {
  const markets = await exchange.loadMarkets();
  const symbols = [...new Set(matrix.flatMap((p) => p.map((s) => s.s)))].filter(
    (s) => markets[s]
  );
  symbols.forEach((symbol) => {
    (async () => {
      while (true) {
        try {
          const book = await exchange.watchOrderBook(symbol, 20);
          orderBooks[symbol] = book;
          detectWhales(symbol, book);
          analyze();
        } catch (e) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  });
}
main().catch(console.error);
