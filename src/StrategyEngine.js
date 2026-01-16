class StrategyEngine {
  constructor(config, scanner) {
    this.config = config;
    this.scanner = scanner; // ربط السكنر لتحليل السيولة
    this.activeTrades = [];
  }

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
          1
        )}%)`
      );
    } else if (pricePosition <= 60) {
      totalScore += 5;
      reasons.push(
        `💎 السعر في أدنى 60% من نطاق الـ 24 ساعة (${pricePosition.toFixed(
          1
        )}%)`
      );
    } else if (pricePosition >= 70) {
      totalScore -= 20; // مرحلة القمة
      warnings.push(
        `⚠️ السعر متضخم وقريب من أعلى سعر يومي (${pricePosition.toFixed(1)}%)`
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
          1
        )} (تجميع)`
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
          `🔥 انفجار فوليوم ذكي (${indicators.volumeRatio.toFixed(1)}x)`
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

    // حساب الـ Confidence النهائي مع

    const confidence = Math.max(0, Math.min(100, Math.round(totalScore)));

    const priceReversed = this.isPriceReversing(symbol);

    // إذا كانت الثقة عالية جداً ولكن السعر لا يزال ينزف (شمعة حمراء)
    if (confidence > 80 && !priceReversed) {
      confidence = 40; // خفض الثقة لأننا لا نشتري سكيناً ساقطة
      reasons.push("⏳ بانتظار تأكيد ارتداد السعر (Confirmation)");
    }

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

  // دالة للتأكد من أن السعر بدأ يرتد فعلياً وليس مجرد سقوط حر
  isPriceReversing(symbol) {
    const candles = this.marketData[symbol]?.candles;
    if (!candles || candles.length < 5) return false;

    const lastCandle = candles[candles.length - 1]; // الشمعة الحالية
    const prevCandle = candles[candles.length - 2]; // الشمعة السابقة المكتملة

    // شرط التأكيد: الشمعة الحالية تجاوزت منتصف الشمعة الهابطة السابقة (Bullish Piercing)
    // أو أن الإغلاق الحالي أعلى من إغلاق الشمعة السابقة
    const isUpward = lastCandle[4] > prevCandle[4];
    const highLowDiff = prevCandle[2] - prevCandle[3];
    const recoveredSome = lastCandle[4] > prevCandle[3] + highLowDiff * 0.3;

    return isUpward && recoveredSome;
  }

  checkPriceStability(symbol, supportPrice) {
    const candles = this.marketData[symbol]?.candles;
    if (!candles || candles.length < 3) return false;

    // آخر شمعتين مكتملتين
    const last2 = candles.slice(-3, -1);

    return last2.every(
      (c) => c[3] >= supportPrice * 0.998 // الذيل ماكسرش الدعم
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
}
module.exports = StrategyEngine;
