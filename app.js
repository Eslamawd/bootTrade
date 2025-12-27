const ccxt = require("ccxt");
const WebSocket = require("ws");
const fs = require("fs");
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
  MAX_CONCURRENT_TRADES: 5,
  MAX_SPREAD: 0.0012, // 0.12% أقصى سبريد مقبول
  UPDATE_INTERVAL: 5000, // أبطأ قليلاً لإعطاء فرصة لتحليل البيانات
  MAX_MONITOR_TIME: 7200000, // ساعتين كحد أقصى
  COOLDOWN_TIME: 300000, // 5 دقائق

  // إعدادات المؤشرات
  CANDLE_LIMIT: 220,
  TIMEFRAME: "30m",

  // إعدادات مصفوفة القرار
  MIN_CONFIDENCE: 85,
  MAX_RSI_ENTRY: 63,
  MIN_VOLUME_RATIO: 1.7,
};

class ProfessionalTradingSystem {
  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
    });

    // إدارة قاعدة البيانات
    this.dbManager = new DatabaseManager();

    // البيانات
    this.orderBooks = {};
    this.activeTrades = [];
    this.cooldowns = {};
    this.marketData = {}; // لتخزين البيانات المؤقتة

    // Telegram
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
    this.sendTelegram("🏦 *بدء نظام التداول الاحترافي مع قاعدة بيانات*");
  }

  initLogs() {
    if (!fs.existsSync("professional_trades.csv")) {
      const headers =
        "Timestamp,Symbol,Entry,Exit,Pnl%,Pnl$,Confidence,RSI,VolumeRatio,Whales,Reasons\n";
      fs.writeFileSync("professional_trades.csv", headers);
    }
  }

  async sendTelegram(message) {
    if (!this.tgBot) return;
    try {
      await this.tgBot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
      });
    } catch (e) {}
  }

  // ==================== إدارة البيانات التاريخية ====================
  async loadHistoricalData(symbol) {
    try {
      // محاولة تحميل من قاعدة البيانات أولاً
      const dbCandles = await this.dbManager.getHistoricalCandles(
        symbol,
        CONFIG.TIMEFRAME,
        CONFIG.CANDLE_LIMIT
      );

      if (dbCandles && dbCandles.length >= 50) {
        // تحويل البيانات من قاعدة البيانات للصيغة المطلوبة
        const candles = dbCandles
          .map((c) => [
            new Date(c.timestamp).getTime(), // timestamp
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume,
          ])
          .sort((a, b) => a[0] - b[0]);

        this.marketData[symbol] = {
          candles,
          lastUpdate: Date.now(),
          source: "database",
        };

        console.log(
          `📊 ${symbol}: تم تحميل ${candles.length} شمعة من قاعدة البيانات`
        );
        return true;
      }

      // إذا البيانات غير كافية في قاعدة البيانات، نطلب من Binance
      console.log(`📊 ${symbol}: جلب بيانات تاريخية من Binance...`);
      const freshCandles = await this.exchange.fetchOHLCV(
        symbol,
        CONFIG.TIMEFRAME,
        undefined,
        CONFIG.CANDLE_LIMIT
      );

      if (freshCandles && freshCandles.length > 0) {
        // حفظ في قاعدة البيانات
        for (const candle of freshCandles) {
          await this.dbManager.saveCandle(symbol, candle, CONFIG.TIMEFRAME);
        }

        this.marketData[symbol] = {
          candles: freshCandles,
          lastUpdate: Date.now(),
          source: "binance",
        };

        console.log(`✅ ${symbol}: تم جلب وحفظ ${freshCandles.length} شمعة`);
        console.log(`${freshCandles}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`❌ خطأ في تحميل البيانات لـ ${symbol}:`, error.message);
      return false;
    }
  }
  async updateMarketData(symbol) {
    try {
      const latestCandles = await this.exchange.fetchOHLCV(
        symbol,
        CONFIG.TIMEFRAME,
        undefined,
        5
      );

      if (latestCandles && latestCandles.length > 0) {
        if (!this.marketData[symbol]) {
          this.marketData[symbol] = { candles: [] };
        }

        let localCandles = this.marketData[symbol].candles;

        for (const candle of latestCandles) {
          const timestamp = candle[0];
          const index = localCandles.findIndex((c) => c[0] === timestamp);

          if (index !== -1) {
            // تحديث الشمعة إذا كانت موجودة (لتحديث الحجم والسعر الحالي)
            localCandles[index] = candle;
          } else {
            // إضافة شمعة جديدة
            localCandles.push(candle);
          }
        }

        // إعادة الترتيب والحفاظ على الحد الأقصى
        localCandles.sort((a, b) => a[0] - b[0]);
        if (localCandles.length > CONFIG.CANDLE_LIMIT) {
          localCandles = localCandles.slice(-CONFIG.CANDLE_LIMIT);
        }

        this.marketData[symbol].candles = localCandles;
        this.marketData[symbol].lastUpdate = Date.now();

        // حفظ في الداتا بيز
        for (const candle of latestCandles) {
          await this.dbManager.saveCandle(symbol, candle, CONFIG.TIMEFRAME);
        }
        return true;
      }
    } catch (error) {
      console.error(`❌ خطأ في تحديث البيانات لـ ${symbol}:`, error.message);
    }
    return false;
  }
  // ==================== حساب المؤشرات الفنية من البيانات التاريخية ====================
  calculateTechnicalIndicators(symbol) {
    if (!this.marketData[symbol] || !this.marketData[symbol].candles)
      return null;

    const candles = this.marketData[symbol].candles;
    if (candles.length < 50) return null;

    const sortedCandles = [...candles].sort((a, b) => a[0] - b[0]);
    const completedCandles = sortedCandles.slice(0, -1);

    const closes = completedCandles.map((c) => c[4]);
    const highs = completedCandles.map((c) => c[2]);
    const lows = completedCandles.map((c) => c[3]);
    const volumes = completedCandles.map((c) => c[5]);

    try {
      // 1. حساب RSI و RSI السابق (لحساب الـ Momentum)
      const rsiValues = TI.RSI.calculate({ values: closes, period: 14 });
      const currentRSI = rsiValues[rsiValues.length - 1];
      const prevRSI = rsiValues[rsiValues.length - 2];

      // 2. حساب متوسط الـ RSI (للدخول الدايناميك)
      const rsiSMAValues = TI.SMA.calculate({ values: rsiValues, period: 20 });
      const currentRsiSMA = rsiSMAValues[rsiSMAValues.length - 1];

      // 3. حساب ATR (لقياس التقلب وتحديد الأهداف)
      const atrValues = TI.ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
      });
      const currentATR = atrValues[atrValues.length - 1];

      // 4. تحليل الفوليوم الانفجاري
      const volumeMA20 = TI.SMA.calculate({ values: volumes, period: 20 });
      const currentVolumeMA = volumeMA20[volumeMA20.length - 1] || 1;
      const lastCompletedVolume = volumes[volumes.length - 1] || 0;
      const volumeRatio = lastCompletedVolume / currentVolumeMA;

      // 5. المؤشرات الكلاسيكية (Trend)
      const sma50Values = TI.SMA.calculate({ values: closes, period: 50 });
      const sma200Values = TI.SMA.calculate({ values: closes, period: 200 });

      const avgVolume = volumeMA20.at(-1) || 0;
      const lastClose = closes[closes.length - 1]; // الإغلاق الأخير (الحالي)
      const prevClose = closes[closes.length - 2]; // الإغلاق الذي قبله

      return {
        rsi: currentRSI,
        prevRsi: prevRSI, // 🆕 مهم لفلتر الـ Momentum
        rsiSMA20: currentRsiSMA, // 🆕 مهم للـ Dynamic RSI logic
        close: lastClose, // السعر الحالي
        atr: currentATR,
        // السعر الحالي للإغلاق المكتمل
        prevClose: prevClose,
        volumeRatio,
        avgVolume,
        sma50: sma50Values.pop(),
        sma200: sma200Values.pop(),
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error(`❌ خطأ في حساب المؤشرات لـ ${symbol}:`, error.message);
      return null;
    }
  }
  // ==================== مصفوفة القرار المحدثة ====================
  calculateDecisionMatrix(symbol, orderBook) {
    const indicators = this.calculateTechnicalIndicators(symbol);
    if (!indicators) return { confidence: 0, reasons: ["❌ بيانات غير كافية"] };

    let totalScore = 0;
    const reasons = [];
    const warnings = [];

    // --- 1. Order Book Dynamics (السيولة اللحظية) ---
    const ob = this.analyzeOrderBookDynamics(symbol, orderBook);
    totalScore += ob.score;
    reasons.push(...ob.reasons);
    if (ob.imbalance < 0.4) {
      totalScore -= 30; // خصم نقاط بدل تصفير السكور لترك فرصة للمؤشرات الأخرى
      warnings.push("⚠️ ضغط بيع قوي في الـ Order Book");
    }

    // --- 2. Dynamic RSI (نسبة القوة النسبية المتكيفة) ---
    // فكرة: هل الـ RSI الحالي أقل من متوسط الـ RSI لآخر فترة؟ (يعني العملة رخيصة حالياً)
    const rsiSMA = indicators.rsiSMA20 || 50; // سنحتاج لإضافة rsiSMA في حساب المؤشرات
    const rsiDiff = indicators.rsi - rsiSMA;

    if (rsiDiff < -5) {
      // الـ RSI الحالي أقل من المتوسط بـ 5 درجات (فرصة شراء)
      totalScore += 25;
      reasons.push(
        `📉 RSI دايناميك: تحت المتوسط بـ ${Math.abs(rsiDiff).toFixed(
          1
        )} (تجميع)`
      );
    } else if (rsiDiff > 15) {
      totalScore -= 15;
      warnings.push("🚨 RSI دايناميك: تضخم سعري مقارنة بالمتوسط");
    }

    // --- 3. Dynamic Volume (انفجار الفوليوم الحقيقي) ---
    // بنقارن الفوليوم الحالي بـ 2x ATR للفوليوم أو Standard Deviation
    if (
      indicators.volumeRatio > 2.0 &&
      indicators.close > indicators.prevClose
    ) {
      totalScore += 25;
      reasons.push(
        `🔥 انفجار فوليوم غير مسبوق (${indicators.volumeRatio.toFixed(1)}x)`
      );
    } else if (
      indicators.volumeRatio > 2.0 &&
      indicators.close <= indicators.prevClose
    ) {
      totalScore += 25;
    }

    // --- 4. Whale Power (قوة الحيتان) ---
    const whales = this.analyzeWhales(symbol, orderBook, indicators.avgVolume);

    totalScore += whales.score;
    reasons.push(...whales.reasons);

    // --- 5. Volatility Context (سياق التقلب) ---
    // لو الـ ATR عالي جداً مقارنة بالسعر، ده معناه Risk عالي
    const volatilityPct = (indicators.atr / indicators.close) * 100;
    if (volatilityPct > 3) {
      // تقلب أعنف من 3% في الشمعة الواحدة
      totalScore -= 10;
      warnings.push(
        `⚡ تقلب مرتفع جداً (${volatilityPct.toFixed(2)}%) - خطر عالٍ`
      );
    }

    // --- 6. Trend Confirmation (تأكيد الاتجاه) ---
    const isBullish =
      indicators.close > indicators.sma50 &&
      indicators.sma50 > indicators.sma200;
    if (isBullish) {
      totalScore += 15;
      reasons.push("🌊 اتجاه صاعد مؤسسي (Price > SMA50 > SMA200)");
    }

    // حساب الـ Confidence النهائي مع سقف 100
    const confidence = Math.max(0, Math.min(100, totalScore));

    return {
      confidence,
      reasons,
      warnings,
      indicators,
      whaleAnalysis: whales,
      volatility: volatilityPct,
    };
  }

  analyzeWhales(symbol, orderBook, avgVolume = 0) {
    if (!orderBook || !orderBook.bids)
      return { score: 0, reasons: [], warnings: [], whales: [] };

    if (!this.volumeHistory) this.volumeHistory = {};

    this.volumeHistory[symbol] = { avgVolume };

    const dynamicThreshold =
      avgVolume > 0 ? Math.max(20000, avgVolume * 0.005) : 50000;

    let score = 0;
    const reasons = [];
    const warnings = [];
    const whales = [];

    for (let i = 0; i < Math.min(20, orderBook.bids.length); i++) {
      const value = orderBook.bids[i][0] * orderBook.bids[i][1];
      if (value >= dynamicThreshold) {
        whales.push({
          value,
          position: i + 1,
          size: (value / 1000).toFixed(1) + "K",
        });
      }
    }

    if (whales.length >= 3) {
      score += 25;
      reasons.push(`🐋🐋🐋 ${whales.length} حيتان نشطة`);
    } else if (whales.length > 0) {
      score += 15;
      reasons.push(`🐋 رصد ${whales.length} حوت`);
    }

    if (whales.filter((w) => w.position <= 5).length >= 2) {
      score += 15;
      reasons.push("🛡️ جدار دعم قوي قريب");
    }

    this.dbManager
      .saveWhaleSighting(symbol, {
        count: whales.length,
        largestValue: whales.length
          ? Math.max(...whales.map((w) => w.value))
          : 0,
        avgValue: whales.length
          ? whales.reduce((a, b) => a + b.value, 0) / whales.length
          : 0,
        positions: whales.map((w) => w.position),
        powerScore: score,
      })
      .catch(() => {});

    return { score, reasons, warnings, whales, dynamicThreshold };
  }

  analyzeOrderBookDynamics(symbol, orderBook) {
    if (
      !orderBook ||
      !orderBook.bids ||
      !orderBook.asks ||
      orderBook.bids.length < 15
    )
      return { score: 0, imbalance: 0, reasons: [], strongWall: null };

    // 1. حساب السيولة (Imbalance) - عمق 15 لزيادة الدقة في العملات الكبيرة
    const bidVolume = orderBook.bids
      .slice(0, 15)
      .reduce((sum, b) => sum + b[0] * b[1], 0);
    const askVolume = orderBook.asks
      .slice(0, 15)
      .reduce((sum, a) => sum + a[0] * a[1], 0);
    const imbalance = askVolume > 0 ? bidVolume / askVolume : 0;

    let score = 0;
    const reasons = [];

    // 2. تقييم الاختلال (Imbalance Score)
    if (imbalance > 1.8) {
      score += 30;
      reasons.push(`🌊 سيولة شراء (Imbalance: ${imbalance.toFixed(1)}x)`);
    } else if (imbalance < 0.4) {
      score -= 50; // عقوبة قوية لمنع الدخول أو الاستمرار في صفقة مهددة
    }

    // 3. تحديد عتبة الجدار بناءً على العملة (Dynamic Threshold)
    let wallThreshold = 100000;
    if (symbol.startsWith("BTC")) wallThreshold = 1500000;
    if (symbol.startsWith("ETH")) wallThreshold = 700000;
    if (symbol.startsWith("SOL")) wallThreshold = 250000;
    if (symbol.startsWith("BNB")) wallThreshold = 200000;

    // 4. رصد أقوى جدار دعم وتخزين بياناته (سعر وحجم)
    let strongWall = null;
    let maxWallValue = 0;

    orderBook.bids.slice(0, 15).forEach((bid) => {
      const wallValue = bid[0] * bid[1];
      if (wallValue > wallThreshold && wallValue > maxWallValue) {
        maxWallValue = wallValue;
        strongWall = {
          price: bid[0],
          volume: wallValue,
          formatted: (wallValue / 1000).toFixed(0) + "K",
        };
      }
    });

    if (strongWall) {
      score += 20;
      reasons.push(
        `🧱 جدار دعم صلب ($${strongWall.formatted}) عند ${strongWall.price}`
      );
    }

    return { score, imbalance, reasons, strongWall };
  }
  // ==================== تحليل الفرص ====================
  analyzeForEntry(symbol, orderBook) {
    /* ───────────────
     0️⃣ حمايات أساسية
  ─────────────── */

    const wsHealth = this.wsHealth?.[symbol];
    if (
      !wsHealth ||
      !wsHealth.stable ||
      Date.now() - wsHealth.lastUpdate > 2000
    ) {
      return null;
    }

    if (!orderBook || !orderBook.bids?.length || !orderBook.asks?.length) {
      return null;
    }

    if (orderBook.bids.length < 10 || orderBook.asks.length < 10) {
      return null;
    }

    if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) return null;
    if (this.activeTrades.some((t) => t.symbol === symbol)) return null;

    if (
      this.cooldowns?.[symbol] &&
      Date.now() - this.cooldowns[symbol] < CONFIG.COOLDOWN_TIME
    ) {
      return null;
    }

    /* ───────────────
     1️⃣ بيانات تاريخية
  ─────────────── */

    const market = this.marketData?.[symbol];
    if (!market || market.candles.length < 50) {
      return null;
    }

    /* ───────────────
     2️⃣ OrderBook Analysis
  ─────────────── */

    const obAnalysis = this.analyzeOrderBookDynamics(symbol, orderBook);
    if (!obAnalysis) return null;

    /* ───────────────
     3️⃣ Decision Matrix
  ─────────────── */

    const decision = this.calculateDecisionMatrix(symbol, orderBook);
    if (!decision || decision.confidence < CONFIG.MIN_CONFIDENCE) return null;

    const indicators = decision.indicators;

    /* ───────────────
     4️⃣ فلاتر صارمة
  ─────────────── */

    if (indicators.rsi >= CONFIG.MAX_RSI_ENTRY) return null;
    if (indicators.volumeRatio < CONFIG.MIN_VOLUME_RATIO) return null;

    const bestBid = orderBook.bids[0][0];
    const bestAsk = orderBook.asks[0][0];
    const spread = (bestAsk - bestBid) / bestBid;

    if (spread > CONFIG.MAX_SPREAD) return null;

    /* ───────────────
     5️⃣ تنبيه سوبر حوت
  ─────────────── */

    if (
      obAnalysis.imbalance > 10 &&
      decision.whaleAnalysis?.whales?.length >= 5
    ) {
      this.sendTelegram(
        `💎 *Super Whale Alert*\n${symbol}\nImbalance: ${obAnalysis.imbalance.toFixed(
          1
        )}x\nWhales: ${decision.whaleAnalysis.whales.length}`
      );
    }

    /* ───────────────
     6️⃣ أهداف ديناميكية
  ─────────────── */

    const entryPrice = bestAsk;

    const targets = this.calculateDynamicTargets(
      entryPrice,
      indicators,
      decision.confidence
    );

    if (!targets || targets.riskRewardRatio < 0.8) return null;

    /* ───────────────
     7️⃣ OK → Entry Signal
  ─────────────── */

    return {
      symbol,
      entryPrice,
      stopLoss: targets.stopLoss,
      takeProfit: targets.takeProfit,
      confidence: decision.confidence,
      reasons: decision.reasons,
      warnings: decision.warnings,
      indicators,
      wallPrice: obAnalysis.strongWall?.price || null,
      initialWallVolume: obAnalysis.strongWall?.volume || 0,
      imbalanceAtEntry: obAnalysis.imbalance,
      whaleAnalysis: decision.whaleAnalysis,
      targets,
      spread,
      entryTime: Date.now(),
    };
  }

  calculateDynamicTargets(entryPrice, indicators, confidence) {
    // 1. حساب ATR (متوسط حركة السعر) أو استبداله بـ 0.8% كحماية
    const atr = indicators.atr || entryPrice * 0.008;

    // 2. معامل المسافة بناءً على الثقة (Confidence)
    // إذا كانت الثقة عالية، نقرب الستوب قليلاً. إذا كانت متوسطة، نوسعه.
    const multiplier = confidence > 75 ? 2.2 : 2.8;
    const stopLossDistance = atr * multiplier;

    // 3. حساب الستوب لوز والهدف المبدئي
    const stopLoss = entryPrice - stopLossDistance;
    // جعل الهدف دائماً 2.2 ضعف المخاطرة لضمان ربحية طويلة الأمد
    const takeProfit = entryPrice + stopLossDistance * 2.2;

    // 4. حدود الحماية الصارمة (نسب مئوية)
    const MIN_SL_PERCENT = 0.008; // حد أدنى للستوب 0.8% (للتنفس)
    const MIN_TP_PERCENT = 0.015; // حد أدنى للهدف 1.5% (للربح بعد العمولات)

    // تطبيق الحدود:
    // الستوب لوز لا يجب أن يكون أقرب من 0.8%
    const finalStopLoss = Math.min(stopLoss, entryPrice * (1 - MIN_SL_PERCENT));

    // الهدف لا يجب أن يكون أقل من 1.5%
    const finalTakeProfit = Math.max(
      takeProfit,
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
    };
  }
  // ==================== تنفيذ الصفقات ====================

  // دالة لجلب الرصيد الحقيقي من حسابك
  async getMyActualBalance() {
    try {
      const usdtBalance = 1000;
      console.log(`💰 رصيدك الحالي في باينانس: ${usdtBalance.toFixed(2)} USDT`);
      return usdtBalance;
    } catch (error) {
      console.error("❌ فشل في جلب الرصيد:", error.message);
      return 0;
    }
  }

  async executeTrade(opportunity) {
    try {
      const myBalance = await this.getMyActualBalance();
      if (myBalance < 10) {
        console.log("⚠️ رصيد غير كافي لفتح صفقة حقيقية");
        return;
      }

      const baseRisk = 0.08; // 8% من الرصيد
      const confidenceFactor = opportunity.confidence / 100; // 0 → 1
      const whaleFactor = Math.min(
        1.5,
        (opportunity.whaleAnalysis.whales?.length || 0) * 0.3
      );

      let tradeSize = myBalance * baseRisk * confidenceFactor * whaleFactor;

      // حماية
      tradeSize = Math.min(tradeSize, myBalance / CONFIG.MAX_CONCURRENT_TRADES);
      tradeSize = Math.max(tradeSize, 15); // حد أدنى

      const trade = {
        id: `TRADE_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        symbol: opportunity.symbol,
        entryPrice: opportunity.entryPrice,
        entryTime: opportunity.entryTime,
        size: tradeSize,
        wallPrice: opportunity.wallPrice, // سعر الجدار الذي نحتمي خلفه
        initialWallVolume: opportunity.initialWallVolume, // حجم الجدار عند الدخول
        imbalanceAtEntry: opportunity.imbalanceAtEntry, // ميزان القوى لحظة الدخول
        stopLoss: opportunity.stopLoss,
        takeProfit: opportunity.takeProfit,
        status: "ACTIVE",

        // بيانات القرار
        confidence: opportunity.confidence,
        reasons: opportunity.reasons,
        warnings: opportunity.warnings,

        // بيانات فنية
        rsi: opportunity.indicators.rsi,
        volumeRatio: opportunity.indicators.volumeRatio,
        atr: opportunity.indicators.atr,

        // التتبع
        highestPrice: opportunity.entryPrice,
        currentStopLoss: opportunity.stopLoss,
        stopLossHistory: [
          {
            price: opportunity.stopLoss,
            time: Date.now(),
            reason: "Initial Stop Loss",
          },
        ],
      };

      this.activeTrades.push(trade);

      // إرسال تقرير مفصل
      const whaleCount = opportunity.whaleAnalysis.whales?.length || 0;
      const whaleText =
        whaleCount >= 3
          ? `🐋🐋🐋 ${whaleCount}`
          : whaleCount === 2
          ? `🐋🐋 ${whaleCount}`
          : whaleCount === 1
          ? `🐋 ${whaleCount}`
          : "لا توجد";

      this.sendTelegram(
        `🎯 *${trade.symbol} - دخول احترافي*\n\n` +
          `💰 السعر: $${trade.entryPrice.toFixed(4)}\n` +
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
          `📈 نسبة: ${opportunity.targets.riskRewardRatio.toFixed(2)}\n\n` +
          `✅ *أسباب القرار:*\n${trade.reasons
            .slice(0, 3)
            .map((r) => `• ${r}`)
            .join("\n")}`
      );

      this.startProfessionalMonitoring(trade);
    } catch (error) {
      this.sendTelegram(`❌ خطأ في التنفيذ: ${error.message}`);
    }
  }

  // ==================== المراقبة الاحترافية ====================
  startProfessionalMonitoring(trade) {
    const monitor = async () => {
      if (trade.status !== "ACTIVE") return;

      const orderBook = this.orderBooks[trade.symbol];
      if (!orderBook) return;

      const currentPrice = orderBook.bids[0][0];

      // 1. تحديث أعلى سعر وصل له السعر أثناء الصفقة
      if (currentPrice > trade.highestPrice) {
        trade.highestPrice = currentPrice;
      }

      const currentProfit =
        ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      const feePercent = (this.fees[trade.symbol]?.taker || 0.001) * 2 * 100;
      // 2 لأنه شراء + بيع، *100 لتحويل النسبة

      const netProfit = currentProfit - feePercent;

      // 2. جلب ATR اللحظي لاستخدامه في التريلينج ستوب
      const currentIndicators = this.calculateTechnicalIndicators(trade.symbol);
      const activeATR = currentIndicators ? currentIndicators.atr : trade.atr;

      // 3. التريلينج ستوب المطور المعتمد على ATR
      this.updateTrailingStop(trade, currentPrice, currentProfit, activeATR);

      // 4. قرار الخروج
      const exitDecision = this.shouldExit(
        trade,
        currentPrice,
        netProfit,
        orderBook
      );

      if (exitDecision.exit) {
        trade.status = "CLOSED";

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
          whalePower: 0,
          reasons: trade.reasons.join(" | "),
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          exitReason: exitDecision.reason,
          duration: (Date.now() - trade.entryTime) / 1000,
        });

        // الإغلاق المحلي والإشعار
        this.closeTrade(trade, currentPrice, netProfit, exitDecision.reason);
        this.cooldowns[trade.symbol] = Date.now();
        return;
      }

      setTimeout(monitor, 2000);
    };

    setTimeout(monitor, 2000);
  }

  updateTrailingStop(trade, currentPrice, currentProfit, activeATR) {
    // 1. تأمين نقطة التعادل (Breakeven)
    // بمجرد وصول الربح لـ 0.3%، ننقل الستوب لوز لمنطقة الدخول
    if (currentProfit > 0.3 && trade.currentStopLoss < trade.entryPrice) {
      trade.currentStopLoss = trade.entryPrice * 1.0005; // الدخول + عمولة بسيطة
      trade.stopLossHistory.push({
        price: trade.currentStopLoss,
        time: Date.now(),
        reason: "ATR-Breakeven Protection",
      });
    }

    // 2. تفعيل التريلينج المعتمد على ATR
    // سنبدأ في ملاحقة السعر بعد تحقيق ربح بسيط (مثلاً 0.4%)
    if (currentProfit > 0.4) {
      // نستخدم معامل 2.0x ATR للملاحقة.
      // السعر الجديد للستوب = السعر الحالي - (2 * ATR)
      const atrTrailingStopPrice = currentPrice - activeATR * 2.0;

      // الحماية: نحدث الستوب لوز فقط إذا كان السعر الجديد "أعلى" من الحالي
      // (عشان الستوب يفضل يرفع لفوق وما ينزلش تحت أبداً)
      if (atrTrailingStopPrice > trade.currentStopLoss) {
        trade.currentStopLoss = atrTrailingStopPrice;
        trade.stopLossHistory.push({
          price: trade.currentStopLoss,
          time: Date.now(),
          reason: `ATR-Trailing (ATR: ${activeATR.toFixed(4)})`,
        });
      }
    }
  }

  shouldExit(trade, currentPrice, netProfit, orderBook) {
    // 1. تحليل الأوردر بوك اللحظي ورصد حالة الجدران
    const obDynamics = this.analyzeOrderBookDynamics(trade.symbol, orderBook);

    // تعديل شرط انهيار الجدار في دالة shouldExit
    if (trade.wallPrice && netProfit > -0.3) {
      // رفعنا حد السماحية قليلاً من -0.2 إلى -0.4
      const currentWall = orderBook.bids.find(
        (b) => Math.abs(b[0] - trade.wallPrice) < trade.entryPrice * 0.0001
      );

      // بدلاً من الخروج عند 30% من الحجم، لنجعلها أكثر مرونة 20%
      if (
        !currentWall ||
        currentWall[0] * currentWall[1] < trade.initialWallVolume * 0.1
      ) {
        return { exit: true, reason: "WALL_LIQUIDITY_EVAPORATED" };
      }
    }
    // 3. ملاحقة الربح الذكية (Smart Trailing)
    // بدلاً من ATR فقط، نرفع الستوب لوز خلف جدران الدعم الجديدة التي تظهر أثناء الصعود
    if (
      obDynamics.strongWall &&
      obDynamics.strongWall.price > trade.currentStopLoss &&
      obDynamics.strongWall.price < currentPrice
    ) {
      trade.currentStopLoss = obDynamics.strongWall.price * 0.999;
      console.log(
        `🛡️ ${trade.symbol}: تم رفع حماية الستوب لوز خلف جدار جديد عند ${trade.currentStopLoss}`
      );
    }

    // 4. الخروج بناءً على الستوب لوز الحالي (المتحرك)
    if (currentPrice <= trade.currentStopLoss) {
      return {
        exit: true,
        reason:
          trade.currentStopLoss > trade.entryPrice
            ? "TRAILING_PROFIT_PROTECTION"
            : "STOP_LOSS_HIT",
      };
    }

    // 5. منطق Let Profits Run (تجاوز الهدف)
    if (currentPrice >= trade.takeProfit) {
      // إذا كان ميزان القوى (Imbalance) لا يزال قوياً جداً (> 2.0)، لا تخرج
      if (obDynamics.imbalance > 2.0) {
        trade.currentStopLoss = currentPrice * 0.995; // ضع ستوب قريب (0.5%)
        trade.takeProfit = currentPrice * 1.01; // ارفع الهدف 1% إضافي
        console.log(
          `🚀 ${trade.symbol}: السيولة جبارة! مستمرون لملاحقة أرباح أعلى...`
        );
      } else {
        return { exit: true, reason: "TAKE_PROFIT_TARGET_REACHED" };
      }
    }

    // 6. خروج "ضعف النبض" (Low Momentum)
    // إذا كنت في ربح بسيط والسيولة انقلبت فجأة ضدك (Imbalance < 0.5)
    if (netProfit > 0.15 && obDynamics.imbalance < 0.5) {
      return { exit: true, reason: "SELL_PRESSURE_DETECTED" };
    }

    // 7. إدارة الوقت (Time-Based)
    if (Date.now() - trade.entryTime > CONFIG.MAX_MONITOR_TIME) {
      return { exit: true, reason: "TIME_LIMIT_REACHED" };
    }

    return { exit: false, reason: "" };
  }

  async closeTrade(trade, exitPrice, netPnlPercent, reason) {
    const netPnlUsd = (netPnlPercent / 100) * trade.size;
    const duration = (Date.now() - trade.entryTime) / 60000;

    this.performance.trades++;
    this.performance.netProfit += netPnlUsd;
    this.performance.totalConfidence += trade.confidence;

    if (netPnlPercent > 0) {
      this.performance.wins++;
    } else {
      this.performance.losses++;
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
      trade.stopLossHistory.length - 1
    },"${trade.reasons.slice(0, 2).join(" | ")}"\n`;
    fs.appendFileSync("professional_trades.csv", log);

    // إشعار الخروج
    let emoji = "📊";
    if (reason.includes("PROFIT")) emoji = "💰";
    if (reason.includes("STOP_LOSS")) emoji = "🛑";
    if (reason.includes("TAKE_PROFIT")) emoji = "🎯";

    this.sendTelegram(
      `${emoji} *${trade.symbol} - إغلاق*\n\n` +
        `📊 ${netPnlPercent > 0 ? "+" : ""}${netPnlPercent.toFixed(2)}%\n` +
        `💸 ${netPnlUsd > 0 ? "+" : ""}$${netPnlUsd.toFixed(2)}\n` +
        `⏱️ ${duration.toFixed(1)} دقيقة\n` +
        `🛑 ${trade.stopLossHistory.length - 1} حركة ستوب\n` +
        `📝 ${this.translateReason(reason)}\n` +
        `🎯 الثقة: ${trade.confidence.toFixed(1)}%\n` +
        `🕐 ${new Date().toLocaleTimeString("ar-SA")}`
    );

    this.activeTrades = this.activeTrades.filter((t) => t.id !== trade.id);
  }

  translateReason(englishReason) {
    const reasons = {
      TRAILING_STOP_PROFIT: "تريلينج ستوب مع ربح",
      STOP_LOSS: "وصول للستوب لوز",
      TAKE_PROFIT: "تحقيق الهدف",
      MARKET_CONDITION_DETERIORATED: "تدهور ظروف السوق",
      TIME_LIMIT_PROFIT: "انتهاء الوقت مع ربح",
      TIME_LIMIT_LOSS: "انتهاء الوقت",
      WHALES_DISAPPEARED: "اختفاء الحيتان",
    };
    return reasons[englishReason] || englishReason;
  }

  async sendMonitoringReport() {
    try {
      let report = "🔍 *تقرير الرادار اللحظي المطور*\n\n";
      const validOpportunities = [];

      for (const symbol of CONFIG.SYMBOLS) {
        const orderBook = this.orderBooks[symbol];
        if (!orderBook) continue;

        const decision = this.calculateDecisionMatrix(symbol, orderBook);
        if (decision && decision.indicators) {
          validOpportunities.push({
            symbol,
            confidence: decision.confidence,
            decision,
            // نحتفظ ببيانات الأوردر بوك لهذا الرمز تحديداً
            orderBookData: this.analyzeOrderBookDynamics(symbol, orderBook),
          });
        }
      }

      if (validOpportunities.length === 0) {
        return this.sendTelegram("⏳ جاري تجميع بيانات كافية للرادار...");
      }

      // ترتيب حسب الثقة (الأعلى أولاً)
      validOpportunities.sort((a, b) => b.confidence - a.confidence);

      validOpportunities.slice(0, 5).forEach((item, index) => {
        const { symbol, confidence, decision, orderBookData } = item;
        const ind = decision.indicators;

        // إنشاء شريط بصري لقوة المشترين (Imbalance)
        const powerBar = this.generatePowerBar(orderBookData.imbalance);

        report += `${index + 1}. *${symbol}* (${confidence.toFixed(1)}%)\n`;
        report += `   ⚖️ السيولة: ${powerBar} (${orderBookData.imbalance.toFixed(
          1
        )}x)\n`;
        report += `   • RSI: ${ind.rsi.toFixed(
          1
        )} | حجم: ${ind.volumeRatio.toFixed(1)}x\n`;

        // إضافة معلومة عن الجدران إذا وجدت
        const hasWall = orderBookData.reasons.find((r) => r.includes("🧱"));
        if (hasWall) report += `   ${hasWall}\n`;

        report += `   • الحالة: ${
          confidence >= CONFIG.MIN_CONFIDENCE ? "🚀 دخول" : "📉 مراقبة"
        }\n`;
        report += `--------------------------\n`;
      });

      this.sendTelegram(report);
    } catch (error) {
      console.error("❌ خطأ في إرسال التقرير:", error.message);
    }
  }

  // دالة مساعدة لرسم ميزان القوى بصرياً
  generatePowerBar(imbalance) {
    const totalChars = 8;
    // حساب عدد المربعات الخضراء بناءً على الـ imbalance (1.0 تعادل المنتصف)
    let greenCount = Math.min(
      totalChars,
      Math.max(1, Math.floor((imbalance / 2) * totalChars))
    );
    if (imbalance > 2) greenCount = totalChars; // سيولة شراء ساحقة

    const redCount = totalChars - greenCount;
    return "🟩".repeat(greenCount) + "🟥".repeat(redCount);
  }
  // ==================== WebSocket ====================
  connectWebSockets() {
    CONFIG.SYMBOLS.forEach((symbol) => {
      this.connectSingleSymbolWS(symbol);
    });
  }
  connectSingleSymbolWS(symbol) {
    const streamName = symbol.replace("/", "").toLowerCase();
    const ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${streamName}@depth20@100ms`
    );

    // حالة صحة الـ WebSocket لكل زوج
    if (!this.wsHealth) this.wsHealth = {};
    this.wsHealth[symbol] = {
      stable: false,
      ticks: 0,
      lastUpdate: 0,
      lastBestBid: null,
    };

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data);

        // ✅ حماية من البيانات الناقصة
        if (
          !parsed.bids ||
          !parsed.asks ||
          parsed.bids.length < 10 ||
          parsed.asks.length < 10
        ) {
          return;
        }

        const bids = parsed.bids.map((b) => [Number(b[0]), Number(b[1])]);
        const asks = parsed.asks.map((a) => [Number(a[0]), Number(a[1])]);

        const bestBid = bids[0][0];
        const health = this.wsHealth[symbol];

        // ⛔ تجاهل التحديثات المتجمدة (السعر لم يتغير)
        if (health.lastBestBid === bestBid) return;

        health.lastBestBid = bestBid;
        health.lastUpdate = Date.now();
        health.ticks++;

        // ✅ نعتبر السوق مستقر بعد 3 تحديثات صحيحة
        if (health.ticks >= 3) {
          health.stable = true;
        }

        this.orderBooks[symbol] = { bids, asks };
      } catch (_) {
        // تجاهل أي خطأ parsing بدون crash
      }
    });

    ws.on("error", (err) => {
      console.error(`❌ WS Error for ${symbol}:`, err.message);
      if (this.wsHealth[symbol]) {
        this.wsHealth[symbol].stable = false;
        this.wsHealth[symbol].ticks = 0;
      }
      ws.close();
    });

    ws.on("close", () => {
      console.log(`🔄 Reconnecting WebSocket for ${symbol}...`);
      if (this.wsHealth[symbol]) {
        this.wsHealth[symbol].stable = false;
        this.wsHealth[symbol].ticks = 0;
      }
      setTimeout(() => this.connectSingleSymbolWS(symbol), 5000);
    });
  }

  // ==================== التشغيل الرئيسي ====================
  async start() {
    this.sendTelegram("🏦 *بدء النظام الاحترافي مع قاعدة بيانات SQLite*");
    // تشغيل تنظيف قاعدة البيانات كل 24 ساعة
    setInterval(async () => {
      await this.dbManager.cleanupOldData(2); // نحتفظ بآخر يومين فقط من الشموع والمؤشرات
    }, 24 * 60 * 60 * 1000);

    await this.exchange.loadMarkets();
    this.fees = {};

    for (const s of CONFIG.SYMBOLS) {
      const market = this.exchange.markets[s];
      this.fees[s] = {
        maker: market.maker || 0.001,
        taker: market.taker || 0.001,
      };
    }

    console.log("✅ الرسوم لكل رمز تم تحميلها:", this.fees);

    // تحميل البيانات التاريخية أولاً
    this.sendTelegram("📊 *جاري تحميل البيانات التاريخية...*");
    for (const symbol of CONFIG.SYMBOLS) {
      const loaded = await this.loadHistoricalData(symbol);
      if (loaded) {
        this.sendTelegram(`✅ ${symbol}: تم تحميل البيانات التاريخية`);
      } else {
        this.sendTelegram(`❌ ${symbol}: فشل تحميل البيانات`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.connectWebSockets();

    // تحديث البيانات كل دقيقة
    setInterval(async () => {
      for (const symbol of CONFIG.SYMBOLS) {
        await this.updateMarketData(symbol);
      }
    }, 60000);

    // البحث عن فرص كل 5 ثواني
    setInterval(() => {
      CONFIG.SYMBOLS.forEach((symbol) => {
        const opp = this.analyzeForEntry(symbol, this.orderBooks[symbol]);
        if (opp) this.executeTrade(opp);
      });
    }, CONFIG.UPDATE_INTERVAL);

    // إرسال تقرير إحصائي كل ساعة
    setInterval(async () => {
      const stats = await this.dbManager.getTradeStatistics();
      if (stats) {
        this.sendTelegram(
          `📈 *تقرير إحصائي كل ساعة*\n\n` +
            `📊 إجمالي الصفقات: ${stats.total_trades}\n` +
            `💰 الصفقات الرابحة: ${stats.winning_trades}\n` +
            `📉 الصفقات الخاسرة: ${stats.losing_trades}\n` +
            `📊 متوسط الربح: ${stats.avg_pnl_percent?.toFixed(2) || 0}%\n` +
            `💸 إجمالي الربح: $${stats.total_pnl_usd?.toFixed(2) || 0}\n` +
            `🎛️ متوسط الثقة: ${stats.avg_confidence?.toFixed(1) || 0}%\n` +
            `⏱️ متوسط المدة: ${
              (stats.avg_duration / 60)?.toFixed(1) || 0
            } دقيقة`
        );
      }
    }, 3600000);
    // إرسال تقرير المراقبة كل ساعة (3600000 مللي ثانية)

    setInterval(() => {
      this.sendMonitoringReport();
    }, 3600000);
    // استدعاء أول مرة فور تشغيل البوت
    this.sendMonitoringReport();

    this.sendTelegram("✅ *النظام يعمل بنجاح مع قاعدة بيانات SQLite*");
  }
}

process.on("SIGINT", async () => {
  const bot = global.botInstance;
  if (bot && bot.tgBot) {
    const stats = await bot.dbManager.getTradeStatistics();

    await bot.sendTelegram(
      `🛑 *إغلاق النظام الاحترافي*\n\n` +
        `📊 إجمالي الصفقات: ${bot.performance.trades}\n` +
        `💰 الربح الصافي: $${bot.performance.netProfit.toFixed(2)}\n` +
        `🏆 النجاح: ${bot.performance.wins}/${bot.performance.trades}\n` +
        `🎛️ متوسط الثقة: ${(
          bot.performance.totalConfidence / (bot.performance.trades || 1)
        ).toFixed(1)}%\n\n` +
        `💾 *بيانات قاعدة البيانات:*\n` +
        `📈 إجمالي السجلات: ${stats?.total_trades || 0}\n` +
        `📊 متوسط الربح: ${stats?.avg_pnl_percent?.toFixed(2) || 0}%\n` +
        `⏱️ ${new Date().toLocaleTimeString("ar-SA")}`
    );
  }
  setTimeout(() => process.exit(0), 1000);
});

const bot = new ProfessionalTradingSystem();
global.botInstance = bot;
bot.start();
