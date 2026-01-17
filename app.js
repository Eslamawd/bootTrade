const ccxt = require("ccxt");
const WebSocket = require("ws");
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const TI = require("technicalindicators");
const DatabaseManager = require("./DatabaseManager");
require("dotenv").config();

const CONFIG = {
  SYMBOLS: [
    "BTC/USDT", // الرئيسي - أعلى سيولة
    "BNB/USDT", // منصة Binance - عالية السيولة
    "SOL/USDT",
    "ETH/USDT", // الرئيسي الثاني - سيولة ممتازة
    "DOT/USDT",
    "ADA/USDT",
    "DOGE/USDT", // متقلب وشائع
    "XRP/USDT", // متقلب مع حجم جيد
    "MATIC/USDT", // جيد للمضاربة قصيرة المدى
    "1000CAT/USDT",
    "0G/USDT",
    "1000CHEEMS/USDT",
  ],
  MAX_CONCURRENT_TRADES: 5,
  MAX_SPREAD: 0.0012, // 0.12% أقصى سبريد مقبول
  UPDATE_INTERVAL: 30000, // أبطأ قليلاً لإعطاء فرصة لتحليل البيانات
  MAX_MONITOR_TIME: 120 * 60, // ساعتين كحد أقصى
  COOLDOWN_TIME: 600000, // 5 دقائق

  // إعدادات المؤشرات
  CANDLE_LIMIT: 300,
  TIMEFRAME: "15m",

  // إعدادات مصفوفة القرار
  MIN_CONFIDENCE: 83,
  MAX_RSI_ENTRY: 60,
  MIN_VOLUME_RATIO: 1.8,
};

