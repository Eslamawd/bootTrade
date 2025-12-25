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
    "MATIC/USDT",
    "DOT/USDT",
    "LTC/USDT",
  ],
  MAX_CONCURRENT_TRADES: 3,
  UPDATE_INTERVAL: 5000, // أبطأ قليلاً لإعطاء فرصة لتحليل البيانات
  MAX_MONITOR_TIME: 7200000, // ساعتين كحد أقصى
  COOLDOWN_TIME: 300000, // 5 دقائق

  // إعدادات المؤشرات
  CANDLE_LIMIT: 100,
  TIMEFRAME: "5m",

  // إعدادات مصفوفة القرار
  MIN_CONFIDENCE: 30,
  MAX_RSI_ENTRY: 70,
  MIN_VOLUME_RATIO: 0.8,
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

    // 1. ضمان الترتيب الصحيح للبيانات قبل أي حسابات
    const sortedCandles = [...candles].sort((a, b) => a[0] - b[0]);

    // 2. استبعاد الشمعة الحالية "قيد التكوين" لضمان دقة الحجم
    const completedCandles = sortedCandles.slice(0, -1);

    const closes = completedCandles.map((c) => c[4]);
    const highs = completedCandles.map((c) => c[2]);
    const lows = completedCandles.map((c) => c[3]);
    const volumes = completedCandles.map((c) => c[5]);

    try {
      // حساب RSI
      const rsiValues = TI.RSI.calculate({ values: closes, period: 14 });
      const currentRSI = rsiValues[rsiValues.length - 1];

      // حساب ATR
      const atrValues = TI.ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
      });
      const currentATR = atrValues[atrValues.length - 1];

      // --- حساب الحجم بدقة فائقة ---
      const volumeMA20 = TI.SMA.calculate({ values: volumes, period: 20 });
      const currentVolumeMA = volumeMA20[volumeMA20.length - 1] || 1; // حماية من القسمة على صفر
      const lastCompletedVolume = volumes[volumes.length - 1] || 0;

      // النسبة الحقيقية
      const volumeRatio = lastCompletedVolume / currentVolumeMA;

      // طباعة تصحيحية تظهر فقط في الـ logs إذا كان الحجم مشكوك فيه
      if (volumeRatio < 0.2) {
        console.log(
          `⚠️ [DEBUG] ${symbol}: حجم ضعيف جداً! (آخر حجم: ${lastCompletedVolume.toFixed(
            0
          )}, المتوسط: ${currentVolumeMA.toFixed(0)})`
        );
      }

      // باقي المؤشرات
      const sma50Values = TI.SMA.calculate({ values: closes, period: 50 });
      const sma200Values = TI.SMA.calculate({ values: closes, period: 200 });
      const lastMACD = TI.MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      }).pop();

      const lastBB = TI.BollingerBands.calculate({
        values: closes,
        period: 20,
        stdDev: 2,
      }).pop();

      return {
        rsi: currentRSI,
        atr: currentATR,
        sma50: sma50Values.pop(),
        sma200: sma200Values.pop(),
        volumeMA20: currentVolumeMA,
        currentVolume: lastCompletedVolume,
        volumeRatio,
        macd: lastMACD?.MACD || 0,
        macdSignal: lastMACD?.signal || 0,
        macdHistogram: lastMACD?.histogram || 0,
        bollingerUpper: lastBB?.upper || 0,
        bollingerLower: lastBB?.lower || 0,
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
    if (!indicators) {
      return { confidence: 0, reasons: ["❌ بيانات غير كافية"] };
    }

    let totalScore = 0;
    const reasons = [];
    const warnings = [];

    // 1. RSI Analysis (25 نقطة)
    if (indicators.rsi >= 40 && indicators.rsi <= CONFIG.MAX_RSI_ENTRY) {
      totalScore += 30;
      reasons.push(`📈 RSI مثالي (${indicators.rsi.toFixed(1)})`);
    } else if (indicators.rsi < 40) {
      totalScore += 15;
      reasons.push(`📉 RSI منخفض (${indicators.rsi.toFixed(1)}) - فرصة`);
    } else if (indicators.rsi > 72 && indicators.rsi <= 80) {
      totalScore += 5;
      warnings.push(`⚠️ RSI مرتفع (${indicators.rsi.toFixed(1)})`);
    } else if (indicators.rsi > 75) {
      totalScore -= 20;
      warnings.push(`🚨 RSI متشبع شراء (${indicators.rsi.toFixed(1)})`);
    }

    // 2. Volume Analysis (20 نقطة)
    if (indicators.volumeRatio >= 1.5) {
      totalScore += 20;
      reasons.push(`📊 انفجار حجم (${indicators.volumeRatio.toFixed(1)}x)`);
    } else if (indicators.volumeRatio >= 1.1) {
      totalScore += 15;
      reasons.push(`📈 حجم مرتفع (${indicators.volumeRatio.toFixed(1)}x)`);
    } else if (indicators.volumeRatio < 0.8) {
      totalScore -= 10;
      warnings.push(`📉 حجم منخفض (${indicators.volumeRatio.toFixed(1)}x)`);
    }

    // 3. Whale Analysis (30 نقطة)
    const whaleAnalysis = this.analyzeWhales(symbol, orderBook);
    totalScore += whaleAnalysis.score;
    reasons.push(...whaleAnalysis.reasons);
    warnings.push(...whaleAnalysis.warnings);

    // 4. Trend Analysis (15 نقطة)
    if (indicators.sma50 > indicators.sma200) {
      totalScore += 15;
      reasons.push(`📈 اتجاه صاعد (SMA50 > SMA200)`);
    } else if (indicators.sma50 < indicators.sma200) {
      totalScore -= 10;
      warnings.push(`📉 اتجاه هابط (SMA50 < SMA200)`);
    }

    // 5. MACD Analysis (10 نقطة)
    if (
      indicators.macd > indicators.macdSignal &&
      indicators.macdHistogram > 0
    ) {
      totalScore += 10;
      reasons.push(`🔷 MACD إيجابي`);
    } else if (indicators.macd < indicators.macdSignal) {
      totalScore -= 5;
      warnings.push(`🔶 MACD سلبي`);
    }

    // 6. Liquidity Analysis (المتبقي)
    const spread =
      (orderBook.asks[0][0] - orderBook.bids[0][0]) / orderBook.bids[0][0];
    if (spread < 0.0005) {
      totalScore += 10;
      reasons.push(`⚡ سيولة عالية (سبريد ${(spread * 100).toFixed(3)}%)`);
    }

    const confidence = Math.max(0, Math.min(100, totalScore));

    return {
      confidence,
      reasons,
      warnings,
      indicators,
      whaleAnalysis,
      totalScore,
    };
  }

  analyzeWhales(symbol, orderBook) {
    if (!orderBook || !orderBook.bids)
      return { score: 0, reasons: [], warnings: [], whales: [] };

    // حساب العتبة الديناميكية
    const volData =
      this.volumeHistory && this.volumeHistory[symbol]
        ? this.volumeHistory[symbol].avgVolume
        : 0;
    const dynamicThreshold =
      volData > 0 ? Math.max(20000, volData * 0.005) : 50000;

    let score = 0;
    const reasons = [];
    const warnings = [];
    const whales = [];

    // فحص الأوردر بوك
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

    // توزيع النقاط
    if (whales.length >= 3) {
      score += 30;
      reasons.push(
        `🐋🐋🐋 ${whales.length} حيتان فوق عتبة $${(
          dynamicThreshold / 1000
        ).toFixed(0)}K`
      );
    } else if (whales.length > 0) {
      score += 15;
      reasons.push(`🐋 رصد ${whales.length} حوت نشط`);
    }

    if (whales.filter((w) => w.position <= 5).length >= 2) {
      score += 15;
      reasons.push(`🛡️ جدار حماية قوي في أول 5 مستويات`);
    }

    // --- الربط مع قاعدة البيانات (الجزء الجديد) ---
    const whaleData = {
      count: whales.length,
      largestValue:
        whales.length > 0 ? Math.max(...whales.map((w) => w.value)) : 0,
      avgValue:
        whales.length > 0
          ? whales.reduce((a, b) => a + b.value, 0) / whales.length
          : 0,
      positions: whales.map((w) => w.position),
      powerScore: score,
    };

    // استدعاء الحفظ (بدون انتظار await لعدم تعطيل سرعة التحليل)
    this.dbManager.saveWhaleSighting(symbol, whaleData).catch((e) => {});

    return { score, reasons, warnings, whales, dynamicThreshold };
  }
  // ==================== تحليل الفرص ====================
  analyzeForEntry(symbol, orderBook) {
    // فحصات أساسية
    if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) return null;
    if (this.activeTrades.some((t) => t.symbol === symbol)) return null;
    if (
      this.cooldowns[symbol] &&
      Date.now() - this.cooldowns[symbol] < CONFIG.COOLDOWN_TIME
    )
      return null;
    if (!orderBook || !orderBook.bids || !orderBook.asks) return null;

    // التأكد من وجود بيانات تاريخية
    if (
      !this.marketData[symbol] ||
      this.marketData[symbol].candles.length < 50
    ) {
      console.log(`⏳ ${symbol}: جاري جمع البيانات التاريخية...`);
      return null;
    }

    // مصفوفة القرار
    const decision = this.calculateDecisionMatrix(symbol, orderBook);

    // شروط صارمة للدخول
    if (decision.confidence < CONFIG.MIN_CONFIDENCE) return null;

    const indicators = decision.indicators;
    if (indicators.rsi > CONFIG.MAX_RSI_ENTRY) {
      console.log(
        `⏹️ ${symbol}: RSI مرتفع جداً (${indicators.rsi.toFixed(1)})`
      );
      return null;
    }

    if (indicators.volumeRatio < CONFIG.MIN_VOLUME_RATIO) {
      console.log(
        `⏹️ ${symbol}: حجم منخفض (${indicators.volumeRatio.toFixed(1)}x)`
      );
      return null;
    }

    const entryPrice = orderBook.asks[0][0];

    // حساب أهداف ديناميكية
    const targets = this.calculateDynamicTargets(
      entryPrice,
      indicators,
      decision.confidence
    );
    if (targets.riskRewardRatio < 0.8) {
      console.log(
        `⏹️ ${symbol}: نسبة ربح/مخاطرة ضعيفة (${targets.riskRewardRatio.toFixed(
          2
        )})`
      );
      return null;
    }

    return {
      symbol,
      entryPrice,
      stopLoss: targets.stopLoss,
      takeProfit: targets.takeProfit,
      confidence: decision.confidence,
      reasons: decision.reasons,
      warnings: decision.warnings,
      indicators,
      whaleAnalysis: decision.whaleAnalysis,
      targets,
      entryTime: Date.now(),
    };
  }
  calculateDynamicTargets(entryPrice, indicators, confidence) {
    // 1. تقليل الـ ATR الافتراضي ليكون أكثر واقعية للمضاربة السريعة
    const atr = indicators.atr || entryPrice * 0.008;

    // 2. تقليل معامل الستوب لوز (Stop Loss)
    // بدلاً من 2.8x ATR، سنستخدم 1.5x لجعل الستوب أقرب واحترافي
    const stopLossDistance = atr * (confidence > 70 ? 1.2 : 1.5);
    const stopLoss = entryPrice - stopLossDistance;

    // 3. زيادة معامل التيك بروفيت (Take Profit)
    // نستخدم 2.5x ATR لضمان نسبة ربح لمخاطرة (RR) أكبر من 1.5
    const takeProfitDistance = atr * 3.0;
    const takeProfit = entryPrice + takeProfitDistance;

    // 4. تعديل حدود الحماية "الواقعية"
    // السماح بوقف خسارة حتى 2% فقط، وجني أرباح يصل لـ 6%
    const minStopLoss = entryPrice * 0.98;
    const maxTakeProfit = entryPrice * 1.06;

    // اختيار الأسعار (استخدام Math.max للستوب لضمان عدم بعده عن 2%)
    const finalStopLoss = Math.max(stopLoss, minStopLoss);
    const finalTakeProfit = Math.min(takeProfit, maxTakeProfit);

    const riskRewardRatio =
      (finalTakeProfit - entryPrice) / (entryPrice - finalStopLoss);

    return {
      stopLoss: finalStopLoss,
      takeProfit: finalTakeProfit,
      riskRewardRatio,
      atrBased: indicators.atr ? true : false,
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
      const tradeSize = myBalance / CONFIG.MAX_CONCURRENT_TRADES;

      const trade = {
        id: `TRADE_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        symbol: opportunity.symbol,
        entryPrice: opportunity.entryPrice,
        entryTime: opportunity.entryTime,
        size: tradeSize,
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
      const netProfit = currentProfit - 0.2; // بعد العمولات

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
    // 1. الخروج بناءً على الستوب لوز (المحرك بواسطة ATR)
    // هذا الشرط هو الذي سيخرجنا بربح إذا تجاوزنا الهدف ثم بدأ السعر بالانعكاس
    if (currentPrice <= trade.currentStopLoss) {
      return {
        exit: true,
        reason:
          trade.currentStopLoss > trade.entryPrice
            ? "ATR_TRAILING_STOP_PROFIT"
            : "STOP_LOSS",
      };
    }

    // 2. منطق تجاوز الهدف (Let Profits Run)
    if (currentPrice >= trade.takeProfit) {
      // بدلاً من الخروج، نقوم بـ "حجز" الربح ورفع السقف
      // نضع ستوب لوز جديد قريب جداً (مثلاً نصف مسافة ATR تحت السعر الحالي)
      const tightStop = currentPrice - trade.atr * 0.5;

      if (tightStop > trade.currentStopLoss) {
        trade.currentStopLoss = tightStop;
        // نرفع الهدف ليكون أعلى بـ 2x ATR من السعر الحالي لنعطي مساحة للنمو
        trade.takeProfit = currentPrice + trade.atr * 2;

        console.log(
          `🚀 ${
            trade.symbol
          }: تم تجاوز الهدف! جاري ملاحقة السعر عند ${currentPrice.toFixed(4)}`
        );
        // ملاحظة: لا نرسل { exit: true } هنا لكي تستمر العملية
      }
    }

    // 3. تحليل السوق اللحظي (Decision Matrix)
    const currentDecision = this.calculateDecisionMatrix(
      trade.symbol,
      orderBook
    );
    // إذا تدهورت المؤشرات الفنية (RSI, Volume) ونحن في ربح، نخرج فوراً لتأمين الربح
    if (currentDecision.confidence < 35 && netProfit > 0.2) {
      return { exit: true, reason: "MARKET_DETERIORATED" };
    }

    // 4. إدارة الوقت (Time-Based Exit)
    if (Date.now() - trade.entryTime > CONFIG.MAX_MONITOR_TIME) {
      return {
        exit: true,
        reason: netProfit >= 0 ? "TIME_LIMIT_PROFIT" : "TIME_LIMIT_LOSS",
      };
    }

    // 5. مراقبة سيولة الحيتان
    const currentWhales = this.analyzeWhales(trade.symbol, orderBook);
    if (currentWhales.score < 10 && netProfit > 0.1) {
      return { exit: true, reason: "WHALES_DISAPPEARED" };
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
      let report = "🔍 *تقرير الرادار اللحظي*\n\n";
      const validOpportunities = [];

      for (const symbol of CONFIG.SYMBOLS) {
        const orderBook = this.orderBooks[symbol];
        if (!orderBook) continue;

        const decision = this.calculateDecisionMatrix(symbol, orderBook);
        // التأكد من وجود البيانات قبل القراءة
        if (decision && decision.indicators) {
          validOpportunities.push({
            symbol,
            confidence: decision.confidence,
            decision,
          });
        }
      }

      if (validOpportunities.length === 0) {
        return this.sendTelegram("⏳ جاري تجميع بيانات كافية للرادار...");
      }

      // ترتيب حسب الثقة
      validOpportunities.sort((a, b) => b.confidence - a.confidence);

      validOpportunities.slice(0, 3).forEach((item, index) => {
        const { symbol, confidence, decision } = item;
        const ind = decision.indicators;
        report += `${index + 1}. *${symbol}* (${confidence.toFixed(1)}%)\n`;
        report += `   • RSI: ${ind.rsi.toFixed(
          1
        )} | حجم: ${ind.volumeRatio.toFixed(1)}x\n`;
        report += `   • الحالة: ${
          confidence >= CONFIG.MIN_CONFIDENCE ? "🟢 جاهز" : "🟡 مراقبة"
        }\n`;
        report += `------------------\n`;
      });

      this.sendTelegram(report);
    } catch (error) {
      console.error("❌ خطأ في إرسال التقرير:", error.message);
    }
  }

  // ==================== WebSocket ====================
  connectWebSockets() {
    CONFIG.SYMBOLS.forEach((symbol) => {
      const ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${symbol
          .replace("/", "")
          .toLowerCase()}@depth20@100ms`
      );

      ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data);
          this.orderBooks[symbol] = {
            bids: parsed.bids.map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
            asks: parsed.asks.map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
          };
        } catch (error) {}
      });

      ws.on("error", () => {});
      ws.on("close", () => setTimeout(() => this.connectWebSockets(), 5000));
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
