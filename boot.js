const ccxt = require("ccxt");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const TI = require("technicalindicators");
const DatabaseManager = require("./DatabaseManager");
require("dotenv").config();

const CONFIG = {
  SYMBOLS: [
    "BTC/USDT",
    "ETH/USDT",
    "BNB/USDT",
    "XRP/USDT",
    "ADA/USDT",
    "SOL/USDT",
    "DOGE/USDT",
    "DOT/USDT",
    "LTC/USDT",
  ],
  MAX_CONCURRENT_TRADES: 3, // تقليل من 5 إلى 3 لتحسين إدارة المخاطر
  MAX_SPREAD: 0.0012,
  UPDATE_INTERVAL: 8000, // زيادة من 5 إلى 8 ثواني لتحليل أفضل
  MAX_MONITOR_TIME: 10800000, // 3 ساعات بدلاً من ساعتين
  COOLDOWN_TIME: 600000, // 10 دقائق بدلاً من 5

  // إعدادات المؤشرات
  CANDLE_LIMIT: 300, // زيادة لشموع 30 دقيقة
  TIMEFRAME: "30m", // استخدام 30 دقيقة بدلاً من 5

  // إعدادات مصفوفة القرار
  MIN_CONFIDENCE: 88, // زيادة من 85 إلى 88
  MAX_RSI_ENTRY: 58, // تخفيض من 63 إلى 58 ليكون أكثر تحفظاً
  MIN_VOLUME_RATIO: 2.0, // زيادة من 1.7 إلى 2.0

  // إعدادات المخاطرة
  BASE_RISK_PERCENT: 0.05, // تخفيض من 8% إلى 5%
  MIN_TRADE_SIZE: 20, // زيادة من 15 إلى 20
  MAX_TRADE_SIZE_PERCENT: 0.15, // 15% من الرصيد كحد أقصى

  // إعدادات السلامة
  MAX_DAILY_LOSS_PERCENT: -10, // -10% كحد أقصى للخسارة اليومية
  MAX_DRAWDOWN_PERCENT: -15, // -15% كحد أقصى للدروداون
  ENABLE_LIVE_TRADING: false, // وضع التجربة

  // إعدادات إضافية
  MIN_TREND_STRENGTH: 0.3, // قوة اتجاه دنيا
  MAX_VOLATILITY_PERCENT: 5, // أقصى تقبول للتقلب
  WHALE_THRESHOLD_MULTIPLIER: 0.008, // معامل حد الحيتان
};

