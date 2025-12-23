const ccxt = require("ccxt");
const fs = require("fs");
require("dotenv").config();

// --- الإعدادات الذكية المعدلة ---
const LOG_FILE = "arbitrage_radar.txt";
const WHALE_LOG = "whale_alerts.txt";
const FINAL_REPORT = "final_whale_report.csv";
const SMART_TRADES_LOG = "smart_trades.csv";
const INITIAL_BALANCE = 100;
const MIN_DISPLAY_ROI = 0.001;
const SNIPE_ROI_THRESHOLD = 0.015; // 0.005% حد الدخول مع الحوت
const TRACKING_TIME = 2 * 60 * 1000;

const exchange = new ccxt.pro.binance({
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
const activeTrades = new Map(); // تتبع الصفقات النشطة
const whaleData = new Map();
let tradeCounter = 0;

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

// --- 1. رادار الحيتان المحسن ---
function detectWhales(symbol, book) {
  if (!book.bids || book.bids.length < 10) return null;

  let totalVolume = 0;
  for (let i = 0; i < 10; i++) {
    totalVolume += book.bids[i][0] * book.bids[i][1];
  }

  const averageOrder = totalVolume / 10;
  const bestBid = book.bids[0];
  const wallValue = bestBid[0] * bestBid[1];
  const wallPower = wallValue / averageOrder;

  if (wallPower > 5 || wallValue > 100000) {
    if (whaleWatchlist.has(symbol)) {
      return whaleData.get(symbol);
    }

    const whaleInfo = {
      symbol: symbol,
      entryPrice: bestBid[0],
      wallValue: wallValue,
      wallPower: wallPower,
      side: "bid",
      timestamp: Date.now(),
      isActive: true,
    };

    whaleWatchlist.set(symbol, true);
    whaleData.set(symbol, whaleInfo);

    const startMsg = `[${new Date().toLocaleTimeString()}] 🐋 WHALE DETECTED: ${symbol} | Wall: $${(
      wallValue / 1000
    ).toFixed(1)}K | Power: ${wallPower.toFixed(1)}x`;
    fs.appendFileSync(WHALE_LOG, startMsg + "\n");
    console.log(`\n🚨 ${startMsg}`);

    // تتبع تأثير الحوت
    setTimeout(() => {
      if (orderBooks[symbol] && orderBooks[symbol].bids[0]) {
        const exitPrice = orderBooks[symbol].bids[0][0];
        const priceChange =
          ((exitPrice - whaleInfo.entryPrice) / whaleInfo.entryPrice) * 100;

        const resultMsg = `[${new Date().toLocaleTimeString()}] 📊 WHALE IMPACT: ${symbol} | Change: ${priceChange.toFixed(
          3
        )}% | Result: ${priceChange > 0 ? "🟢 PROFIT" : "🔴 LOSS"}`;
        fs.appendFileSync(WHALE_LOG, resultMsg + "\n");

        // تسجيل في التقرير النهائي
        const reportEntry = `${new Date().toISOString()},${symbol},${
          whaleInfo.entryPrice
        },${exitPrice},${priceChange.toFixed(4)},${whaleInfo.wallValue.toFixed(
          2
        )},${whaleInfo.wallPower.toFixed(2)},${
          priceChange > 0 ? "PROFIT" : "LOSS"
        }\n`;
        if (!fs.existsSync(FINAL_REPORT)) {
          fs.writeFileSync(
            FINAL_REPORT,
            "Timestamp,Symbol,EntryPrice,ExitPrice,Change%,WallValue($),WallPower,Result\n"
          );
        }
        fs.appendFileSync(FINAL_REPORT, reportEntry);
      }
      whaleWatchlist.delete(symbol);
      whaleData.delete(symbol);
    }, TRACKING_TIME);

    return whaleInfo;
  }

  return null;
}

// --- 2. نظام التنفيذ التلقائي ---
function executeTrade(path, roi, profitUsd, whaleInfo) {
  tradeCounter++;
  const tradeId = `TRADE_${tradeCounter}_${Date.now()}`;
  const routeStr = path.map((s) => s.target).join("->");

  const trade = {
    id: tradeId,
    route: routeStr,
    entryTime: Date.now(),
    entryPrice: whaleInfo.entryPrice,
    expectedProfit: profitUsd,
    expectedROI: roi,
    whaleSymbol: whaleInfo.symbol,
    whaleWall: whaleInfo.wallValue,
    status: "ACTIVE",
    exitPrice: null,
    actualProfit: null,
    actualROI: null,
    exitReason: null,
  };

  activeTrades.set(tradeId, trade);

  console.log(`\n🎯 TRADE EXECUTED #${tradeCounter}`);
  console.log(`   ID: ${tradeId}`);
  console.log(`   Route: ${routeStr}`);
  console.log(`   Entry: $${whaleInfo.entryPrice}`);
  console.log(`   Expected: $${profitUsd.toFixed(4)} (${roi.toFixed(3)}% ROI)`);
  console.log(
    `   Whale: ${whaleInfo.symbol} ($${(whaleInfo.wallValue / 1000).toFixed(
      1
    )}K wall)`
  );

  // مراقبة الصفقة
  const monitorTrade = setInterval(() => {
    const currentBook = orderBooks[whaleInfo.symbol];
    if (!currentBook || !currentBook.bids[0]) return;

    const currentPrice = currentBook.bids[0][0];
    const priceChange =
      ((currentPrice - whaleInfo.entryPrice) / whaleInfo.entryPrice) * 100;

    // شروط الخروج
    const whaleStillThere = whaleWatchlist.has(whaleInfo.symbol);
    const targetHit = priceChange >= 0.03;
    const stopLoss = priceChange <= -0.02;
    const timeExit = Date.now() - trade.entryTime > 5 * 60 * 1000; // 5 دقائق كحد أقصى

    let exitReason = "";
    let shouldExit = false;

    if (!whaleStillThere) {
      exitReason = "WHALE_LEFT";
      shouldExit = true;
    } else if (targetHit) {
      exitReason = "TARGET_HIT";
      shouldExit = true;
    } else if (stopLoss) {
      exitReason = "STOP_LOSS";
      shouldExit = true;
    } else if (timeExit) {
      exitReason = "TIME_EXIT";
      shouldExit = true;
    }

    if (shouldExit) {
      clearInterval(monitorTrade);

      trade.exitPrice = currentPrice;
      trade.actualProfit = (INITIAL_BALANCE * priceChange) / 100;
      trade.actualROI = priceChange;
      trade.exitReason = exitReason;
      trade.status = "CLOSED";
      trade.exitTime = Date.now();
      trade.duration = (trade.exitTime - trade.entryTime) / 1000;

      console.log(`\n📊 TRADE CLOSED #${tradeCounter}`);
      console.log(`   Reason: ${exitReason}`);
      console.log(`   Exit Price: $${currentPrice}`);
      console.log(
        `   Actual P/L: ${priceChange.toFixed(
          3
        )}% | $${trade.actualProfit.toFixed(4)}`
      );
      console.log(`   Duration: ${trade.duration.toFixed(1)} seconds`);
      console.log(`   ${priceChange > 0 ? "🟢 PROFIT!" : "🔴 LOSS"}`);

      // تسجيل الصفقة
      const tradeRecord = `${new Date().toISOString()},${tradeId},${routeStr},${
        whaleInfo.symbol
      },${trade.entryPrice},${currentPrice},${trade.expectedROI.toFixed(
        4
      )},${trade.actualROI.toFixed(4)},${trade.expectedProfit.toFixed(
        4
      )},${trade.actualProfit.toFixed(
        4
      )},${exitReason},${trade.duration.toFixed(1)}\n`;

      if (!fs.existsSync(SMART_TRADES_LOG)) {
        fs.writeFileSync(
          SMART_TRADES_LOG,
          "Timestamp,TradeID,Route,WhaleSymbol,EntryPrice,ExitPrice,ExpectedROI%,ActualROI%,ExpectedProfit$,ActualProfit$,ExitReason,Duration(s)\n"
        );
      }
      fs.appendFileSync(SMART_TRADES_LOG, tradeRecord);

      activeTrades.delete(tradeId);

      // تسجيل ملخص سريع
      const summary = `[${new Date().toLocaleTimeString()}] TRADE ${tradeCounter}: ${
        priceChange > 0 ? "🟢 WON" : "🔴 LOST"
      } ${Math.abs(priceChange).toFixed(3)}% | $${Math.abs(
        trade.actualProfit
      ).toFixed(2)} | ${routeStr} | Reason: ${exitReason}\n`;
      fs.appendFileSync(LOG_FILE, summary);
    }

    // تحديث حالة الصفقة النشطة
    trade.currentPrice = currentPrice;
    trade.currentPL = priceChange;
  }, 1000); // فحص كل ثانية
}

// --- 3. المحلل الرئيسي مع التنفيذ الفعلي ---
function analyze() {
  let opportunities = [];
  let bestOpportunity = null;

  for (let path of matrix) {
    let balance = INITIAL_BALANCE;
    let valid = true;
    let whaleInPath = null;

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

      // التحقق من وجود حوت في هذا الزوج
      const whaleInfo = whaleData.get(step.s);
      if (whaleInfo && whaleInfo.isActive) {
        whaleInPath = whaleInfo;
      }
    }

    if (valid) {
      let roi = ((balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
      let profitUsd = balance - INITIAL_BALANCE;
      const routeStr = path.map((s) => s.target).join("->");

      // الفرصة المثالية: حوت + ربح جيد
      if (whaleInPath && roi >= SNIPE_ROI_THRESHOLD) {
        const opportunity = {
          path: path,
          routeStr: routeStr,
          roi: roi,
          profitUsd: profitUsd,
          whaleInfo: whaleInPath,
          timestamp: Date.now(),
        };

        opportunities.push(opportunity);

        // اختيار أفضل فرصة
        if (!bestOpportunity || roi > bestOpportunity.roi) {
          bestOpportunity = opportunity;
        }
      }

      // عرض جميع الفرص المؤهلة
      if (roi > MIN_DISPLAY_ROI) {
        opportunities.push({
          path: path,
          routeStr: routeStr,
          roi: roi,
          profitUsd: profitUsd,
          whaleInfo: whaleInPath,
          hasWhale: !!whaleInPath,
        });
      }
    }
  }

  // تنفيذ أفضل صفقة
  if (bestOpportunity && !isTradeActiveForRoute(bestOpportunity.routeStr)) {
    executeTrade(
      bestOpportunity.path,
      bestOpportunity.roi,
      bestOpportunity.profitUsd,
      bestOpportunity.whaleInfo
    );
  }

  // عرض النتائج
  displayDashboard(opportunities);
}

function isTradeActiveForRoute(routeStr) {
  for (let trade of activeTrades.values()) {
    if (trade.route === routeStr) return true;
  }
  return false;
}

function displayDashboard(opportunities) {
  process.stdout.write("\x1Bc");

  console.log(
    `╔══════════════════════════════════════════════════════════════════════╗`
  );
  console.log(
    `║ 🎯 WHALE SNIPER - LIVE TRADING | ${new Date().toLocaleTimeString()}           ║`
  );
  console.log(
    `║ 💰 Balance: $${INITIAL_BALANCE} | 📊 Trades: ${tradeCounter} | 🐋 Whales: ${whaleWatchlist.size} ║`
  );
  console.log(
    `╚══════════════════════════════════════════════════════════════════════╝`
  );

  // عرض الصفقات النشطة
  if (activeTrades.size > 0) {
    console.log(`\n📊 ACTIVE TRADES (${activeTrades.size}):`);
    console.log(
      `┌─────┬──────────────────────┬────────────┬──────────┬──────────┬──────────┐`
    );
    console.log(
      `│ #   │ Route                │ Whale      │ Entry    │ Current  │ P/L %    │`
    );
    console.log(
      `├─────┼──────────────────────┼────────────┼──────────┼──────────┼──────────┤`
    );

    let index = 1;
    activeTrades.forEach((trade) => {
      const currentPrice = trade.currentPrice || trade.entryPrice;
      const plPercent = trade.currentPL || 0;
      const routeDisplay =
        trade.route.length > 20
          ? trade.route.substring(0, 17) + "..."
          : trade.route.padEnd(20);

      console.log(
        `│ ${index
          .toString()
          .padStart(3)} │ ${routeDisplay} │ ${trade.whaleSymbol.padEnd(
          10
        )} │ ${trade.entryPrice.toFixed(2).padStart(8)} │ ${currentPrice
          .toFixed(2)
          .padStart(8)} │ ${plPercent.toFixed(3).padStart(7)}% │`
      );
      index++;
    });
    console.log(
      `└─────┴──────────────────────┴────────────┴──────────┴──────────┴──────────┘\n`
    );
  }

  // عرض أفضل الفرص
  const qualifiedOpportunities = opportunities
    .filter((op) => op.hasWhale || op.roi > MIN_DISPLAY_ROI)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, 8);

  if (qualifiedOpportunities.length > 0) {
    console.log(
      `🎯 TOP OPPORTUNITIES (Whale + ROI ≥ ${SNIPE_ROI_THRESHOLD}%):`
    );
    console.log(
      `┌─────┬──────────┬──────────┬─────────┬────────────────────────────────┐`
    );
    console.log(
      `│ Rank│   ROI %  │ Profit $ │ Whale   │ Path                          │`
    );
    console.log(
      `├─────┼──────────┼──────────┼─────────┼────────────────────────────────┤`
    );

    qualifiedOpportunities.forEach((op, idx) => {
      const whaleTag = op.whaleInfo ? "🐋 YES" : "❌ NO";
      const roiStr = `${op.roi.toFixed(3)}%`.padStart(8);
      const profitStr = `$${op.profitUsd.toFixed(4)}`.padStart(9);
      const routeStr =
        op.routeStr.length > 30
          ? op.routeStr.substring(0, 27) + "..."
          : op.routeStr.padEnd(30);
      const status = isTradeActiveForRoute(op.routeStr)
        ? "🔵 TRADING"
        : "🟡 READY";

      console.log(
        `│ ${(idx + 1)
          .toString()
          .padStart(3)} │ ${roiStr} │ ${profitStr} │ ${whaleTag.padEnd(
          7
        )} │ ${routeStr} │`
      );
    });
    console.log(
      `└─────┴──────────┴──────────┴─────────┴────────────────────────────────┘`
    );
  } else {
    console.log(
      `\n⏳ Scanning for opportunities... (Need: Whale + ≥${SNIPE_ROI_THRESHOLD}% ROI)`
    );
  }

  console.log(
    `\n📈 Stats: ${whaleWatchlist.size} active whales | ${activeTrades.size} active trades | ${tradeCounter} total trades`
  );
  console.log(
    `⚡ Auto-execution: ${SNIPE_ROI_THRESHOLD}% ROI threshold with whale support`
  );
}

// --- الدالة الرئيسية ---
async function main() {
  console.log("🚀 WHALE SNIPER TRADING BOT - AUTO EXECUTION ENABLED");
  console.log("🔥 Starting with $100 virtual balance");
  console.log(
    `🎯 Will auto-trade when: ROI ≥ ${SNIPE_ROI_THRESHOLD}% + Whale detected\n`
  );

  try {
    const markets = await exchange.loadMarkets();
    const symbols = [
      ...new Set(matrix.flatMap((p) => p.map((s) => s.s))),
    ].filter((s) => markets[s]);

    console.log(`✅ Tracking ${symbols.length} trading pairs`);
    console.log("📡 Live market data started...\n");

    // مراقبة جميع الأزواج
    for (const symbol of symbols) {
      (async () => {
        while (true) {
          try {
            const book = await exchange.watchOrderBook(symbol, 20);
            orderBooks[symbol] = book;
            detectWhales(symbol, book);
            analyze();
          } catch (e) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      })();
    }
  } catch (error) {
    console.error("❌ Startup failed:", error.message);
    console.log("\n🔧 Quick fix:");
    console.log(
      "1. Create .env file with BINANCE_API_KEY and BINANCE_SECRET_KEY"
    );
    console.log("2. npm install ccxt@latest");
    console.log("3. Ensure internet connection");
  }
}

// بدء البوت
main().catch(console.error);