class ProfessionalTradingSystem {
  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
    });

    this.fees = {};
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
        CONFIG.CANDLE_LIMIT,
      );

      if (dbCandles && dbCandles.length >= 220) {
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
          `📊 ${symbol}: تم تحميل ${candles.length} شمعة من قاعدة البيانات`,
        );
        return true;
      }

      // إذا البيانات غير كافية في قاعدة البيانات، نطلب من Binance
      console.log(`📊 ${symbol}: جلب بيانات تاريخية من Binance...`);
      const freshCandles = await this.exchange.fetchOHLCV(
        symbol,
        CONFIG.TIMEFRAME,
        undefined,
        CONFIG.CANDLE_LIMIT,
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
        5,
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
  async calculateTechnicalIndicators(symbol) {
    if (!this.marketData[symbol] || !this.marketData[symbol].candles)
      return null;

    const candles = this.marketData[symbol].candles;
    if (candles.length < 220) return null;

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

      const candles48h = this.marketData[symbol].candles.slice(-96); // 96 شمعة (15د) تساوي 24 ساعة
      const low24h = Math.min(...candles48h.map((c) => c[3])); // أقل سعر
      const high24h = Math.max(...candles48h.map((c) => c[2])); // أعلى سعر

      const currentPrice = candles[candles.length - 1][4];
      const range = high24h - low24h || 1;
      const pricePosition = ((currentPrice - low24h) / range) * 100;

      await this.dbManager.saveTechnicalIndicators(symbol, {
        rsi: currentRSI,
        prevRsi: prevRSI,
        rsiSMA20: currentRsiSMA,
        close: lastClose,
        atr: currentATR,
        prevClose: prevClose,
        volumeRatio,
        avgVolume,
        sma50: sma50Values[sma50Values.length - 1],
        sma200: sma200Values[sma200Values.length - 1],
        pricePosition,
      });

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
        pricePosition,
      };
    } catch (error) {
      console.error(`❌ خطأ في حساب المؤشرات لـ ${symbol}:`, error.message);
      return null;
    }
  }
  // ==================== مصفوفة القرار المحدثة ====================
  async calculateDecisionMatrix(symbol, orderBook) {
    const indicators = await this.calculateTechnicalIndicators(symbol);
    if (!indicators) return { confidence: 0, reasons: ["❌ بيانات غير كافية"] };

    let totalScore = 0;
    const reasons = [];
    const warnings = [];
    const pricePosition = indicators.pricePosition;

    if (pricePosition <= 15) {
      totalScore += 15; // مرحلة القاع
      reasons.push(
        `💎 السعر في أدنى 15% من نطاق الـ 24 ساعة (${pricePosition.toFixed(
          1,
        )}%)`,
      );
    } else if (pricePosition <= 60) {
      totalScore += 5;
      reasons.push(
        `💎 السعر في أدنى 60% من نطاق الـ 24 ساعة (${pricePosition.toFixed(
          1,
        )}%)`,
      );
    } else if (pricePosition >= 70) {
      totalScore -= 20; // مرحلة القمة
      warnings.push(
        `⚠️ السعر متضخم وقريب من أعلى سعر يومي (${pricePosition.toFixed(1)}%)`,
      );
    }

    // --- 1. Order Book Dynamics (السيولة اللحظية) ---
    const ob = this.analyzeOrderBookDynamics(symbol, orderBook);
    totalScore += ob.score;
    reasons.push(...ob.reasons);

    // --- 2. Dynamic RSI (نسبة القوة النسبية المتكيفة) ---
    // فكرة: هل الـ RSI الحالي أقل من متوسط الـ RSI لآخر فترة؟ (يعني العملة رخيصة حالياً)
    const rsiSMA = indicators.rsiSMA20 || 50; // سنحتاج لإضافة rsiSMA في حساب المؤشرات
    const rsiDiff = indicators.rsi - rsiSMA;

    if (indicators.rsi < 40 && rsiDiff < -5) {
      // الـ RSI الحالي أقل من المتوسط بـ 5 درجات (فرصة شراء)
      totalScore += 20;
      reasons.push(
        `📉 RSI دايناميك: تحت المتوسط بـ ${Math.abs(rsiDiff).toFixed(
          1,
        )} (تجميع)`,
      );
    } else if (rsiDiff > 15) {
      totalScore -= 15;
      warnings.push("🚨 RSI دايناميك: تضخم سعري مقارنة بالمتوسط");
    }

    /// --- 3. Smart Volume Explosion ---
    if (
      indicators.volumeRatio > 2.2 &&
      orderBook.bids[0][0] * orderBook.bids[0][1] >
        indicators.avgVolume * indicators.close * 0.01
    ) {
      // فوليوم + اتجاه + RSI صحي
      if (
        indicators.close > indicators.prevClose &&
        indicators.rsi > 35 &&
        indicators.rsi < 60
      ) {
        totalScore += 22;
        reasons.push(
          `🔥 انفجار فوليوم ذكي (${indicators.volumeRatio.toFixed(1)}x)`,
        );
      }

      // فوليوم ضد الاتجاه → توزيع / تصريف
      else if (indicators.close < indicators.prevClose && indicators.rsi > 55) {
        totalScore -= 10;
        reasons.push(`⚠️ فوليوم تصريفي محتمل`);
      }
    }

    // --- 4. Whale Power (قوة الحيتان) ---
    const whales = this.analyzeWhales(symbol, orderBook, indicators);

    totalScore += whales.score;
    reasons.push(...whales.reasons);

    // --- 5. Volatility Context (سياق التقلب) ---
    const regime = this.detectMarketRegime(indicators);

    if (regime === "RANGE") totalScore -= 15;
    if (regime === "DOWNTREND") totalScore -= 30;
    if (regime === "UPTREND") totalScore += 10;

    // لو الـ ATR عالي جداً مقارنة بالسعر، ده معناه Risk عالي
    const volatilityPct = (indicators.atr / indicators.close) * 100;
    if (volatilityPct > 3) {
      // تقلب أعنف من 3% في الشمعة الواحدة
      totalScore -= 15;
      warnings.push(
        `⚡ تقلب مرتفع جداً (${volatilityPct.toFixed(2)}%) - خطر عالٍ`,
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

    // --- 7. تحليل الشموع اليابانية (الإضافة الجديدة) ---
    const candleAnalysis = await this.isPriceReversing(symbol, indicators);
    if (candleAnalysis && candleAnalysis.isValid) {
      totalScore += candleAnalysis.score;
      reasons.push(
        `🕯️ نمط شمعي: ${candleAnalysis.pattern} (+${candleAnalysis.score} نقطة)`,
      );

      // إذا كان النمط قوي جداً، نخفض الحد الأدنى للثقة
      if (candleAnalysis.score >= 30) {
        reasons.push(`💎 إشارة انعكاس قوية جداً`);
      }
    }

    const confidence = Math.max(0, Math.min(100, Math.round(totalScore)));

    return {
      confidence,
      reasons,
      warnings,
      indicators,
      whaleAnalysis: whales,
      volatility: volatilityPct,
      pricePosition,
    };
  }
  // ==================== دوال تحليل الشموع اليابانية ====================

  // 1. دالة الكشف عن المطرقة (Hammer)
  isHammerCandle(candle) {
    if (!candle || candle.length < 5) return false;

    const open = candle[1];
    const high = candle[2];
    const low = candle[3];
    const close = candle[4];

    const body = Math.abs(close - open);
    const lowerWick = Math.min(open, close) - low;
    const upperWick = high - Math.max(open, close);
    const totalRange = high - low;

    if (totalRange === 0) return false;

    // شروط المطرقة: ذيل سفلي طويل (أقل من 3 مرات الجسم)، جسم صغير
    const isSmallBody = body / totalRange < 0.3;
    const isLongLowerWick = lowerWick > body * 2;
    const isShortUpperWick = upperWick < body * 0.5;

    return isSmallBody && isLongLowerWick && isShortUpperWick;
  }

  // 2. دالة الكشف عن الابتلاع الصاعد (Bullish Engulfing)
  isBullishEngulfing(prevCandle, currentCandle) {
    if (
      !prevCandle ||
      !currentCandle ||
      prevCandle.length < 5 ||
      currentCandle.length < 5
    )
      return false;

    const prevOpen = prevCandle[1];
    const prevClose = prevCandle[4];
    const currentOpen = currentCandle[1];
    const currentClose = currentCandle[4];

    // الشمعة السابقة هابطة (أحمر)
    const isPrevBearish = prevClose < prevOpen;
    // الشمعة الحالية صاعدة (أخضر)
    const isCurrentBullish = currentClose > currentOpen;
    // جسم الشمعة الحالية يبتلع جسم الشمعة السابقة
    const isEngulfing = currentOpen < prevClose && currentClose > prevOpen;

    return isPrevBearish && isCurrentBullish && isEngulfing;
  }

  // 3. دالة الكشف عن نجمة الصباح (Morning Star)
  isMorningStar(firstCandle, secondCandle, thirdCandle) {
    if (!firstCandle || !secondCandle || !thirdCandle) return false;

    const firstOpen = firstCandle[1];
    const firstHigh = firstCandle[2];
    const firstLow = firstCandle[3];
    const firstClose = firstCandle[4];

    const secondOpen = secondCandle[1];
    const secondHigh = secondCandle[2];
    const secondLow = secondCandle[3];
    const secondClose = secondCandle[4];

    const thirdOpen = thirdCandle[1];
    const thirdClose = thirdCandle[4];

    // الشمعة الأولى: هابطة طويلة
    const firstBody = Math.abs(firstClose - firstOpen);
    const firstRange = firstHigh - firstLow;
    const isFirstLongBearish =
      firstClose < firstOpen && firstBody / firstRange > 0.6 && firstBody > 0; // تأكد أن الجسم ليس صفر

    // الشمعة الثانية: جسم صغير (نجمة) وفجوة هبوطية
    const secondBody = Math.abs(secondClose - secondOpen);
    const secondRange = secondHigh - secondLow;
    const isSecondSmall = secondRange > 0 && secondBody / secondRange < 0.3;

    // فجوة هبوطية: ارتفاع الشمعة الثانية أقل من إغلاق الأولى
    const isGapDown = secondHigh < firstClose;

    // الشمعة الثالثة: صاعدة وتغلق فوق منتصف جسم الشمعة الأولى
    const isThirdBullish = thirdClose > thirdOpen;
    const firstMid = (firstOpen + firstClose) / 2;
    const closesAboveFirstMid = thirdClose > firstMid;

    return (
      isFirstLongBearish &&
      isSecondSmall &&
      isGapDown &&
      isThirdBullish &&
      closesAboveFirstMid
    );
  }

  // 4. دالة الكشف عن الدوجي (Doji)
  isDojiCandle(candle) {
    if (!candle || candle.length < 5) return false;

    const open = candle[1];
    const close = candle[4];
    const high = candle[2];
    const low = candle[3];

    const body = Math.abs(close - open);
    const range = high - low;

    if (range === 0) return false;

    // الدوجي: جسم صغير جداً (أقل من 10% من المدى)
    return body / range < 0.1;
  }

  // ==================== دالة محسنة لاكتشاف الارتداد ====================
  async isPriceReversing(symbol, indicators) {
    const candles = this.marketData[symbol]?.candles;
    if (!candles || candles.length < 5) return false;

    // نحتاج آخر 3 شمعات مكتملة
    const completedCandles = candles.slice(-4, -1);
    if (completedCandles.length < 3) return false;

    const first = completedCandles[0]; // الأقدم
    const second = completedCandles[1]; // الوسطى
    const third = completedCandles[2]; // الأحدث

    // الكشف عن الأنماط
    const patterns = {
      hammer: this.isHammerCandle(third),
      bullishEngulfing: this.isBullishEngulfing(second, third),
      morningStar: this.isMorningStar(first, second, third),
      doji: this.isDojiCandle(third),
    };

    // تحقق من وجود نمط انعكاسي قوي
    if (patterns.hammer || patterns.bullishEngulfing || patterns.morningStar) {
      // جلب بيانات RSI للتأكيد
      if (indicators && indicators.rsi < 40) {
        // وجود نمط انعكاسي + RSI في منطقة ذروة البيع = إشارة قوية
        const patternName = patterns.morningStar
          ? "نجمة الصباح"
          : patterns.bullishEngulfing
            ? "الابتلاع الصاعد"
            : patterns.hammer
              ? "المطرقة"
              : "الدوجي";

        console.log(
          `✅ ${symbol}: اكتشاف نمط انعكاسي (${patternName}) مع RSI ${indicators.rsi.toFixed(1)}`,
        );
        return {
          isValid: true,
          pattern: patternName,
          score: patterns.morningStar
            ? 35
            : patterns.bullishEngulfing
              ? 30
              : patterns.hammer
                ? 25
                : patterns.doji
                  ? 15
                  : 0,
        };
      }
    }

    return false;
  }

  checkPriceStability(symbol, supportPrice) {
    const candles = this.marketData[symbol]?.candles;
    if (!candles || candles.length < 3) return false;

    // آخر شمعتين مكتملتين
    const last2 = candles.slice(-3, -1);

    return last2.every(
      (c) => c[3] >= supportPrice * 0.998, // الذيل ماكسرش الدعم
    );
  }
  detectMarketRegime(ind) {
    const volatility = ind.atr / ind.close;
    const trendStrength = Math.abs(ind.sma50 - ind.sma200) / ind.close;

    if (volatility > 0.035) return "HIGH_VOLATILITY";
    if (trendStrength < 0.004) return "RANGE";
    if (ind.close > ind.sma50 && ind.sma50 > ind.sma200) return "UPTREND";
    if (ind.close < ind.sma50 && ind.sma50 < ind.sma200) return "DOWNTREND";

    return "TRANSITION";
  }

  analyzeWhales(symbol, orderBook, indicators) {
    const avgVolume = indicators.avgVolume;
    if (!orderBook || !orderBook.bids)
      return { score: 0, reasons: [], warnings: [], whales: [] };

    if (!this.volumeHistory) this.volumeHistory = {};

    this.volumeHistory[symbol] = { avgVolume };

    const dynamicThreshold = Math.min(
      Math.max(indicators.close * avgVolume * 0.001, 20000),
      indicators.close * avgVolume * 0.02,
    );

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

    if (whales.length >= 10) {
      score += 20;
      reasons.push(`🐋🐋🐋 ${whales.length} حيتان نشطة`);
    } else if (whales.length > 0) {
      score += 2.5 * whales.length;
      reasons.push(`🐋 رصد ${whales.length} حوت`);
    }

    // هؤلاء هم الحيتان الذين سيتنفذ أمرهم فوراً إذا نزل السعر قليلاً
    const frontLineWhales = whales.filter((w) => w.position <= 3).length;
    if (frontLineWhales >= 1) {
      score += 5;
      reasons.push("🛡️ حوت هجومي في الخط الأول (دعم مباشر)");
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
    if (!orderBook?.bids || !orderBook?.asks || orderBook.bids.length < 15) {
      return { score: 0, imbalance: 0, reasons: [], strongWall: null };
    }

    // 1. حساب الاختلال (Imbalance) بدقة
    const bidVolume = orderBook.bids
      .slice(0, 15)
      .reduce((s, b) => s + b[0] * b[1], 0);
    const askVolume = orderBook.asks
      .slice(0, 15)
      .reduce((s, a) => s + a[0] * a[1], 0);
    const imbalance = askVolume > 0 ? bidVolume / askVolume : 0;

    let score = 0;
    const reasons = [];

    if (imbalance > 2.5 && imbalance <= 8) {
      score += 20;
      reasons.push(`🌊 سيولة شراء (Imbalance: ${imbalance.toFixed(1)}x)`);
    } else if (imbalance > 8) {
      score += 5;
    }

    // 2. تحديد عتبة الجدار الديناميكية
    let wallThreshold = 100000;
    if (symbol.includes("BTC")) wallThreshold = 1500000;
    else if (symbol.includes("ETH")) wallThreshold = 700000;
    else if (symbol.includes("SOL")) wallThreshold = 250000;

    // 3. تحليل "تكتل السيولة" (Liquidity Cluster Analysis)
    // بدلاً من البحث عن أكبر جدار، سنبحث عن المنطقة التي يتركز فيها المال
    let bestCluster = { price: 0, volume: 0, count: 0 };

    // نمر على أول 10 مستويات فقط (المنطقة الأكثر تأثيراً)
    for (let i = 0; i < 10; i++) {
      const price = orderBook.bids[i][0];
      const volume = price * orderBook.bids[i][1];

      // إذا وجدنا جداراً قوياً، نبحث عن السيولة المحيطة به في نطاق 0.1%
      if (volume > wallThreshold * 0.7) {
        let clusterVol = 0;
        let clusterCount = 0;

        orderBook.bids.slice(0, 15).forEach((b) => {
          if (Math.abs(b[0] - price) / price < 0.001) {
            // نطاق 0.1%
            clusterVol += b[0] * b[1];
            clusterCount++;
          }
        });

        if (clusterVol > bestCluster.volume) {
          bestCluster = { price, volume: clusterVol, count: clusterCount };
        }
      }
    }

    // 4. تقييم التكتل
    if (bestCluster.volume > wallThreshold) {
      score += 20;
      const formattedVol = (bestCluster.volume / 1000).toFixed(0) + "K";
      reasons.push(
        `🧱 تكتل سيولة (${bestCluster.count} جدران) بقوة $${formattedVol}`,
      );
    }

    return {
      score,
      imbalance,
      reasons,
      strongWall: bestCluster.volume > 0 ? bestCluster : null,
    };
  }
  // ==================== تحليل الفرص ====================
  async analyzeForEntry(symbol, orderBook) {
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

    // ✅ فلتر الثبات الزمني (خلف أقوى جدار)
    if (obAnalysis?.strongWall?.price) {
      const stable = this.checkPriceStability(
        symbol,
        obAnalysis.strongWall.price,
      );
      if (!stable) return null;
    }

    /* ───────────────
     3️⃣ Decision Matrix
  ─────────────── */

    const decision = await this.calculateDecisionMatrix(symbol, orderBook);

    // ✅ فلتر الثبات الزمني

    if (!decision || decision.confidence < CONFIG.MIN_CONFIDENCE) return null;

    const pricePosition = decision.pricePosition || 50;
    const indicators = decision.indicators;

    /* ───────────────
     4️⃣ فلاتر صارمة
  ─────────────── */

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
          1,
        )}x\nWhales: ${decision.whaleAnalysis.whales.length}`,
      );
    }

    /* ───────────────
     6️⃣ أهداف ديناميكية
  ─────────────── */

    const entryPrice = bestAsk;

    const targets = this.calculateDynamicTargets(
      entryPrice,
      indicators,
      decision.confidence,
      obAnalysis,
      pricePosition,
    );

    if (!targets || targets.riskRewardRatio < 1.3) return null;

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
      pricePosition,
      entryTime: Date.now(),
    };
  }
  calculateDynamicTargets(
    entryPrice,
    indicators,
    confidence,
    obAnalysis,
    pricePosition,
  ) {
    // 1. حساب الـ ATR الأساسي
    const atr = indicators.atr || entryPrice * 0.008;

    // 2. معامل المسافة بناءً على الثقة
    const multiplier = confidence > 85 ? 2.5 : 3.0;
    let stopLoss = entryPrice - atr * multiplier;

    // 3. حماية تكتل السيولة
    if (obAnalysis?.strongWall && obAnalysis.strongWall.price < entryPrice) {
      const wallSafePrice = obAnalysis.strongWall.price * 0.9975;
      stopLoss = Math.min(stopLoss, wallSafePrice);
    }

    // 4. حدود الستوب لوز - الإصلاح هنا
    const minSLPrice = entryPrice * 0.988; // حد أدنى (أعلى سعر)
    const maxSLPrice = entryPrice * 0.977; // حد أقصى (أقل سعر)

    // التصحيح: stopLoss يجب أن يكون بين maxSLPrice (الأقل) و minSLPrice (الأعلى)
    stopLoss = Math.max(stopLoss, maxSLPrice); // لا يقل عن الحد الأدنى
    stopLoss = Math.min(stopLoss, minSLPrice); // لا يزيد عن الحد الأعلى

    // 5. حساب الهدف
    const riskAmount = entryPrice - stopLoss;
    let takeProfit = entryPrice + riskAmount * 1.9;

    const pos = pricePosition || 50;
    if (pos <= 15) {
      takeProfit = entryPrice + riskAmount * 2.5;
    }

    // 6. حدود الهدف
    const minTPPrice = entryPrice * 1.018;
    takeProfit = Math.max(takeProfit, minTPPrice);

    // 7. حساب نسبة المخاطرة/العائد
    const riskRewardRatio = (takeProfit - entryPrice) / (entryPrice - stopLoss);

    // 8. فحص النتائج
    if (stopLoss >= entryPrice) {
      console.error("❌ خطأ: stopLoss >= entryPrice");
      return null;
    }

    if (takeProfit <= entryPrice) {
      console.error("❌ خطأ: takeProfit <= entryPrice");
      return null;
    }

    if (riskRewardRatio < 1.2) {
      console.warn(`⚠️ نسبة R/R منخفضة: ${riskRewardRatio.toFixed(2)}`);
    }

    return {
      stopLoss: Number(stopLoss.toFixed(8)),
      takeProfit: Number(takeProfit.toFixed(8)),
      riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
      atrValue: atr,
      wallProtected: !!(
        obAnalysis?.strongWall && stopLoss <= obAnalysis.strongWall.price
      ),
      stopLossPercent:
        (((entryPrice - stopLoss) / entryPrice) * 100).toFixed(2) + "%",
      takeProfitPercent:
        (((takeProfit - entryPrice) / entryPrice) * 100).toFixed(2) + "%",
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
      // 1. جلب الرصيد الفعلي مع التعامل مع الأخطاء
      const myBalance = await this.getMyActualBalance();

      if (myBalance <= 0) {
        console.log("⚠️ الرصيد غير متاح أو صفر");
        return;
      }

      // 2. فحص رصيد الأمان - تحسين الحد الأدنى
      const minRequiredBalance = 50; // زيادة الحد الأدنى لأمان أكثر
      if (myBalance < minRequiredBalance) {
        console.log(
          `⚠️ الرصيد الحالي ($${myBalance.toFixed(2)}) منخفض جداً للدخول`,
        );
        return;
      }

      // 3. حساب المخاطرة المالية بناءً على المسافة بين الدخول والستوب
      const riskPerTradePercent = 1.5; // 1.5% من الرصيد كحد أقصى للخسارة لكل صفقة

      // حساب نسبة الخسارة المحتملة من سعر الدخول إلى الستوب
      const priceRiskPercent =
        ((opportunity.entryPrice - opportunity.stopLoss) /
          opportunity.entryPrice) *
        100;

      // الحجم الأمثل بناءً على نسبة المخاطرة المسموحة
      const maxRiskAmount = myBalance * (riskPerTradePercent / 100);
      const positionSizeBasedOnRisk = maxRiskAmount / (priceRiskPercent / 100);

      // 4. معادلة حجم الصفقة الذكية مع تعديلات
      const baseRiskMultiplier =
        opportunity.confidence > 92
          ? 0.5 // 50%
          : opportunity.confidence > 85
            ? 0.2 // 2%
            : 0.015; // 1.5%

      // وزن الثقة بشكل أكثر توازناً
      const confidenceWeight = Math.min(1.5, opportunity.confidence / 100);

      // وزن الحيتان (عدد الحيتان يؤثر إيجابياً ولكن ليس بشكل مبالغ)
      const whaleCount = opportunity.whaleAnalysis.whales?.length || 0;
      const whaleWeight = Math.min(1.3, 1 + whaleCount * 0.1);

      // وزن الانحراف (Imbalance) - إذا كان عالي جداً نزيد الحجم
      const imbalance = opportunity.imbalanceAtEntry || 1;
      const imbalanceWeight = Math.min(1.5, 1 + (imbalance - 1) * 0.2);

      // 5. حساب الحجم النهائي
      let tradeSize =
        myBalance *
        baseRiskMultiplier *
        confidenceWeight *
        whaleWeight *
        imbalanceWeight;

      // 6. تطبيق حدود الأمان - أهم خطوة!

      // أ) الحد الأدنى: 15 دولار أو 5% من الرصيد أيهما أقل
      const minSize1 = 100;
      const minSize2 = myBalance * 0.15;
      const minTradeSize = Math.max(minSize1, minSize2);

      // ب) الحد الأقصى: 25% من الرصيد أو الحجم بناءً على المخاطرة أيهما أقل
      const maxSize1 = myBalance * 0.5;
      const maxSize2 = positionSizeBasedOnRisk;
      const maxTradeSize = Math.min(maxSize1, maxSize2);

      // ج) تأكد أن الحجم لا يتجاوز 1000 دولار كحد مطلق (للحماية)
      const absoluteMax = 1000;

      // د) التطبيق الفعلي للحدود
      tradeSize = Math.max(tradeSize, minTradeSize); // لا يقل عن الحد الأدنى
      tradeSize = Math.min(tradeSize, maxTradeSize); // لا يزيد عن الحد الأقصى
      tradeSize = Math.min(tradeSize, absoluteMax); // الحد المطلق

      // هـ) إذا كان الحجم أكبر من الرصيد المتاح، استخدم 80% من الرصيد
      if (tradeSize > myBalance * 0.9) {
        tradeSize = myBalance * 0.8;
        console.log(`⚠️ ضبط الحجم لـ 80% من الرصيد للحماية`);
      }

      // 7. حساب المخاطرة الفعلية للصفقة
      const riskAmount = tradeSize * (priceRiskPercent / 100);
      const riskToBalancePercent = (riskAmount / myBalance) * 100;

      // 8. التحقق النهائي من المخاطر
      if (riskToBalancePercent > 3) {
        console.log(
          `⛔ مخاطرة عالية جداً (${riskToBalancePercent.toFixed(
            2,
          )}%) - إلغاء الصفقة`,
        );
        this.sendTelegram(
          `⛔ *مخاطرة عالية*: ${
            opportunity.symbol
          } - ${riskToBalancePercent.toFixed(2)}%`,
        );
        return;
      }

      // 9. تسجيل بيانات الحسابات للتحقق
      console.log(`📊 حساب حجم الصفقة لـ ${opportunity.symbol}:`);
      console.log(`   - الرصيد: $${myBalance.toFixed(2)}`);
      console.log(
        `   - نسبة المخاطرة السعرية: ${priceRiskPercent.toFixed(2)}%`,
      );
      console.log(
        `   - الثقة: ${
          opportunity.confidence
        }% → وزن: ${confidenceWeight.toFixed(2)}`,
      );
      console.log(
        `   - عدد الحيتان: ${whaleCount} → وزن: ${whaleWeight.toFixed(2)}`,
      );
      console.log(
        `   - الانحراف: ${imbalance.toFixed(
          2,
        )}x → وزن: ${imbalanceWeight.toFixed(2)}`,
      );
      console.log(`   - الحجم المحسوب: $${tradeSize.toFixed(2)}`);
      console.log(
        `   - المخاطرة الفعلية: $${riskAmount.toFixed(
          2,
        )} (${riskToBalancePercent.toFixed(2)}% من الرصيد)`,
      );

      // 10. إنشاء كائن الصفقة
      const trade = {
        id: `TRADE_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        symbol: opportunity.symbol,
        entryPrice: opportunity.entryPrice,
        entryTime: Date.now(),
        size: tradeSize,
        riskAmount: riskAmount,
        riskPercent: priceRiskPercent,
        riskToBalancePercent: riskToBalancePercent,
        wallPrice: opportunity.wallPrice,
        initialWallVolume: opportunity.initialWallVolume,
        imbalanceAtEntry: opportunity.imbalanceAtEntry,
        stopLoss: opportunity.stopLoss,
        takeProfit: opportunity.takeProfit,
        status: "ACTIVE",
        confidence: opportunity.confidence,
        reasons: opportunity.reasons,
        rsi: opportunity.indicators.rsi,
        volumeRatio: opportunity.indicators.volumeRatio,
        atr: opportunity.indicators.atr,
        highestPrice: opportunity.entryPrice,
        currentStopLoss: opportunity.stopLoss,
        stopLossHistory: [
          {
            price: opportunity.stopLoss,
            time: Date.now(),
            reason: "Initial",
            riskPercent: priceRiskPercent,
          },
        ],
        pricePosition: opportunity.pricePosition,
        whaleCount: whaleCount,
        calculationDetails: {
          balance: myBalance,
          confidenceWeight: confidenceWeight,
          whaleWeight: whaleWeight,
          imbalanceWeight: imbalanceWeight,
          positionSizingMethod: "Intelligent Risk-Based",
        },
      };

      // 11. منع الازدواجية
      const isAlreadyOpen = this.activeTrades.find(
        (t) => t.symbol === trade.symbol,
      );
      if (isAlreadyOpen) {
        console.log(`⏸️ ${trade.symbol}: صفقة نشطة بالفعل`);
        return;
      }

      // 12. التحقق من الحد الأقصى للصفقات المتزامنة
      if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) {
        console.log(
          `⏸️ وصلت للحد الأقصى للصفقات (${CONFIG.MAX_CONCURRENT_TRADES})`,
        );
        return;
      }

      // 13. إضافة الصفقة
      this.activeTrades.push(trade);

      // 14. إرسال التقرير المفصل
      const whaleIcons = "🐋".repeat(Math.min(whaleCount, 3));
      const riskRewardRatio = (
        (opportunity.takeProfit - opportunity.entryPrice) /
        (opportunity.entryPrice - opportunity.stopLoss)
      ).toFixed(2);

      this.sendTelegram(
        `🚀 *دخول جديد: ${trade.symbol}* [15M]\n\n` +
          `💵 *الحجم:* $${tradeSize.toFixed(2)}\n` +
          `💰 *السعر:* $${opportunity.entryPrice.toFixed(4)}\n` +
          `🛡️ *الستوب:* $${opportunity.stopLoss.toFixed(
            4,
          )} (${priceRiskPercent.toFixed(2)}%)\n` +
          `🎯 *الهدف:* $${opportunity.takeProfit.toFixed(4)}\n` +
          `⚖️ *R/R:* ${riskRewardRatio}:1\n` +
          `⚠️ *المخاطرة:* $${riskAmount.toFixed(
            2,
          )} (${riskToBalancePercent.toFixed(2)}% من الرصيد)\n` +
          `📊 *الرصيد:* $${myBalance.toFixed(2)}\n` +
          `🔮 *الثقة:* ${opportunity.confidence}% ${whaleIcons}\n` +
          `📈 *RSI:* ${opportunity.indicators.rsi.toFixed(1)}\n` +
          `💧 *الحجم:* ${opportunity.indicators.volumeRatio.toFixed(1)}x\n` +
          `📝 *الأسباب:*\n${opportunity.reasons
            .slice(0, 3)
            .map((r) => `• ${r}`)
            .join("\n")}`,
      );

      // 15. بدء المراقبة
      this.startProfessionalMonitoring(trade);

      console.log(
        `✅ تم تنفيذ صفقة ${trade.symbol} بحجم $${tradeSize.toFixed(2)}`,
      );
    } catch (error) {
      console.error("❌ خطأ تنفيذ:", error);
      this.sendTelegram(`❌ *خطأ في تنفيذ الصفقة:* ${error.message}`);
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
      const currentIndicators = await this.calculateTechnicalIndicators(
        trade.symbol,
      );

      if (!currentIndicators || !currentIndicators.atr) {
        setTimeout(monitor, 2000);
        return;
      }

      const activeATR = trade.atr * 0.7 + currentIndicators.atr * 0.3;

      // 3. التريلينج ستوب المطور المعتمد على ATR
      this.updateTrailingStop(trade, currentPrice, currentProfit, activeATR);

      // 4. قرار الخروج
      const exitDecision = this.shouldExit(
        trade,
        currentPrice,
        netProfit,
        orderBook,
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
    if (currentProfit > 0.9 && trade.currentStopLoss < trade.entryPrice) {
      trade.currentStopLoss = trade.entryPrice * 1.0005; // الدخول + عمولة بسيطة
      trade.stopLossHistory.push({
        price: trade.currentStopLoss,
        time: Date.now(),
        reason: "ATR-Breakeven Protection",
      });
    }

    // أضف هذا الشرط بين الخطوة 1 والخطوة 2
    if (
      currentProfit > 1.3 &&
      trade.currentStopLoss < trade.entryPrice * 1.01
    ) {
      trade.currentStopLoss = trade.entryPrice * 1.008; // احجز ربح 0.8% فوراً
      trade.stopLossHistory.push({
        price: trade.currentStopLoss,
        time: Date.now(),
        reason: "Partial Profit Secure",
      });
    }

    // 2. تفعيل التريلينج المعتمد على ATR
    // سنبدأ في ملاحقة السعر بعد تحقيق ربح بسيط (مثلاً 0.4%)
    if (currentProfit > 1.7) {
      // نستخدم معامل 2.0x ATR للملاحقة.
      // السعر الجديد للستوب = السعر الحالي - (2 * ATR)
      const atrMultiplier = currentProfit > 2 ? 2.8 : 2.2;
      const atrTrailingStopPrice = currentPrice - activeATR * atrMultiplier;

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
    const obDynamics = this.analyzeOrderBookDynamics(trade.symbol, orderBook);

    // 1. 🛡️ منطق "تبخر الجدار" (المصيدة): تعديل للصبر
    if (trade.wallPrice) {
      const currentWall = orderBook.bids.find(
        (b) => Math.abs(b[0] - trade.wallPrice) < trade.entryPrice * 0.0001,
      );
      const currentWallVolume = currentWall
        ? currentWall[0] * currentWall[1]
        : 0;
      const wallVolumeRatio = currentWallVolume / trade.initialWallVolume;

      if (wallVolumeRatio < 0.1 && Date.now() - trade.entryTime < 30000) {
        // التعديل: لو الحوت سحب طلبه بس السعر لسه أخضر والسيولة قوية، مش هنخرج
        const isActuallyLosing = currentPrice < trade.entryPrice * 0.997; // وسعنا مسافة الصبر لـ 0.3%
        const isImbalanceFlipped = obDynamics.imbalance < 0.6; // لازم السيولة تميل للبيع بوضوح

        if (isActuallyLosing && isImbalanceFlipped) {
          return { exit: true, reason: "CONFIRMED_SPOOFING_EXIT" };
        }
      }
    }

    // 2. 🐋 ملاحقة "جدران الدعم الحية" (الركوب مع الحيتان الجدد)
    if (
      obDynamics.strongWall &&
      obDynamics.strongWall.price > trade.currentStopLoss &&
      obDynamics.strongWall.price < currentPrice * 0.998
    ) {
      trade.currentStopLoss = obDynamics.strongWall.price * 0.9995;
      console.log(`🛡️ ${trade.symbol}: رفعنا الستوب خلف حوت جديد دخل الساحة.`);
    }

    // 3. 🛑 الخروج بالستوب لوز (القفل النهائي)
    if (currentPrice <= trade.currentStopLoss) {
      return {
        exit: true,
        reason:
          trade.currentStopLoss > trade.entryPrice
            ? "TRAILED_PROFIT_TAKEN"
            : "STOP_LOSS_HIT",
      };
    }

    // 4. 🚀 استراتيجية "الهدف المفتوح" (Let Profits Run)
    if (currentPrice >= trade.takeProfit) {
      // لو الانفجار لسه شغال (Imbalance عالي جداً)، ارفع الهدف واحبس الربح
      if (obDynamics.imbalance > 3.5) {
        trade.currentStopLoss = currentPrice * 0.994; // احجز ربحك الحالي
        trade.takeProfit = currentPrice * 1.012; // ارفع الهدف 1.2% إضافية
        console.log(
          `🚀 ${trade.symbol}: انفجار فوليوم! رحلنا الهدف للصيد الأكبر.`,
        );
        return { exit: false };
      }
      return { exit: true, reason: "TAKE_PROFIT_REACHED" };
    }

    // 5. 📉 فلتر ضعف الزخم (الخروج بكرامة)
    // التعديل: مش هنخرج بضعف الزخم إلا لو محققين ربح صافي محترم يغطي العمولات ويفيض (0.6% صافي)
    if (netProfit > 0.6 && obDynamics.imbalance < 0.2) {
      return { exit: true, reason: "MOMENTUM_LOST_SECURED" };
    }

    // 6. ⏳ إدارة الوقت (الخروج من الصفقات المملة)
    const tradeDurationMinutes = (Date.now() - trade.entryTime) / 60000;
    if (tradeDurationMinutes > CONFIG.MAX_MONITOR_TIME) {
      // لو فات وقت طويل وإحنا لسه حول الدخول، اخرج وادور على فرصة أنشط
      if (Math.abs(netProfit) < 0.2) {
        return { exit: true, reason: "TIME_LIMIT_STAGNANT" };
      }
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
      4,
    )},${netPnlPercent.toFixed(3)}%,${netPnlUsd.toFixed(
      3,
    )},${trade.confidence.toFixed(1)},${trade.rsi.toFixed(
      1,
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
        `🕐 ${new Date().toLocaleTimeString("ar-SA")}`,
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

        const decision = await this.calculateDecisionMatrix(symbol, orderBook);
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
          1,
        )}x)\n`;
        report += `   • RSI: ${ind.rsi.toFixed(
          1,
        )} | حجم: ${ind.volumeRatio.toFixed(1)}x\n`;

        report += `   • ATR: $${ind.atr.toFixed(4)} | موقع السعر: ${
          item.decision.pricePosition
        }\n`;

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
      Math.max(1, Math.floor((imbalance / 2) * totalChars)),
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
      `wss://stream.binance.com:9443/ws/${streamName}@depth20@100ms`,
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
    setInterval(
      async () => {
        await this.dbManager.cleanupOldData(2); // نحتفظ بآخر يومين فقط من الشموع والمؤشرات
      },
      24 * 60 * 60 * 1000,
    );

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

    let isUpdatingMarketData = false;

    setInterval(async () => {
      if (isUpdatingMarketData) return;
      isUpdatingMarketData = true;

      try {
        for (const symbol of CONFIG.SYMBOLS) {
          await this.updateMarketData(symbol);
        }
      } catch (e) {
        console.error("❌ Market Data Update Error:", e.message);
      } finally {
        isUpdatingMarketData = false;
      }
    }, 60000);

    // البحث عن فرص كل 5 ثواني
    let isScanning = false;

    setInterval(async () => {
      if (isScanning) return;
      isScanning = true;

      try {
        for (const symbol of CONFIG.SYMBOLS) {
          const opp = await this.analyzeForEntry(
            symbol,
            this.orderBooks[symbol],
          );
          if (opp) await this.executeTrade(opp);
        }
      } catch (e) {
        console.error("❌ Scan Error:", e.message);
      } finally {
        isScanning = false;
      }
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
            } دقيقة`,
        );
      }
    }, 3 * 3600000);

    let isMonitoring = false;

    setInterval(async () => {
      if (isMonitoring) return;
      isMonitoring = true;

      try {
        await this.sendMonitoringReport();
      } catch (e) {
        console.error("❌ Monitoring Report Error:", e.message);
      } finally {
        isMonitoring = false;
      }
    }, 3 * 3600000);

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
        `⏱️ ${new Date().toLocaleTimeString("ar-SA")}`,
    );
  }
  setTimeout(() => process.exit(0), 1000);
});

const bot = new ProfessionalTradingSystem();
global.botInstance = bot;
bot.start();