class ProfessionalTradingSystem {
  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
      options: {
        defaultType: "spot",
        adjustForTimeDifference: true,
        recvWindow: 60000,
      },
    });

    this.dbManager = new DatabaseManager();
    this.orderBooks = {};
    this.activeTrades = [];
    this.cooldowns = {};
    this.marketData = {};
    this.wsHealth = {};
    this.volumeHistory = {};
    this.fees = {};
    this.dailyStats = {
      date: new Date().toISOString().split("T")[0],
      profit: 0,
      loss: 0,
      trades: 0,
      netProfit: 0,
    };

    this.performance = {
      trades: 0,
      wins: 0,
      losses: 0,
      netProfit: 0,
      totalConfidence: 0,
      dailyProfit: 0,
      dailyLoss: 0,
      startTime: Date.now(),
    };

    if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      this.tgBot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
        polling: false,
      });
      this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    this.initLogs();
    this.initDirectories();
    this.sendTelegram(
      "🚀 *بدء النظام الاحترافي مع إعدادات محسّنة (30m timeframe)*"
    );
  }

  initLogs() {
    const logsDir = path.join(__dirname, "logs");
    const tradesDir = path.join(__dirname, "trades");
    const backupDir = path.join(__dirname, "backups");

    [logsDir, tradesDir, backupDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    const csvFile = path.join(tradesDir, "professional_trades.csv");
    if (!fs.existsSync(csvFile)) {
      const headers =
        "Timestamp,Symbol,Entry,Exit,Pnl%,Pnl$,Confidence,RSI,VolumeRatio,Whales,Reasons,ExitReason,Duration\n";
      fs.writeFileSync(csvFile, headers);
    }

    const today = new Date().toISOString().split("T")[0];
    this.logFile = path.join(logsDir, `${today}.log`);

    // كتابة بداية سجل اليوم
    this.log(`=== بدء تشغيل النظام ${today} ===`, "INFO");
  }

  initDirectories() {
    // إنشاء هيكل المجلدات
    const dirs = ["data", "config", "reports", "charts"];
    dirs.forEach((dir) => {
      const dirPath = path.join(__dirname, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    });
  }

  async log(message, level = "INFO") {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;

    fs.appendFileSync(this.logFile, logMessage);

    // عرض في الكونسول مع ألوان
    const colors = {
      INFO: "\x1b[36m", // Cyan
      WARN: "\x1b[33m", // Yellow
      ERROR: "\x1b[31m", // Red
      SUCCESS: "\x1b[32m", // Green
    };

    const color = colors[level] || "\x1b[0m";
    console.log(`${color}[${level}]\x1b[0m ${message}`);
  }

  async sendTelegram(message, options = {}) {
    if (!this.tgBot) return;
    try {
      await this.tgBot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
        ...options,
      });
    } catch (error) {
      this.log(`فشل إرسال تليجرام: ${error.message}`, "ERROR");
    }
  }

  // ==================== إدارة المخاطر المتقدمة ====================
  checkDailyRiskLimits() {
    const dailyLossLimit = (-CONFIG.MAX_DAILY_LOSS_PERCENT / 100) * 1000; // بناءً على رصيد 1000$
    const drawdownLimit = (-CONFIG.MAX_DRAWDOWN_PERCENT / 100) * 1000;

    if (this.dailyStats.netProfit < dailyLossLimit) {
      this.log(
        `🛑 توقف التداول: تجاوز حد الخسارة اليومية (${this.dailyStats.netProfit.toFixed(
          2
        )}$)`,
        "ERROR"
      );
      this.sendTelegram(
        `🛑 *توقف التداول اليومي*\nتجاوز حد الخسارة اليومية!\nالخسارة: ${this.dailyStats.netProfit.toFixed(
          2
        )}$`
      );
      return false;
    }

    if (this.performance.netProfit < drawdownLimit) {
      this.log(
        `🛑 توقف التداول: تجاوز حد الدروداون (${this.performance.netProfit.toFixed(
          2
        )}$)`,
        "ERROR"
      );
      this.sendTelegram(
        `🛑 *توقف التداول*\nتجاوز حد الدروداون!\nالدروداون: ${this.performance.netProfit.toFixed(
          2
        )}$`
      );
      return false;
    }

    return true;
  }

  // ==================== حساب مؤشرات فنية متقدمة ====================
  calculateAdvancedIndicators(symbol) {
    const indicators = this.calculateTechnicalIndicators(symbol);
    if (!indicators) return null;

    try {
      const market = this.marketData[symbol];
      if (!market || market.candles.length < 100) return null;

      const candles = [...market.candles].sort((a, b) => a[0] - b[0]);
      const completedCandles = candles.slice(0, -1);

      const closes = completedCandles.map((c) => c[4]);
      const highs = completedCandles.map((c) => c[2]);
      const lows = completedCandles.map((c) => c[3]);
      const volumes = completedCandles.map((c) => c[5]);

      // 1. حساب MACD
      const macd = TI.MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });

      // 2. حساب Stochastic
      const stochastic = TI.Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
        signalPeriod: 3,
      });

      // 3. حساب Bollinger Bands
      const bollinger = TI.BollingerBands.calculate({
        period: 20,
        values: closes,
        stdDev: 2,
      });

      // 4. حساب OBV (On-Balance Volume)
      const obv = this.calculateOBV(closes, volumes);

      // 5. حساب ADX (Average Directional Index)
      const adx = this.calculateADX(highs, lows, closes);

      return {
        ...indicators,
        macd: macd[macd.length - 1] || {},
        stochastic: stochastic[stochastic.length - 1] || {},
        bollinger: bollinger[bollinger.length - 1] || {},
        obv: obv,
        adx: adx,
        trendStrength: this.calculateTrendStrength(closes),
        supportResistance: this.calculateSupportResistance(closes),
      };
    } catch (error) {
      this.log(
        `❌ خطأ في حساب المؤشرات المتقدمة لـ ${symbol}: ${error.message}`,
        "ERROR"
      );
      return indicators; // العودة للمؤشرات الأساسية في حالة الخطأ
    }
  }

  calculateOBV(closes, volumes) {
    let obv = 0;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) {
        obv += volumes[i];
      } else if (closes[i] < closes[i - 1]) {
        obv -= volumes[i];
      }
    }
    return obv;
  }

  calculateADX(highs, lows, closes) {
    // حساب مبسط للـ ADX
    const period = 14;
    if (closes.length < period * 2) return 25; // قيمة افتراضية

    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];
    const prevHigh = highs[highs.length - 2];
    const prevLow = lows[lows.length - 2];

    const tr = Math.max(
      lastHigh - lastLow,
      Math.abs(lastHigh - closes[closes.length - 2]),
      Math.abs(lastLow - closes[closes.length - 2])
    );

    const upMove = lastHigh - prevHigh;
    const downMove = prevLow - lastLow;

    let plusDM = 0;
    let minusDM = 0;

    if (upMove > downMove && upMove > 0) plusDM = upMove;
    if (downMove > upMove && downMove > 0) minusDM = downMove;

    const atr = indicators.atr || tr;
    const plusDI = atr > 0 ? (plusDM / atr) * 100 : 0;
    const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0;

    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;

    return Math.min(100, Math.max(0, dx || 25));
  }

  calculateTrendStrength(closes) {
    if (closes.length < 50) return 0;

    const recentCloses = closes.slice(-50);
    const x = Array.from({ length: 50 }, (_, i) => i);
    const y = recentCloses;

    // حساب الميل باستخدام الانحدار الخطي البسيط
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // تحويل الميل إلى قوة اتجاه (0-1)
    const trendStrength = Math.min(1, Math.abs(slope) / (y[0] * 0.01));
    return trendStrength;
  }

  calculateSupportResistance(closes) {
    if (closes.length < 100) return { support: 0, resistance: 0 };

    const recentCloses = closes.slice(-100);
    const sorted = [...recentCloses].sort((a, b) => a - b);

    // حساب مستويات الدعم والمقاومة
    const support = sorted[Math.floor(sorted.length * 0.2)]; // النسبة المئوية 20
    const resistance = sorted[Math.floor(sorted.length * 0.8)]; // النسبة المئوية 80

    return { support, resistance };
  }

  // ==================== مصفوفة قرار محسنة ====================
  calculateEnhancedDecisionMatrix(symbol, orderBook) {
    const indicators = this.calculateAdvancedIndicators(symbol);
    if (!indicators) return { confidence: 0, reasons: ["❌ بيانات غير كافية"] };

    let totalScore = 0;
    const reasons = [];
    const warnings = [];
    const advancedSignals = [];

    // --- 1. تحليل الأوردر بوك ---
    const ob = this.analyzeOrderBookDynamics(symbol, orderBook);
    totalScore += ob.score;
    reasons.push(...ob.reasons);

    if (ob.imbalance < 0.4) {
      totalScore -= 40;
      warnings.push("⚠️ ضغط بيع قوي جداً");
    }

    // --- 2. تحليل متقدم للـ RSI ---
    if (indicators.rsi < 35) {
      totalScore += 30;
      reasons.push(`📉 RSI في منطقة ذروة بيع (${indicators.rsi.toFixed(1)})`);
      advancedSignals.push("RSI_OVERSOLD");
    } else if (indicators.rsi < 45) {
      totalScore += 20;
      reasons.push(`📊 RSI في منطقة تجميع (${indicators.rsi.toFixed(1)})`);
    } else if (indicators.rsi > 70) {
      totalScore -= 30;
      warnings.push(`🚨 RSI في منطقة ذروة شراء (${indicators.rsi.toFixed(1)})`);
    }

    // --- 3. تحليل اتجاه قوي ---
    if (indicators.trendStrength > CONFIG.MIN_TREND_STRENGTH) {
      totalScore += 25;
      reasons.push(
        `📈 قوة اتجاه عالية (${(indicators.trendStrength * 100).toFixed(1)}%)`
      );
      advancedSignals.push("STRONG_TREND");
    }

    // --- 4. تحليل الفوليوم المتقدم ---
    if (indicators.volumeRatio > 2.5) {
      totalScore += 30;
      reasons.push(
        `🔥 انفجار فوليوم كبير (${indicators.volumeRatio.toFixed(1)}x)`
      );
      advancedSignals.push("VOLUME_SURGE");
    } else if (indicators.volumeRatio > CONFIG.MIN_VOLUME_RATIO) {
      totalScore += 15;
      reasons.push(
        `📊 فوليوم أعلى من المتوسط (${indicators.volumeRatio.toFixed(1)}x)`
      );
    }

    // --- 5. تحليل الحيتان المتقدم ---
    const whales = this.analyzeWhales(symbol, orderBook, indicators.avgVolume);
    totalScore += whales.score;
    reasons.push(...whales.reasons);

    if (whales.whales.length >= 5) {
      totalScore += 20;
      advancedSignals.push("MULTIPLE_WHALES");
    }

    // --- 6. تحليل الدعم والمقاومة ---
    const currentPrice = orderBook.bids[0][0];
    const { support, resistance } = indicators.supportResistance;

    if (currentPrice <= support * 1.02) {
      // قريب من الدعم (+2%)
      totalScore += 20;
      reasons.push(
        `🛡️ قرب مستوى دعم قوي (${(
          ((currentPrice - support) / support) *
          100
        ).toFixed(2)}%)`
      );
      advancedSignals.push("NEAR_SUPPORT");
    }

    // --- 7. تحليل التقلب ---
    const volatilityPct = (indicators.atr / indicators.close) * 100;
    if (volatilityPct > CONFIG.MAX_VOLATILITY_PERCENT) {
      totalScore -= 25;
      warnings.push(
        `⚡ تقلب عالي جداً (${volatilityPct.toFixed(2)}%) - خطر مرتفع`
      );
    } else if (volatilityPct > 2) {
      totalScore += 10;
      reasons.push(`⚡ تقلب معتدل (${volatilityPct.toFixed(2)}%) - فرصة جيدة`);
    }

    // --- 8. تحليل MACD ---
    if (indicators.macd && indicators.macd.MACD > indicators.macd.signal) {
      totalScore += 15;
      reasons.push(`📊 MACD إيجابي (${indicators.macd.MACD.toFixed(4)})`);
      advancedSignals.push("MACD_BULLISH");
    }

    // --- 9. تحليل Stochastic ---
    if (indicators.stochastic && indicators.stochastic.k < 30) {
      totalScore += 10;
      reasons.push(
        `📈 Stochastic في منطقة ذروة بيع (${indicators.stochastic.k.toFixed(
          1
        )})`
      );
    }

    // --- 10. تحليل الاتجاه المؤسسي ---
    const isBullishTrend =
      indicators.close > indicators.sma50 &&
      indicators.sma50 > indicators.sma200;
    if (isBullishTrend) {
      totalScore += 20;
      reasons.push("🏦 اتجاه صاعد مؤسسي (Golden Cross)");
      advancedSignals.push("GOLDEN_CROSS");
    }

    // حساب الثقة النهائية مع مرجحة الإشارات المتقدمة
    let confidence = Math.max(0, Math.min(100, totalScore));

    // تعزيز الثقة للإشارات المتقدمة
    if (advancedSignals.length >= 3) {
      confidence = Math.min(100, confidence * 1.15);
      reasons.push(`🎯 ${advancedSignals.length} إشارات متقدمة متزامنة`);
    }

    return {
      confidence: Math.round(confidence),
      reasons,
      warnings,
      indicators,
      whaleAnalysis: whales,
      volatility: volatilityPct,
      advancedSignals,
    };
  }

  // ==================== تحليل الفرص المحسن ====================
  analyzeForEntry(symbol, orderBook) {
    // التحقق من حدود المخاطر اليومية
    if (!this.checkDailyRiskLimits()) {
      return null;
    }

    // التحقق من استقرار WebSocket
    const wsHealth = this.wsHealth?.[symbol];
    if (
      !wsHealth ||
      !wsHealth.stable ||
      Date.now() - wsHealth.lastUpdate > 3000
    ) {
      return null;
    }

    // التحقق من البيانات الأساسية
    if (!orderBook || !orderBook.bids?.length || !orderBook.asks?.length) {
      return null;
    }

    if (orderBook.bids.length < 15 || orderBook.asks.length < 15) {
      return null;
    }

    // التحقق من الحدود
    if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) return null;
    if (this.activeTrades.some((t) => t.symbol === symbol)) return null;

    // التحقق من فترة التبريد
    if (
      this.cooldowns?.[symbol] &&
      Date.now() - this.cooldowns[symbol] < CONFIG.COOLDOWN_TIME
    ) {
      return null;
    }

    // التحقق من البيانات التاريخية
    const market = this.marketData?.[symbol];
    if (!market || market.candles.length < 100) {
      return null;
    }

    // تحليل الأوردر بوك
    const obAnalysis = this.analyzeOrderBookDynamics(symbol, orderBook);
    if (!obAnalysis) return null;

    // مصفوفة القرار المحسنة
    const decision = this.calculateEnhancedDecisionMatrix(symbol, orderBook);
    if (!decision || decision.confidence < CONFIG.MIN_CONFIDENCE) return null;

    const indicators = decision.indicators;

    // فلاتر صارمة
    if (indicators.rsi >= CONFIG.MAX_RSI_ENTRY) return null;
    if (indicators.volumeRatio < CONFIG.MIN_VOLUME_RATIO) return null;

    // تحليل السبريد
    const bestBid = orderBook.bids[0][0];
    const bestAsk = orderBook.asks[0][0];
    const spread = (bestAsk - bestBid) / bestBid;
    if (spread > CONFIG.MAX_SPREAD) return null;

    // تنبيهات الحيتان الكبيرة
    if (
      obAnalysis.imbalance > 8 &&
      decision.whaleAnalysis?.whales?.length >= 4
    ) {
      this.sendTelegram(
        `💎 *تنبيه حيتان كبار*\n${symbol}\nالميزان: ${obAnalysis.imbalance.toFixed(
          1
        )}x\nالحيتان: ${decision.whaleAnalysis.whales.length}`
      );
    }

    // حساب الأهداف
    const entryPrice = bestAsk;
    const targets = this.calculateEnhancedTargets(
      entryPrice,
      indicators,
      decision.confidence
    );
    if (!targets || targets.riskRewardRatio < 1.2) return null; // زيادة من 0.8 إلى 1.2

    // إنشاء إشارة الدخول
    return {
      symbol,
      entryPrice,
      stopLoss: targets.stopLoss,
      takeProfit: targets.takeProfit,
      confidence: decision.confidence,
      reasons: decision.reasons,
      warnings: decision.warnings,
      indicators,
      advancedSignals: decision.advancedSignals,
      wallPrice: obAnalysis.strongWall?.price || null,
      initialWallVolume: obAnalysis.strongWall?.volume || 0,
      imbalanceAtEntry: obAnalysis.imbalance,
      whaleAnalysis: decision.whaleAnalysis,
      targets,
      spread,
      entryTime: Date.now(),
      riskRewardRatio: targets.riskRewardRatio,
    };
  }

  calculateEnhancedTargets(entryPrice, indicators, confidence) {
    const atr = indicators.atr || entryPrice * 0.01; // زيادة من 0.8% إلى 1%

    // معاملات ديناميكية بناءً على الثقة وظروف السوق
    let stopMultiplier = 2.0;
    let profitMultiplier = 2.5;

    if (confidence > 90) {
      stopMultiplier = 1.8;
      profitMultiplier = 2.8;
    } else if (confidence > 80) {
      stopMultiplier = 2.2;
      profitMultiplier = 2.5;
    } else {
      stopMultiplier = 2.5;
      profitMultiplier = 2.2;
    }

    const stopLossDistance = atr * stopMultiplier;
    const stopLoss = entryPrice - stopLossDistance;
    const takeProfit = entryPrice + stopLossDistance * profitMultiplier;

    // حدود الحماية المحسنة
    const MIN_SL_PERCENT = 0.01; // 1% حد أدنى
    const MIN_TP_PERCENT = 0.02; // 2% حد أدنى

    // تطبيق الحدود مع الحماية من المستويات القريبة
    const finalStopLoss = Math.min(
      stopLoss,
      entryPrice * (1 - MIN_SL_PERCENT),
      indicators.supportResistance?.support * 0.995 ||
        entryPrice * (1 - MIN_SL_PERCENT)
    );

    const finalTakeProfit = Math.max(
      takeProfit,
      entryPrice * (1 + MIN_TP_PERCENT),
      indicators.supportResistance?.resistance * 0.998 ||
        entryPrice * (1 + MIN_TP_PERCENT)
    );

    const riskRewardRatio =
      (finalTakeProfit - entryPrice) / (entryPrice - finalStopLoss);

    return {
      stopLoss: finalStopLoss,
      takeProfit: finalTakeProfit,
      riskRewardRatio,
      atrBased: !!indicators.atr,
      atrValue: atr,
      stopMultiplier,
      profitMultiplier,
    };
  }

  // ==================== إدارة الحساب الحقيقي ====================
  async getActualBalance() {
    if (!CONFIG.ENABLE_LIVE_TRADING) {
      // وضع المحاكاة
      const simulatedBalance = 1000 + this.performance.netProfit;
      this.log(`💰 رصيد المحاكاة: ${simulatedBalance.toFixed(2)} USDT`, "INFO");
      return simulatedBalance;
    }

    try {
      const balance = await this.exchange.fetchBalance();
      const usdtBalance = balance.USDT?.free || 0;
      this.log(
        `💰 رصيد حقيقي في باينانس: ${usdtBalance.toFixed(2)} USDT`,
        "SUCCESS"
      );
      return usdtBalance;
    } catch (error) {
      this.log(`❌ فشل جلب الرصيد: ${error.message}`, "ERROR");
      return 0;
    }
  }

  // ==================== إدارة الصفقات المحسنة ====================
  async executeTrade(opportunity) {
    try {
      const myBalance = await this.getActualBalance();
      if (myBalance < 50) {
        this.log("⚠️ رصيد غير كافي لفتح صفقة", "WARN");
        return;
      }

      // حساب حجم الصفقة مع إدارة مخاطرة محسنة
      const baseRisk = CONFIG.BASE_RISK_PERCENT;
      const confidenceFactor = opportunity.confidence / 100;
      const whaleFactor = Math.min(
        1.5,
        (opportunity.whaleAnalysis.whales?.length || 0) * 0.2
      );
      const signalFactor = 1 + (opportunity.advancedSignals?.length || 0) * 0.1;

      let tradeSize =
        myBalance * baseRisk * confidenceFactor * whaleFactor * signalFactor;

      // حماية متقدمة لحجم الصفقة
      const maxPerTrade = myBalance * CONFIG.MAX_TRADE_SIZE_PERCENT;
      const minTradeSize = CONFIG.MIN_TRADE_SIZE;

      tradeSize = Math.min(tradeSize, maxPerTrade);
      tradeSize = Math.max(tradeSize, minTradeSize);

      // تقريب لحجم مناسب
      tradeSize = Math.floor(tradeSize * 100) / 100;

      const trade = {
        id: `TRADE_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
        symbol: opportunity.symbol,
        entryPrice: opportunity.entryPrice,
        entryTime: opportunity.entryTime,
        size: tradeSize,
        wallPrice: opportunity.wallPrice,
        initialWallVolume: opportunity.initialWallVolume,
        imbalanceAtEntry: opportunity.imbalanceAtEntry,
        stopLoss: opportunity.stopLoss,
        takeProfit: opportunity.takeProfit,
        currentStopLoss: opportunity.stopLoss,
        status: "ACTIVE",
        confidence: opportunity.confidence,
        reasons: opportunity.reasons,
        warnings: opportunity.warnings,
        advancedSignals: opportunity.advancedSignals,
        rsi: opportunity.indicators.rsi,
        volumeRatio: opportunity.indicators.volumeRatio,
        atr: opportunity.indicators.atr,
        highestPrice: opportunity.entryPrice,
        stopLossHistory: [
          {
            price: opportunity.stopLoss,
            time: Date.now(),
            reason: "Initial Stop Loss",
          },
        ],
        riskRewardRatio: opportunity.riskRewardRatio,
      };

      this.activeTrades.push(trade);

      // إرسال تقرير تفصيلي
      const whaleCount = opportunity.whaleAnalysis.whales?.length || 0;
      const whaleText =
        whaleCount >= 4
          ? `🐋🐋🐋🐋 ${whaleCount}`
          : whaleCount >= 3
          ? `🐋🐋🐋 ${whaleCount}`
          : whaleCount >= 2
          ? `🐋🐋 ${whaleCount}`
          : whaleCount >= 1
          ? `🐋 ${whaleCount}`
          : "لا توجد";

      const signalText =
        opportunity.advancedSignals?.length > 0
          ? `\n🎯 *الإشارات المتقدمة:*\n${opportunity.advancedSignals
              .map((s) => `• ${s}`)
              .join("\n")}`
          : "";

      this.sendTelegram(
        `🎯 *${trade.symbol} - دخول محترف (30m)*\n\n` +
          `💰 السعر: $${trade.entryPrice.toFixed(4)}\n` +
          `💵 الحجم: $${trade.size.toFixed(2)}\n` +
          `🎛️ الثقة: ${trade.confidence.toFixed(1)}%\n` +
          `📊 RSI: ${trade.rsi.toFixed(
            1
          )} | 📈 حجم: ${trade.volumeRatio.toFixed(1)}x\n` +
          `${whaleText} حيتان\n` +
          `🛑 الستوب: $${trade.stopLoss.toFixed(4)} (${(
            (1 - trade.stopLoss / trade.entryPrice) *
            100
          ).toFixed(2)}%)\n` +
          `🎯 الهدف: $${trade.takeProfit.toFixed(4)} (${(
            (trade.takeProfit / trade.entryPrice - 1) *
            100
          ).toFixed(2)}%)\n` +
          `📈 نسبة المكافأة/المخاطرة: ${trade.riskRewardRatio.toFixed(2)}\n` +
          signalText +
          `\n✅ *أسباب القرار:*\n${trade.reasons
            .slice(0, 4)
            .map((r) => `• ${r}`)
            .join("\n")}`
      );

      this.startEnhancedMonitoring(trade);
      this.log(
        `✅ فتح صفقة ${trade.symbol} بحجم $${trade.size.toFixed(2)}`,
        "SUCCESS"
      );
    } catch (error) {
      this.log(`❌ خطأ في تنفيذ الصفقة: ${error.message}`, "ERROR");
      this.sendTelegram(`❌ خطأ في التنفيذ: ${error.message}`);
    }
  }

  // ==================== المراقبة المحسنة ====================
  startEnhancedMonitoring(trade) {
    const monitor = async () => {
      if (trade.status !== "ACTIVE") return;

      const orderBook = this.orderBooks[trade.symbol];
      if (!orderBook) {
        setTimeout(monitor, 3000);
        return;
      }

      const currentPrice = orderBook.bids[0][0];
      const currentProfit =
        ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      const feePercent = (this.fees[trade.symbol]?.taker || 0.001) * 2 * 100;
      const netProfit = currentProfit - feePercent;

      // تحديث أعلى سعر
      if (currentPrice > trade.highestPrice) {
        trade.highestPrice = currentPrice;
      }

      // تحديث المؤشرات الحالية
      const currentIndicators = this.calculateAdvancedIndicators(trade.symbol);
      const activeATR = currentIndicators ? currentIndicators.atr : trade.atr;

      // إدارة ستوب لوز متقدمة
      this.updateAdvancedTrailingStop(
        trade,
        currentPrice,
        netProfit,
        activeATR
      );

      // قرار الخروج المحسن
      const exitDecision = this.enhancedExitDecision(
        trade,
        currentPrice,
        netProfit,
        orderBook,
        currentIndicators
      );

      if (exitDecision.exit) {
        trade.status = "CLOSED";

        // تحديث الإحصائيات اليومية
        this.dailyStats.trades++;
        this.dailyStats.netProfit += (netProfit / 100) * trade.size;
        if (netProfit > 0) {
          this.dailyStats.profit += (netProfit / 100) * trade.size;
        } else {
          this.dailyStats.loss += Math.abs((netProfit / 100) * trade.size);
        }

        // حفظ في قاعدة البيانات
        await this.dbManager.saveTrade({
          id: trade.id,
          symbol: trade.symbol,
          entryPrice: trade.entryPrice,
          exitPrice: currentPrice,
          entryTime: trade.entryTime,
          exitTime: Date.now(),
          pnlPercent: netProfit,
          pnlUsd: (netProfit / 100) * trade.size,
          confidence: trade.confidence,
          rsiValue: trade.rsi,
          volumeRatio: trade.volumeRatio,
          whalePower: trade.whaleAnalysis?.whales?.length || 0,
          reasons: trade.reasons.join(" | "),
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          exitReason: exitDecision.reason,
          duration: (Date.now() - trade.entryTime) / 1000,
          advancedSignals: trade.advancedSignals?.join(",") || "",
          riskRewardRatio: trade.riskRewardRatio,
        });

        // الإغلاق
        this.closeTrade(trade, currentPrice, netProfit, exitDecision.reason);
        this.cooldowns[trade.symbol] = Date.now();
        return;
      }

      setTimeout(monitor, 3000);
    };

    setTimeout(monitor, 3000);
  }

  updateAdvancedTrailingStop(trade, currentPrice, netProfit, activeATR) {
    // تأمين نقطة التعادل
    if (netProfit > 0.5 && trade.currentStopLoss < trade.entryPrice) {
      trade.currentStopLoss = trade.entryPrice * 1.001; // +0.1% للتأمين
      trade.stopLossHistory.push({
        price: trade.currentStopLoss,
        time: Date.now(),
        reason: "Breakeven Protection",
      });
      this.log(`${trade.symbol}: تأمين نقطة التعادل`, "INFO");
    }

    // تريلينج ستوب ديناميكي
    if (netProfit > 1.0) {
      const dynamicMultiplier = Math.max(1.5, 2.0 - netProfit / 10);
      const trailingStopPrice = currentPrice - activeATR * dynamicMultiplier;

      if (trailingStopPrice > trade.currentStopLoss) {
        trade.currentStopLoss = trailingStopPrice;
        trade.stopLossHistory.push({
          price: trade.currentStopLoss,
          time: Date.now(),
          reason: `Dynamic Trailing (ATR: ${activeATR.toFixed(
            4
          )}, Multiplier: ${dynamicMultiplier.toFixed(2)})`,
        });
      }
    }

    // تأمين الأرباح على مراحل
    const profitStages = [
      { level: 2.0, stopPercent: 0.5 },
      { level: 3.0, stopPercent: 1.0 },
      { level: 5.0, stopPercent: 2.0 },
    ];

    for (const stage of profitStages) {
      if (
        netProfit > stage.level &&
        trade.currentStopLoss < currentPrice * (1 - stage.stopPercent / 100)
      ) {
        trade.currentStopLoss = currentPrice * (1 - stage.stopPercent / 100);
        trade.stopLossHistory.push({
          price: trade.currentStopLoss,
          time: Date.now(),
          reason: `Profit Stage ${stage.level}% Protection`,
        });
        this.log(`${trade.symbol}: تأمين ربح مرحلة ${stage.level}%`, "INFO");
        break;
      }
    }
  }

  enhancedExitDecision(
    trade,
    currentPrice,
    netProfit,
    orderBook,
    currentIndicators
  ) {
    const obDynamics = this.analyzeOrderBookDynamics(trade.symbol, orderBook);

    // 1. تحليل انهيار الجدار
    if (trade.wallPrice && netProfit > -0.5) {
      const currentWall = orderBook.bids.find(
        (b) => Math.abs(b[0] - trade.wallPrice) < trade.entryPrice * 0.0002
      );

      if (
        !currentWall ||
        currentWall[0] * currentWall[1] < trade.initialWallVolume * 0.15
      ) {
        return { exit: true, reason: "WALL_LIQUIDITY_EVAPORATED" };
      }
    }

    // 2. ستوب لوز حالي
    if (currentPrice <= trade.currentStopLoss) {
      const reason =
        trade.currentStopLoss > trade.entryPrice
          ? "TRAILING_PROFIT_PROTECTION"
          : "STOP_LOSS_HIT";
      return { exit: true, reason };
    }

    // 3. تحقيق الهدف مع مرونة
    if (currentPrice >= trade.takeProfit) {
      if (obDynamics.imbalance > 2.5 && netProfit < 10) {
        // توسيع الهدف إذا السيولة لا تزال قوية
        trade.takeProfit = currentPrice * 1.015;
        this.log(`${trade.symbol}: توسيع الهدف بسبب سيولة قوية`, "INFO");
      } else {
        return { exit: true, reason: "TAKE_PROFIT_TARGET_REACHED" };
      }
    }

    // 4. تحليل المؤشرات المتقدمة للخروج
    if (currentIndicators) {
      // خروج إذا تحول MACD لسالب
      if (
        currentIndicators.macd &&
        currentIndicators.macd.MACD < currentIndicators.macd.signal &&
        netProfit > 0.5
      ) {
        return { exit: true, reason: "MACD_TURNED_BEARISH" };
      }

      // خروج إذا RSI أصبح في منطقة ذروة شراء
      if (currentIndicators.rsi > 75 && netProfit > 1.0) {
        return { exit: true, reason: "RSI_OVERBOUGHT" };
      }
    }

    // 5. ضعف السيولة
    if (netProfit > 0.8 && obDynamics.imbalance < 0.6) {
      return { exit: true, reason: "LIQUIDITY_WEAKNESS_DETECTED" };
    }

    // 6. حد الوقت
    if (Date.now() - trade.entryTime > CONFIG.MAX_MONITOR_TIME) {
      const reason = netProfit > 0 ? "TIME_LIMIT_PROFIT" : "TIME_LIMIT_LOSS";
      return { exit: true, reason };
    }

    // 7. حماية من الانعكاس السريع
    const priceFromHigh =
      ((trade.highestPrice - currentPrice) / trade.highestPrice) * 100;
    if (priceFromHigh > 3 && netProfit > 1.0) {
      return { exit: true, reason: "QUICK_REVERSAL_PROTECTION" };
    }

    return { exit: false, reason: "" };
  }

  // ==================== تحسين إغلاق الصفقات ====================
  async closeTrade(trade, exitPrice, netPnlPercent, reason) {
    const netPnlUsd = (netPnlPercent / 100) * trade.size;
    const duration = (Date.now() - trade.entryTime) / 60000;

    // تحديث الإحصائيات
    this.performance.trades++;
    this.performance.netProfit += netPnlUsd;
    this.performance.totalConfidence += trade.confidence;

    if (netPnlPercent > 0) {
      this.performance.wins++;
      this.performance.dailyProfit += netPnlUsd;
    } else {
      this.performance.losses++;
      this.performance.dailyLoss += Math.abs(netPnlUsd);
    }

    // تسجيل في CSV
    const log = `${new Date().toISOString()},${
      trade.symbol
    },${trade.entryPrice.toFixed(4)},${exitPrice.toFixed(
      4
    )},${netPnlPercent.toFixed(3)}%,${netPnlUsd.toFixed(
      3
    )},${trade.confidence.toFixed(1)},${trade.rsi.toFixed(
      1
    )},${trade.volumeRatio.toFixed(1)},${
      trade.whaleAnalysis?.whales?.length || 0
    },"${trade.reasons.slice(0, 2).join(" | ")}","${reason}",${duration.toFixed(
      1
    )}\n`;
    fs.appendFileSync(
      path.join(__dirname, "trades", "professional_trades.csv"),
      log
    );

    // إشعار الخروج
    const emojis = {
      PROFIT: "💰",
      STOP_LOSS: "🛑",
      TAKE_PROFIT: "🎯",
      TIME_LIMIT: "⏰",
      MACD: "📊",
      RSI: "📈",
      WALL: "🧱",
      LIQUIDITY: "💧",
      REVERSAL: "↪️",
    };

    let emoji = "📊";
    for (const [key, value] of Object.entries(emojis)) {
      if (reason.includes(key)) {
        emoji = value;
        break;
      }
    }

    const arabicReasons = {
      TRAILING_PROFIT_PROTECTION: "حماية الأرباح المتحركة",
      STOP_LOSS_HIT: "وصول للستوب لوز",
      TAKE_PROFIT_TARGET_REACHED: "تحقيق الهدف",
      TIME_LIMIT_PROFIT: "انتهاء الوقت مع ربح",
      TIME_LIMIT_LOSS: "انتهاء الوقت",
      WALL_LIQUIDITY_EVAPORATED: "اختفاء جدار السيولة",
      MACD_TURNED_BEARISH: "تحول MACD لسالب",
      RSI_OVERBOUGHT: "RSI في ذروة الشراء",
      LIQUIDITY_WEAKNESS_DETECTED: "ضعف السيولة",
      QUICK_REVERSAL_PROTECTION: "حماية من الانعكاس السريع",
    };

    const arabicReason = arabicReasons[reason] || reason;

    this.sendTelegram(
      `${emoji} *${trade.symbol} - إغلاق*\n\n` +
        `📊 الربح: ${netPnlPercent > 0 ? "+" : ""}${netPnlPercent.toFixed(
          2
        )}%\n` +
        `💸 القيمة: ${netPnlUsd > 0 ? "+" : ""}$${netPnlUsd.toFixed(2)}\n` +
        `⏱️ المدة: ${duration.toFixed(1)} دقيقة\n` +
        `🛑 حركات الستوب: ${trade.stopLossHistory.length - 1}\n` +
        `🎯 الثقة: ${trade.confidence.toFixed(1)}%\n` +
        `📝 السبب: ${arabicReason}\n` +
        `📈 نسبة الربح/المخاطرة: ${trade.riskRewardRatio.toFixed(2)}\n` +
        `🕐 ${new Date().toLocaleTimeString("ar-SA")}`
    );

    // إزالة من القائمة النشطة
    this.activeTrades = this.activeTrades.filter((t) => t.id !== trade.id);
    this.log(
      `✅ إغلاق صفقة ${trade.symbol} بربح ${netPnlPercent.toFixed(2)}%`,
      "SUCCESS"
    );
  }

  // ==================== تقارير محسنة ====================
  async sendEnhancedReport() {
    try {
      let report = "📊 *تقرير الرادار المتقدم (30m)*\n\n";
      const opportunities = [];

      for (const symbol of CONFIG.SYMBOLS) {
        const orderBook = this.orderBooks[symbol];
        if (!orderBook) continue;

        const decision = this.calculateEnhancedDecisionMatrix(
          symbol,
          orderBook
        );
        if (decision && decision.indicators) {
          opportunities.push({
            symbol,
            confidence: decision.confidence,
            decision,
            orderBookData: this.analyzeOrderBookDynamics(symbol, orderBook),
          });
        }
      }

      if (opportunities.length === 0) {
        report += "⏳ جاري تجميع بيانات كافية...\n";
      } else {
        opportunities.sort((a, b) => b.confidence - a.confidence);

        opportunities.slice(0, 6).forEach((item, index) => {
          const { symbol, confidence, decision, orderBookData } = item;
          const ind = decision.indicators;
          const powerBar = this.generateEnhancedPowerBar(
            orderBookData.imbalance
          );
          const trendIcon =
            ind.trendStrength > 0.4
              ? "📈"
              : ind.trendStrength > 0.2
              ? "↗️"
              : "➡️";

          report += `${index + 1}. *${symbol}* (${confidence}%)\n`;
          report += `   ${powerBar} ${orderBookData.imbalance.toFixed(1)}x\n`;
          report += `   📊 RSI: ${ind.rsi.toFixed(
            1
          )} | 📈 ${ind.volumeRatio.toFixed(1)}x | ${trendIcon}\n`;

          if (decision.advancedSignals && decision.advancedSignals.length > 0) {
            report += `   🎯 ${decision.advancedSignals
              .slice(0, 2)
              .join(" • ")}\n`;
          }

          report += `   💡 ${
            confidence >= CONFIG.MIN_CONFIDENCE ? "🚀 دخول" : "👁️ مراقبة"
          }\n`;
          report += `   ──────────────\n`;
        });
      }

      // إضافة ملخص النظام
      const activeCount = this.activeTrades.length;
      const todayProfit = this.dailyStats.netProfit;

      report += `\n📈 *ملخص النظام:*\n`;
      report += `   💼 صفقات نشطة: ${activeCount}/${CONFIG.MAX_CONCURRENT_TRADES}\n`;
      report += `   📅 الربح اليوم: ${
        todayProfit > 0 ? "+" : ""
      }$${todayProfit.toFixed(2)}\n`;
      report += `   🏆 النجاح: ${this.performance.wins}/${this.performance.trades}\n`;
      report += `   💰 إجمالي الربح: ${
        this.performance.netProfit > 0 ? "+" : ""
      }$${this.performance.netProfit.toFixed(2)}\n`;

      this.sendTelegram(report);
    } catch (error) {
      this.log(`❌ خطأ في إرسال التقرير: ${error.message}`, "ERROR");
    }
  }

  generateEnhancedPowerBar(imbalance) {
    const totalChars = 10;
    let greenCount = Math.min(
      totalChars,
      Math.max(0, Math.floor((imbalance / 2.5) * totalChars))
    );
    if (imbalance > 3) greenCount = totalChars;

    const redCount = totalChars - greenCount;
    const middleIndex = Math.floor(totalChars / 2);

    let bar = "";
    for (let i = 0; i < totalChars; i++) {
      if (i < greenCount) {
        bar += i === middleIndex ? "🟢" : "🟩";
      } else {
        bar += i === middleIndex ? "🔴" : "🟥";
      }
    }
    return bar;
  }

  // ==================== WebSocket محسن ====================
  connectWebSockets() {
    CONFIG.SYMBOLS.forEach((symbol) => {
      this.connectEnhancedWS(symbol);
    });
  }

  connectEnhancedWS(symbol) {
    const streamName = symbol.replace("/", "").toLowerCase();
    let ws;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;

    const connect = () => {
      ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${streamName}@depth20@100ms`
      );

      if (!this.wsHealth[symbol]) {
        this.wsHealth[symbol] = {
          stable: false,
          ticks: 0,
          lastUpdate: 0,
          lastBestBid: null,
          connectionTime: Date.now(),
        };
      }

      ws.on("open", () => {
        this.log(`✅ WebSocket connected for ${symbol}`, "SUCCESS");
        reconnectAttempts = 0;
      });

      ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data);

          if (!parsed.bids || !parsed.asks || parsed.bids.length < 10) {
            return;
          }

          const bids = parsed.bids.map((b) => [Number(b[0]), Number(b[1])]);
          const asks = parsed.asks.map((a) => [Number(a[0]), Number(a[1])]);

          const bestBid = bids[0][0];
          const health = this.wsHealth[symbol];

          if (
            health.lastBestBid === bestBid &&
            Date.now() - health.lastUpdate < 1000
          ) {
            return;
          }

          health.lastBestBid = bestBid;
          health.lastUpdate = Date.now();
          health.ticks++;

          if (health.ticks >= 5) {
            health.stable = true;
          }

          this.orderBooks[symbol] = { bids, asks };
        } catch (error) {
          // تجاهل أخطاء التحليل الطفيفة
        }
      });

      ws.on("error", (error) => {
        this.log(`❌ WebSocket error for ${symbol}: ${error.message}`, "ERROR");
        if (this.wsHealth[symbol]) {
          this.wsHealth[symbol].stable = false;
        }
      });

      ws.on("close", () => {
        this.log(
          `🔄 إعادة الاتصال لـ ${symbol} (المحاولة ${reconnectAttempts + 1})`,
          "WARN"
        );

        if (this.wsHealth[symbol]) {
          this.wsHealth[symbol].stable = false;
          this.wsHealth[symbol].ticks = 0;
        }

        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          setTimeout(connect, delay);
        } else {
          this.log(
            `❌ توقف إعادة الاتصال لـ ${symbol} بعد ${maxReconnectAttempts} محاولات`,
            "ERROR"
          );
        }
      });
    };

    connect();
  }

  // ==================== التشغيل الرئيسي المحسن ====================
  async start() {
    this.sendTelegram("🚀 *بدء النظام الاحترافي المحسن مع إطار زمني 30 دقيقة*");

    // تحميل الأسواق والرسوم
    try {
      await this.exchange.loadMarkets();

      for (const s of CONFIG.SYMBOLS) {
        const market = this.exchange.markets[s];
        this.fees[s] = {
          maker: market.maker || 0.001,
          taker: market.taker || 0.001,
          precision: market.precision || { price: 8, amount: 8 },
        };
      }

      this.log("✅ تم تحميل الأسواق والرسوم بنجاح", "SUCCESS");
    } catch (error) {
      this.log(`❌ فشل تحميل الأسواق: ${error.message}`, "ERROR");
      return;
    }

    // تحميل البيانات التاريخية
    this.sendTelegram("📊 *جاري تحميل البيانات التاريخية (30m)...*");
    const loadPromises = CONFIG.SYMBOLS.map(async (symbol) => {
      const loaded = await this.loadHistoricalData(symbol);
      if (loaded) {
        await this.log(`✅ ${symbol}: تم تحميل البيانات التاريخية`, "SUCCESS");
      } else {
        await this.log(`❌ ${symbol}: فشل تحميل البيانات`, "ERROR");
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });

    await Promise.all(loadPromises);

    // بدء WebSocket
    this.connectWebSockets();
    this.log("✅ بدء اتصالات WebSocket", "SUCCESS");

    // جدولة المهام
    setInterval(async () => {
      for (const symbol of CONFIG.SYMBOLS) {
        await this.updateMarketData(symbol);
      }
    }, 90000); // تحديث كل 1.5 دقيقة بدلاً من دقيقة

    setInterval(() => {
      if (!this.checkDailyRiskLimits()) {
        this.log("⏸️ توقف البحث عن فرص بسبب حدود المخاطر", "WARN");
        return;
      }

      CONFIG.SYMBOLS.forEach((symbol) => {
        const opp = this.analyzeForEntry(symbol, this.orderBooks[symbol]);
        if (opp) this.executeTrade(opp);
      });
    }, CONFIG.UPDATE_INTERVAL);

    setInterval(async () => {
      const stats = await this.dbManager.getTradeStatistics();
      if (stats) {
        const winRate =
          stats.total_trades > 0
            ? ((stats.winning_trades / stats.total_trades) * 100).toFixed(1)
            : 0;

        this.sendTelegram(
          `📈 *تقرير إحصائي كل ساعة*\n\n` +
            `📊 إجمالي الصفقات: ${stats.total_trades}\n` +
            `✅ الصفقات الرابحة: ${stats.winning_trades} (${winRate}%)\n` +
            `❌ الصفقات الخاسرة: ${stats.losing_trades}\n` +
            `📊 متوسط الربح: ${stats.avg_pnl_percent?.toFixed(2) || 0}%\n` +
            `💸 إجمالي الربح: $${stats.total_pnl_usd?.toFixed(2) || 0}\n` +
            `🎛️ متوسط الثقة: ${stats.avg_confidence?.toFixed(1) || 0}%\n` +
            `⏱️ متوسط المدة: ${
              (stats.avg_duration / 60)?.toFixed(1) || 0
            } دقيقة\n` +
            `📅 الربح اليوم: $${this.dailyStats.netProfit.toFixed(2)}`
        );
      }
    }, 3600000);

    setInterval(() => {
      this.sendEnhancedReport();
    }, 7200000); // كل ساعتين

    // إرسال أول تقرير
    setTimeout(() => {
      this.sendEnhancedReport();
    }, 30000);

    this.sendTelegram("✅ *النظام يعمل بنجاح مع إعدادات 30m المحسنة!*");
    this.log("=== النظام جاهز للعمل ===", "SUCCESS");
  }
}

