class StrategyEngine {
  constructor(config, scanner) {
    this.config = config;
    this.scanner = scanner; // ربط السكنر لتحليل السيولة
    this.activeTrades = [];
  }

  // الدالة الرئيسية لتقييم القرار بناءً على فريمات متعددة
  calculateDecisionMatrix(symbol, orderBook, allMarketData) {
    const tf5m = allMarketData?.["5m"]?.indicators;
    const tf15m = allMarketData?.["15m"]?.indicators;
    const tf1h = allMarketData?.["1h"]?.indicators;

    if (!tf5m || !tf15m || !tf1h)
      return { confidence: 0, reasons: ["❌ بيانات الفريمات غير مكتملة"] };

    let totalScore = 0;
    const reasons = [];
    const warnings = [];

    /* ───────────────
       1️⃣ فلتر الاتجاه الكبير (15m Trend)
       وظيفته: حمايتك من الشراء في سوق هابط
    ─────────────── */
    const is15mBullish = tf15m.close > tf15m.sma50 && tf1h.close > tf1h.sma50;
    if (is15mBullish) {
      totalScore += 20;
      reasons.push("🌊 تأكيد: اتجاه الـ 15 دقيقة صاعد");
    } else {
      totalScore -= 25; // عقوبة قوية لتقليل الدخول ضد الاتجاه
      warnings.push("⚠️ تحذير: فريم 15د هابط (عكس التيار)");
    }

    /* ───────────────
       2️⃣ تحليل السيولة والحيتان (Order Book)
    ─────────────── */
    const ob = this.scanner.analyzeOrderBookDynamics(symbol, orderBook);
    const whaleData = this.scanner.analyzeWhales(
      symbol,
      orderBook,
      tf5m.avgVolume
    );

    totalScore += ob.score + whaleData.score;
    reasons.push(...ob.reasons, ...whaleData.reasons);

    /* ───────────────
       3️⃣ مؤشرات فريم الدخول (5m Indicators)
    ─────────────── */
    // RSI الديناميكي
    const rsiSMA = tf5m.rsiSMA20 || 50;
    const rsiDiff = tf5m.rsi - rsiSMA;
    if (rsiDiff < -5) {
      totalScore += 25;
      reasons.push(`📉 RSI (5m) تجميعي تحت المتوسط`);
    }

    // انفجار الفوليوم
    if (tf5m.volumeRatio > 2.0 && tf5m.close > tf5m.prevClose) {
      totalScore += 25;
      reasons.push(
        `🔥 سيولة شرائية ضخمة الآن (${tf5m.volumeRatio.toFixed(1)}x)`
      );
    }

    /* ───────────────
       4️⃣ فلتر التقلب (Volatility)
    ─────────────── */
    const volatilityPct = (tf5m.atr / tf5m.close) * 100;
    if (volatilityPct > 3) {
      totalScore -= 15;
      warnings.push(`⚡ تقلب مرتفع جداً (${volatilityPct.toFixed(2)}%)`);
    }

    const confidence = Math.max(0, Math.min(100, totalScore));

    return {
      confidence,
      reasons,
      warnings,
      indicators: tf5m,
      whaleAnalysis: whaleData,
      obAnalysis: ob,
      volatility: volatilityPct,
    };
  }

  // دالة فحص فرصة الدخول (Gatekeeper)
  analyzeForEntry(symbol, orderBook, allMarketData, wsHealth) {
    // 1. فحص الحالة الفنية للاتصال والرصيد
    if (!this._isSystemReady(symbol, wsHealth)) return null;

    // 2. حساب مصفوفة القرار (5m + 15m)
    const decision = this.calculateDecisionMatrix(
      symbol,
      orderBook,
      allMarketData
    );

    if (decision.confidence < this.config.MIN_CONFIDENCE) return null;

    // 3. فلاتر الأمان النهائية
    if (decision.indicators.rsi >= this.config.MAX_RSI_ENTRY) return null;

    const bestAsk = orderBook.asks[0][0];
    const targets = this.calculateDynamicTargets(
      bestAsk,
      decision.indicators,
      decision.confidence
    );

    if (targets.riskRewardRatio < 0.8) return null;

    return {
      symbol,
      entryPrice: bestAsk,
      confidence: decision.confidence,
      reasons: decision.reasons,
      ...targets,
    };
  }

  _isSystemReady(symbol, wsHealth) {
    const isWSHealthy =
      wsHealth?.[symbol]?.stable &&
      Date.now() - wsHealth[symbol].lastUpdate < 2000;
    const isAlreadyInTrade = this.activeTrades.some((t) => t.symbol === symbol);
    return (
      isWSHealthy &&
      !isAlreadyInTrade &&
      this.activeTrades.length < this.config.MAX_CONCURRENT_TRADES
    );
  }

  calculateDynamicTargets(entryPrice, indicators, confidence) {
    const atr = indicators.atr || entryPrice * 0.008;
    const multiplier = confidence > 80 ? 2.2 : 2.8;
    const stopLoss = entryPrice - atr * multiplier;
    const takeProfit = entryPrice + atr * multiplier * 2.2;

    return {
      stopLoss,
      takeProfit,
      riskRewardRatio: (takeProfit - entryPrice) / (entryPrice - stopLoss),
    };
  }
}
module.exports = StrategyEngine;
