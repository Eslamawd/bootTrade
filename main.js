const ccxt = require("ccxt");
const WebSocket = require("ws");
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

// استيراد الكلاسات الاحترافية الجديدة
const DatabaseManager = require("./DatabaseManager");
const DataManager = require("./src/DataManager");
const OrderBookScanner = require("./src/OrderBookScanner");
const StrategyEngine = require("./src/StrategyEngine");

const CONFIG = {
  SYMBOLS: ["BTC/USDT", "ETH/USDT"],
  MAX_CONCURRENT_TRADES: 5,
  UPDATE_INTERVAL: 5000,
  MAX_MONITOR_TIME: 7200000,
  MIN_CONFIDENCE: 85,
  MAX_RSI_ENTRY: 63,
};

class ProfessionalTradingSystem {
  constructor() {
    // 1. إعداد الاتصال بالمنصة
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
    });

    // 2. تهيئة المكونات الجديدة
    this.dbManager = new DatabaseManager();
    this.scanner = new OrderBookScanner(this.dbManager);
    this.strategy = new StrategyEngine(CONFIG, this.scanner);

    // 3. إدارة الحالة
    this.activeTrades = [];
    this.wsHealth = {};
    this.fees = {};

    // 4. Telegram Setup
    if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      this.tgBot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
        polling: false,
      });
      this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    this.performance = {
      trades: 0,
      wins: 0,
      losses: 0,
      netProfit: 0,
      totalConfidence: 0,
    };
    this.initLogs();
  }

  initLogs() {
    if (!fs.existsSync("professional_trades.csv")) {
      const headers =
        "Timestamp,Symbol,Entry,Exit,Pnl%,Pnl$,Confidence,RSI,VolumeRatio,Reason\n";
      fs.writeFileSync("professional_trades.csv", headers);
    }
  }

  async sendTelegram(message) {
    if (!this.tgBot) return;
    try {
      await this.tgBot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
      });
    } catch (e) {
      console.error("TG Error:", e.message);
    }
  }

  async getMyActualBalance() {
    try {
      const balance = await this.exchange.fetchBalance();
      return 1000;
    } catch (e) {
      return 1000; // رصيد وهمي للاختبار في حالة فشل الربط
    }
  }

  // ==================== محرك التشغيل الرئيسي ====================

  async start() {
    this.sendTelegram("🏦 *بدء نظام التداول الاحترافي (Multi-Timeframe)*");

    await this.exchange.loadMarkets();
    this.loadFees();

    // تحميل البيانات التاريخية للفريمات (5m, 15m, 1h)
    this.sendTelegram("📊 جاري مزامنة بيانات الفريمات المتعددة...");
    await this.dataManager.initSymbols(CONFIG.SYMBOLS);

    // ربط السيولة اللحظية
    this.connectWebSockets();

    // تحديث المؤشرات كل دقيقة
    setInterval(async () => {
      for (const symbol of CONFIG.SYMBOLS) {
        await this.dataManager.updateSymbol(symbol, "5m");
        await this.dataManager.updateSymbol(symbol, "15m");
        await this.dataManager.updateSymbol(symbol, "1h");
      }
    }, 60000);

    // فحص الدخول كل 5 ثواني
    setInterval(() => this.runScannerLoop(), CONFIG.UPDATE_INTERVAL);

    // تقارير دورية
    this.setupReporting();
  }

  loadFees() {
    for (const s of CONFIG.SYMBOLS) {
      const market = this.exchange.markets[s];
      this.fees[s] = { taker: market?.taker || 0.001 };
    }
  }

  runScannerLoop() {
    for (const symbol of CONFIG.SYMBOLS) {
      const orderBook = this.scanner.orderBooks[symbol];
      const allMarketData = this.dataManager.marketData[symbol];

      if (!orderBook || !allMarketData) continue;

      // تمرير قائمة الصفقات النشطة للمحرك لمنع التكرار
      this.strategy.activeTrades = this.activeTrades;

      const opportunity = this.strategy.analyzeForEntry(
        symbol,
        orderBook,
        allMarketData,
        this.wsHealth
      );

      if (opportunity) {
        this.executeTrade(opportunity);
      }
    }
  }

  async executeTrade(opportunity) {
    const myBalance = await this.getMyActualBalance();
    if (myBalance < 15) return;

    const trade = {
      id: `TRD_${Date.now()}`,
      symbol: opportunity.symbol,
      entryPrice: opportunity.entryPrice,
      entryTime: Date.now(),
      size: Math.min(myBalance * 0.1, myBalance / CONFIG.MAX_CONCURRENT_TRADES),
      stopLoss: opportunity.stopLoss,
      takeProfit: opportunity.takeProfit,
      currentStopLoss: opportunity.stopLoss,
      confidence: opportunity.confidence,
      status: "ACTIVE",
      indicators: opportunity.indicators,
      reasons: opportunity.reasons,
      highestPrice: opportunity.entryPrice,
    };

    this.activeTrades.push(trade);
    this.sendTelegram(
      `🎯 *دخول ${trade.symbol}*\n💰 السعر: ${trade.entryPrice}\n🔥 الثقة: ${trade.confidence}%`
    );

    this.startMonitoring(trade);
  }

  startMonitoring(trade) {
    const monitor = async () => {
      if (trade.status !== "ACTIVE") return;

      const orderBook = this.scanner.orderBooks[trade.symbol];
      if (!orderBook) return setTimeout(monitor, 2000);

      const currentPrice = orderBook.bids[0][0];
      const pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

      // تحديث Trailing Stop بسيط
      if (currentPrice > trade.highestPrice) {
        trade.highestPrice = currentPrice;
        const newSL = currentPrice - trade.entryPrice * 0.01; // ستوب لوز يلحق بفرق 1%
        if (newSL > trade.currentStopLoss) trade.currentStopLoss = newSL;
      }

      // شروط الخروج
      let shouldExit = false;
      let reason = "";

      if (currentPrice <= trade.currentStopLoss) {
        shouldExit = true;
        reason = "STOP_LOSS_HIT";
      } else if (currentPrice >= trade.takeProfit) {
        shouldExit = true;
        reason = "TAKE_PROFIT_HIT";
      } else if (Date.now() - trade.entryTime > CONFIG.MAX_MONITOR_TIME) {
        shouldExit = true;
        reason = "TIME_EXIT";
      }

      if (shouldExit) {
        this.closeTrade(trade, currentPrice, pnl, reason);
      } else {
        setTimeout(monitor, 2000);
      }
    };
    monitor();
  }

  async closeTrade(trade, exitPrice, pnl, reason) {
    trade.status = "CLOSED";
    this.activeTrades = this.activeTrades.filter((t) => t.id !== trade.id);

    const pnlUsd = (pnl / 100) * trade.size;
    this.performance.trades++;
    this.performance.netProfit += pnlUsd;

    await this.dbManager.saveTrade({
      symbol: trade.symbol,
      entryPrice: trade.entryPrice,
      exitPrice: exitPrice,
      pnlPercent: pnl,
      pnlUsd: pnlUsd,
      exitReason: reason,
    });

    this.sendTelegram(
      `🏁 *إغلاق ${trade.symbol}*\n💵 الربح: ${pnl.toFixed(
        2
      )}%\n📝 السبب: ${reason}`
    );
  }

  connectWebSockets() {
    CONFIG.SYMBOLS.forEach((symbol) => {
      const stream = symbol.replace("/", "").toLowerCase();
      const ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${stream}@depth20@100ms`
      );

      ws.on("message", (data) => {
        const parsed = JSON.parse(data);
        const bids = parsed.bids.map((b) => [Number(b[0]), Number(b[1])]);
        const asks = parsed.asks.map((a) => [Number(a[0]), Number(a[1])]);

        this.scanner.processWSData(symbol, { bids, asks });
        this.wsHealth[symbol] = { stable: true, lastUpdate: Date.now() };
      });

      ws.on("close", () => setTimeout(() => this.connectWebSockets(), 5000));
    });
  }

  setupReporting() {
    setInterval(async () => {
      const stats = await this.dbManager.getTradeStatistics();
      if (stats) {
        this.sendTelegram(
          `📈 *تقرير الساعة*\n✅ صفقات: ${
            stats.total_trades
          }\n💰 صافي: $${stats.total_pnl_usd?.toFixed(2)}`
        );
      }
    }, 3600000);
  }
}

const bot = new ProfessionalTradingSystem();
global.botInstance = bot;
bot.start();
