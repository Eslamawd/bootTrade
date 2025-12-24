const ccxt = require("ccxt");
const WebSocket = require("ws");
const fs = require("fs");
require("dotenv").config();

const CONFIG = {
  MIN_NET_PROFIT: 0.003, // تفعيل التريلينج عند 0.3% ربح صافي
  MAX_NET_LOSS: -0.007, // ستوب لوز أوسع قليلاً (0.7%) لإعطاء مساحة للارتداد
  SYMBOLS: [
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "BNB/USDT",
    "XRP/USDT",
    "ADA/USDT",
    "AVAX/USDT",
    "DOGE/USDT",
    "DOT/USDT",
    "LINK/USDT",
    "MATIC/USDT",
    "LTC/USDT",
    "NEAR/USDT",
    "OP/USDT",
    "ARB/USDT",
    "INJ/USDT",
    "TIA/USDT",
    "ORDI/USDT",
    "SUI/USDT",
    "RNDR/USDT",
  ],
  DYNAMIC_WHALES: {},
  MAX_CONCURRENT_TRADES: 20, // تقليل العدد لاختيار "صفوة" الفرص
  UPDATE_INTERVAL: 1000,
  MAX_MONITOR_TIME: 86400000, // الصبر لمدة 24 ساعة بدلاً من 50 دقيقة
};