// معالجة الإغلاق
process.on("SIGINT", async () => {
  const bot = global.botInstance;

  if (bot) {
    const stats = await bot.dbManager.getTradeStatistics();
    const winRate =
      bot.performance.trades > 0
        ? ((bot.performance.wins / bot.performance.trades) * 100).toFixed(1)
        : 0;

    const runtime = (Date.now() - bot.performance.startTime) / 3600000;

    await bot.sendTelegram(
      `🛑 *إغلاق النظام الاحترافي*\n\n` +
        `⏱️ وقت التشغيل: ${runtime.toFixed(1)} ساعة\n` +
        `📊 إجمالي الصفقات: ${bot.performance.trades}\n` +
        `🏆 نسبة النجاح: ${winRate}%\n` +
        `💰 الربح الصافي: $${bot.performance.netProfit.toFixed(2)}\n` +
        `📅 الربح اليوم: $${bot.dailyStats.netProfit.toFixed(2)}\n` +
        `🎛️ متوسط الثقة: ${(
          bot.performance.totalConfidence / (bot.performance.trades || 1)
        ).toFixed(1)}%\n\n` +
        `💾 *بيانات قاعدة البيانات:*\n` +
        `📈 إجمالي السجلات: ${stats?.total_trades || 0}\n` +
        `📊 متوسط الربح: ${stats?.avg_pnl_percent?.toFixed(2) || 0}%\n` +
        `🕐 ${new Date().toLocaleTimeString("ar-SA")}`
    );

    bot.log("=== إغلاق النظام ===", "INFO");
  }

  setTimeout(() => process.exit(0), 2000);
});

// معالجة الأخطاء غير المتوقعة
process.on("uncaughtException", async (error) => {
  console.error("❌ خطأ غير متوقع:", error);
  const bot = global.botInstance;

  if (bot && bot.tgBot) {
    await bot.sendTelegram(
      `🚨 *خطأ غير متوقع في النظام:*\n\`\`\`${error.message}\`\`\``
    );
  }

  setTimeout(() => process.exit(1), 5000);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("❌ رفض وعد غير معالج:", reason);
});

// إنشاء وتشغيل البوت
const bot = new ProfessionalTradingSystem();
global.botInstance = bot;

// بدء التشغيل مع معالجة الأخطاء
bot.start().catch(async (error) => {
  console.error("❌ فشل تشغيل النظام:", error);

  if (bot.tgBot) {
    await bot.sendTelegram(`🚨 *فشل تشغيل النظام:*\n${error.message}`);
  }

  process.exit(1);
});