class RevenueMultiTradeBot {
  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
    });
    this.orderBooks = {};
    this.activeTrades = [];
    this.performance = { trades: 0, wins: 0, losses: 0, netProfit: 0 };
    this.logFile = "revenue_multi_log.csv";
    this.initLogs();
    console.log(
      "💰 RevenueMultiTradeBot - نظام الصبر الاستراتيجي (No Timeout)"
    );
  }

  initLogs() {
    if (!fs.existsSync(this.logFile)) {
      const headers =
        "Timestamp,Symbol,Entry,Exit,NetPnl%,NetPnl$,WhaleSize,Reason,Duration\n";
      fs.writeFileSync(this.logFile, headers);
    }
  }

  async updateDynamicWhaleSizes() {
    console.log("🔄 جاري معايرة الرادار للحيتان...");
    for (const symbol of CONFIG.SYMBOLS) {
      try {
        const orderBook = await this.exchange.fetchOrderBook(symbol, 20);
        const totalDepth =
          orderBook.bids?.reduce((sum, [p, s]) => sum + p * s, 0) || 0;
        const avgOrder = totalDepth / 20;
        // نرفع المعيار ليكون الحوت أضخم (avg * 2)
        CONFIG.DYNAMIC_WHALES[symbol] = Math.max(
          8000,
          Math.min(avgOrder * 2, 100000)
        );
      } catch (e) {
        CONFIG.DYNAMIC_WHALES[symbol] = 30000;
      }
    }
  }

  analyzeForEntry(symbol, orderBook) {
    if (!orderBook || !orderBook.bids?.length) return null;
    if (this.activeTrades.some((t) => t.symbol === symbol)) return null;

    const minWhale = (CONFIG.DYNAMIC_WHALES[symbol] || 50000) * 0.5;
    const whale = this.findRealWhale(orderBook, minWhale);

    if (whale) {
      const entryPrice = orderBook.asks[0][0];
      const whalePower = whale.value / minWhale;
      let dynamicTP = 0.003;
      if (whalePower > 2) dynamicTP = 0.005;

      const spread =
        (orderBook.asks[0][0] - orderBook.bids[0][0]) / orderBook.bids[0][0];
      const isNear = Math.abs(whale.price - entryPrice) / entryPrice < 0.0015;

      if (spread < 0.0012 && isNear) {
        return {
          symbol,
          entryPrice,
          whaleSize: whale.value,
          stopLoss: entryPrice * (1 + CONFIG.MAX_NET_LOSS),
          takeProfit: entryPrice * (1 + dynamicTP + 0.002),
        };
      }
    }
    return null;
  }

  findRealWhale(orderBook, minSize) {
    let pool = orderBook.bids.slice(0, 15);
    let bestWhale = null;
    for (const [p, s] of pool) {
      const val = p * s;
      if (val > minSize && (!bestWhale || val > bestWhale.value)) {
        bestWhale = { price: p, value: val };
      }
    }
    return bestWhale;
  }

  async executeTrade(opp) {
    if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) return;
    const tradeSize = 250;
    const trade = {
      id: `T_${Date.now()}`,
      symbol: opp.symbol,
      entryPrice: opp.entryPrice,
      entryTime: Date.now(),
      size: tradeSize,
      whaleSize: opp.whaleSize,
      stopLoss: opp.stopLoss,
      takeProfit: opp.takeProfit,
      status: "ACTIVE",
      fees: tradeSize * 0.002,
    };

    fs.appendFileSync(
      this.logFile,
      `${new Date().toISOString()},${trade.symbol},${
        trade.entryPrice
      },WAITING,0%,0,${trade.whaleSize},ENTRY_OPEN,0\n`
    );

    this.activeTrades.push(trade);
    this.startSmartMonitoring(trade);
  }

  startSmartMonitoring(trade) {
    trade.highestNetPnl = -0.002;
    trade.dynamicStopLoss = trade.stopLoss;

    const interval = setInterval(() => {
      const ob = this.orderBooks[trade.symbol];
      if (!ob || trade.status !== "ACTIVE") return clearInterval(interval);

      const curPrice = ob.bids[0][0];
      const netPnl =
        (curPrice - trade.entryPrice) / trade.entryPrice -
        trade.fees / trade.size;

      if (netPnl > trade.highestNetPnl) {
        trade.highestNetPnl = netPnl;
        // تأمين عند الوصول لنقطة التعادل
        if (netPnl >= 0.0005 && trade.dynamicStopLoss < trade.entryPrice) {
          trade.dynamicStopLoss = trade.entryPrice;
        }
        // تأمين ربح بسيط عند الصعود
        if (netPnl >= 0.003) {
          const lockedPrice = trade.entryPrice * 1.001;
          if (trade.dynamicStopLoss < lockedPrice)
            trade.dynamicStopLoss = lockedPrice;
        }
      }

      let shouldExit = false;
      let reason = "";
      const targetPnl = trade.takeProfit / trade.entryPrice - 1 - 0.002;

      // الخروج بالربح (تريلينج)
      if (netPnl >= targetPnl && trade.highestNetPnl - netPnl > 0.0005) {
        shouldExit = true;
        reason = "TRAILING_PROFIT";
      }
      // الخروج بالستوب لوز (الحماية النهائية)
      else if (curPrice <= trade.dynamicStopLoss) {
        shouldExit = true;
        reason =
          trade.dynamicStopLoss >= trade.entryPrice
            ? "DYNAMIC_SL_PROFIT"
            : "STOP_LOSS";
      }
      // خروج اضطراري بعد 24 ساعة فقط
      else if (Date.now() - trade.entryTime > CONFIG.MAX_MONITOR_TIME) {
        shouldExit = true;
        reason = "LONG_TERM_FORCE_CLOSE";
      }

      if (shouldExit) {
        trade.status = "CLOSED";
        this.closeTrade(trade, curPrice, netPnl, reason);
        clearInterval(interval);
      }
    }, 1000);
  }

  async closeTrade(trade, price, pnl, reason) {
    this.performance.trades++;
    this.performance.netProfit += pnl * trade.size;
    if (pnl > 0) this.performance.wins++;
    else this.performance.losses++;
    const duration = (Date.now() - trade.entryTime) / 1000;
    fs.appendFileSync(
      this.logFile,
      `${new Date().toISOString()},${trade.symbol},${
        trade.entryPrice
      },${price},${(pnl * 100).toFixed(3)}%,${(pnl * trade.size).toFixed(3)},${
        trade.whaleSize
      },${reason},${duration}\n`
    );
    this.activeTrades = this.activeTrades.filter((t) => t.id !== trade.id);
  }

  displayDashboard() {
    console.clear();
    const winRate =
      this.performance.trades > 0
        ? ((this.performance.wins / this.performance.trades) * 100).toFixed(1)
        : "0.0";
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(
      `║ 💰 RevenueBot | PnL: $${this.performance.netProfit.toFixed(
        3
      )} | Wins: ${winRate}% ║`
    );
    console.log(`╠══════════════════════════════════════════════════════╣`);
    this.activeTrades.forEach((t) => {
      const cur = this.orderBooks[t.symbol]?.bids[0][0] || t.entryPrice;
      const netPnlPercent = (
        ((cur - t.entryPrice) / t.entryPrice) * 100 -
        0.2
      ).toFixed(2);
      console.log(
        `║ 🚀 ${t.symbol.padEnd(9)} | Net: ${netPnlPercent.padStart(
          5
        )}% | Time: ${Math.floor((Date.now() - t.entryTime) / 60000)}m ║`
      );
    });
    if (this.activeTrades.length === 0)
      console.log(`║          ⏳ جاري البحث عن فرص ذهبية...               ║`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
  }

  connectWebSockets() {
    CONFIG.SYMBOLS.forEach((symbol) => {
      const ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${symbol
          .replace("/", "")
          .toLowerCase()}@depth10@100ms`
      );
      ws.on("message", (data) => {
        const parsed = JSON.parse(data);
        this.orderBooks[symbol] = {
          bids: parsed.bids.map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
          asks: parsed.asks.map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
        };
      });
      ws.on("close", () => setTimeout(() => this.connectWebSockets(), 5000));
    });
  }

  async start() {
    await this.exchange.loadMarkets();
    await this.updateDynamicWhaleSizes();
    this.connectWebSockets();
    setInterval(() => {
      this.displayDashboard();
      CONFIG.SYMBOLS.forEach((s) => {
        const opp = this.analyzeForEntry(s, this.orderBooks[s]);
        if (opp) this.executeTrade(opp);
      });
    }, CONFIG.UPDATE_INTERVAL);
  }
}

new RevenueMultiTradeBot().start();
