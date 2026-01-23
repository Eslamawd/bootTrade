class analyzeCandle {
  constructor(parameters) {
    this.marketData = parameters.marketData;
    this.config = parameters.config || {
      rsiBuyThreshold: 40,
      rsiSellThreshold: 60,
      minCandles: 5,
      patternConfidence: {
        hammer: 15,
        bullishEngulfing: 20,
        morningStar: 25,
        shootingStar: 15,
        bearishEngulfing: 20,
        eveningStar: 25,
        doji: 10,
        pinBar: 15,
        harami: 18,
      },
    };
  }

  calculateCandleMetrics(candle) {
    if (!candle || candle.length < 5) return null;

    const open = candle[1];
    const high = candle[2];
    const low = candle[3];
    const close = candle[4];

    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const totalRange = high - low;

    return {
      open,
      high,
      low,
      close,
      body,
      upperWick,
      lowerWick,
      totalRange,
      bodyRatio: totalRange > 0 ? body / totalRange : 0,
      upperWickRatio: totalRange > 0 ? upperWick / totalRange : 0,
      lowerWickRatio: totalRange > 0 ? lowerWick / totalRange : 0,
      isBullish: close > open,
      isBearish: close < open,
    };
  }

  analyzeCandleStrength(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return null;

    let strength = 0;
    let type = "NORMAL";

    if (metrics.bodyRatio > 0.7) {
      strength = metrics.isBullish ? 25 : -25;
      type = metrics.isBullish ? "STRONG_BULLISH" : "STRONG_BEARISH";
    } else if (metrics.bodyRatio > 0.3) {
      strength = metrics.isBullish ? 10 : -10;
      type = metrics.isBullish ? "BULLISH" : "BEARISH";
    } else if (metrics.bodyRatio < 0.1) {
      strength = 0;
      type = "DOJI";
    }

    return { strength, type, metrics };
  }

  isHammerCandle(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const isLongLowerWick = metrics.lowerWick > metrics.body * 2;
    const isShortUpperWick = metrics.upperWick < metrics.body * 0.5;
    const isNearLow = metrics.lowerWickRatio > 0.6;

    return isSmallBody && isLongLowerWick && isShortUpperWick && isNearLow;
  }

  isBullishEngulfing(prevCandle, currentCandle) {
    const prev = this.calculateCandleMetrics(prevCandle);
    const curr = this.calculateCandleMetrics(currentCandle);
    if (!prev || !curr) return false;

    const isPrevBearish = prev.isBearish;
    const isCurrentBullish = curr.isBullish;
    const isEngulfing = curr.open < prev.close && curr.close > prev.open;
    const isStronger = curr.body > prev.body;

    return isPrevBearish && isCurrentBullish && isEngulfing && isStronger;
  }

  isMorningStar(firstCandle, secondCandle, thirdCandle) {
    const first = this.calculateCandleMetrics(firstCandle);
    const second = this.calculateCandleMetrics(secondCandle);
    const third = this.calculateCandleMetrics(thirdCandle);
    if (!first || !second || !third) return false;

    const isFirstLongBearish = first.isBearish && first.bodyRatio > 0.6;
    const isSecondSmall = second.bodyRatio < 0.3;
    const isGapDown = second.high < first.close;
    const isThirdBullish = third.isBullish;
    const firstMid = (first.open + first.close) / 2;
    const closesAboveFirstMid = third.close > firstMid;

    return (
      isFirstLongBearish &&
      isSecondSmall &&
      isGapDown &&
      isThirdBullish &&
      closesAboveFirstMid
    );
  }

  isDojiCandle(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isDoji = metrics.bodyRatio < 0.1;
    const isLongDoji = isDoji && metrics.totalRange > 0.02 * metrics.close;

    return {
      isDoji,
      isLongDoji,
      metrics,
    };
  }

  isShootingStar(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const isLongUpperWick = metrics.upperWick > metrics.body * 2;
    const isShortLowerWick = metrics.lowerWick < metrics.body * 0.5;
    const isNearHigh = metrics.upperWickRatio > 0.6;
    const hasUpperShadow = metrics.upperWick > 0;

    return (
      isSmallBody &&
      isLongUpperWick &&
      isShortLowerWick &&
      isNearHigh &&
      hasUpperShadow
    );
  }

  isBearishEngulfing(prevCandle, currentCandle) {
    const prev = this.calculateCandleMetrics(prevCandle);
    const curr = this.calculateCandleMetrics(currentCandle);
    if (!prev || !curr) return false;

    const isPrevBullish = prev.isBullish;
    const isCurrentBearish = curr.isBearish;
    const isEngulfing = curr.open > prev.close && curr.close < prev.open;
    const isStronger = curr.body > prev.body;

    return isPrevBullish && isCurrentBearish && isEngulfing && isStronger;
  }

  isEveningStar(firstCandle, secondCandle, thirdCandle) {
    const first = this.calculateCandleMetrics(firstCandle);
    const second = this.calculateCandleMetrics(secondCandle);
    const third = this.calculateCandleMetrics(thirdCandle);
    if (!first || !second || !third) return false;

    const isFirstLongBullish = first.isBullish && first.bodyRatio > 0.6;
    const isSecondSmall = second.bodyRatio < 0.3;
    const isGapUp = second.low > first.high;
    const isThirdBearish = third.isBearish;
    const firstMid = (first.open + first.close) / 2;
    const closesBelowFirstMid = third.close < firstMid;

    return (
      isFirstLongBullish &&
      isSecondSmall &&
      isGapUp &&
      isThirdBearish &&
      closesBelowFirstMid
    );
  }

  isPinBar(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const hasLongWick =
      Math.max(metrics.upperWick, metrics.lowerWick) > metrics.body * 3;
    const isOneSided =
      Math.min(metrics.upperWick, metrics.lowerWick) < metrics.body * 0.3;

    if (isSmallBody && hasLongWick && isOneSided) {
      return {
        isPinBar: true,
        isBullishPin: metrics.lowerWick > metrics.upperWick * 2,
        isBearishPin: metrics.upperWick > metrics.lowerWick * 2,
        direction:
          metrics.lowerWick > metrics.upperWick ? "BULLISH" : "BEARISH",
      };
    }

    return { isPinBar: false };
  }

  isHarami(prevCandle, currentCandle) {
    const prev = this.calculateCandleMetrics(prevCandle);
    const curr = this.calculateCandleMetrics(currentCandle);
    if (!prev || !curr) return false;

    const isInsideBody = curr.open > prev.close && curr.close < prev.open;
    const isSmallerBody = curr.body < prev.body * 0.5;

    if (isInsideBody && isSmallerBody) {
      return {
        isHarami: true,
        isBullishHarami: prev.isBearish && curr.isBullish,
        isBearishHarami: prev.isBullish && curr.isBearish,
        direction: prev.isBearish ? "BULLISH" : "BEARISH",
      };
    }

    return { isHarami: false };
  }

  isInvertedHammer(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const isLongUpperWick = metrics.upperWick > metrics.body * 2;
    const isShortLowerWick = metrics.lowerWick < metrics.body * 0.5;
    const hasLowerClose = metrics.close < metrics.open * 0.995;

    return isSmallBody && isLongUpperWick && isShortLowerWick && hasLowerClose;
  }

  async analyzeCandlestickPatterns(symbol, indicators = {}) {
    const candles = this.marketData[symbol]?.candles;
    if (!candles || candles.length < this.config.minCandles) {
      return {
        buyPatterns: [],
        sellPatterns: [],
        buyScore: 0,
        sellScore: 0,
        candleStrength: 0,
        recommendation: "NEUTRAL",
      };
    }

    const completedCandles = candles.slice(-4, -1);
    if (completedCandles.length < 3) {
      return {
        buyPatterns: [],
        sellPatterns: [],
        buyScore: 0,
        sellScore: 0,
        candleStrength: 0,
        recommendation: "NEUTRAL",
      };
    }

    const first = completedCandles[0];
    const second = completedCandles[1];
    const third = completedCandles[2];

    const buyPatterns = [];
    const sellPatterns = [];
    let buyScore = 0;
    let sellScore = 0;
    let candleStrength = 0;

    if (this.isHammerCandle(third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi < this.config.rsiBuyThreshold;
      if (rsiCondition) {
        buyPatterns.push(
          `المطرقة (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
        );
        buyScore += this.config.patternConfidence.hammer;
      }
    }

    if (this.isBullishEngulfing(second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi < this.config.rsiBuyThreshold + 5;
      if (rsiCondition) {
        buyPatterns.push("الابتلاع الصاعد");
        buyScore += this.config.patternConfidence.bullishEngulfing;
      }
    }

    if (this.isMorningStar(first, second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi < this.config.rsiBuyThreshold;
      if (rsiCondition) {
        buyPatterns.push("نجمة الصباح");
        buyScore += this.config.patternConfidence.morningStar;
      }
    }

    const dojiAnalysis = this.isDojiCandle(third);
    if (dojiAnalysis.isDoji && (!indicators.rsi || indicators.rsi < 30)) {
      buyPatterns.push(
        `دوجي في القاع (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
      );
      buyScore += this.config.patternConfidence.doji;
    }

    const pinBarAnalysis = this.isPinBar(third);
    if (pinBarAnalysis.isPinBar && pinBarAnalysis.direction === "BULLISH") {
      buyPatterns.push("دبوس صاعد");
      buyScore += this.config.patternConfidence.pinBar;
    }

    const haramiAnalysis = this.isHarami(second, third);
    if (haramiAnalysis.isHarami && haramiAnalysis.direction === "BULLISH") {
      buyPatterns.push("هارامي صاعد");
      buyScore += this.config.patternConfidence.harami;
    }

    if (this.isShootingStar(third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi > this.config.rsiSellThreshold;
      if (rsiCondition) {
        sellPatterns.push(
          `الشهاب (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
        );
        sellScore += this.config.patternConfidence.shootingStar;
      }
    }

    if (this.isBearishEngulfing(second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi > this.config.rsiSellThreshold - 5;
      if (rsiCondition) {
        sellPatterns.push("الابتلاع البيعي");
        sellScore += this.config.patternConfidence.bearishEngulfing;
      }
    }

    if (this.isEveningStar(first, second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi > this.config.rsiSellThreshold;
      if (rsiCondition) {
        sellPatterns.push("نجمة المساء");
        sellScore += this.config.patternConfidence.eveningStar;
      }
    }

    if (dojiAnalysis.isDoji && (!indicators.rsi || indicators.rsi > 70)) {
      sellPatterns.push(
        `دوجي في القمة (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
      );
      sellScore += this.config.patternConfidence.doji;
    }

    if (pinBarAnalysis.isPinBar && pinBarAnalysis.direction === "BEARISH") {
      sellPatterns.push("دبوس هابط");
      sellScore += this.config.patternConfidence.pinBar;
    }

    if (haramiAnalysis.isHarami && haramiAnalysis.direction === "BEARISH") {
      sellPatterns.push("هارامي هابط");
      sellScore += this.config.patternConfidence.harami;
    }

    if (
      this.isInvertedHammer(third) &&
      (!indicators.rsi || indicators.rsi > 65)
    ) {
      sellPatterns.push("مطرقة مقلوبة في القمة");
      sellScore += 12;
    }

    let recommendation = "NEUTRAL";
    let confidence = 0;

    if (buyScore > sellScore && buyScore > 20) {
      recommendation = "BUY";
      confidence = Math.min(100, buyScore);
    } else if (sellScore > buyScore && sellScore > 20) {
      recommendation = "SELL";
      confidence = Math.min(100, sellScore);
    } else if (Math.abs(buyScore - sellScore) < 10) {
      recommendation = "NEUTRAL";
      confidence = Math.max(buyScore, sellScore);
    }

    return {
      buyPatterns,
      sellPatterns,
      buyScore,
      sellScore,
      candleStrength,
      recommendation,
      confidence,
      currentCandle: this.calculateCandleMetrics(candles[candles.length - 1]),
      summary: this.generateSummary(
        buyPatterns,
        sellPatterns,
        recommendation,
        confidence,
      ),
    };
  }

  generateSummary(buyPatterns, sellPatterns, recommendation, confidence) {
    let summary = "";

    if (recommendation === "BUY") {
      summary = `إشارة شراء بقوة ${confidence}%\n`;
      summary += `أنماط الشراء: ${buyPatterns.join("، ")}`;
    } else if (recommendation === "SELL") {
      summary = `إشارة بيع بقوة ${confidence}%\n`;
      summary += `أنماط البيع: ${sellPatterns.join("، ")}`;
    } else {
      summary = `حيادي - لا توجد إشارات قوية`;
      if (buyPatterns.length > 0) {
        summary += `\nأنماط شراء ضعيفة: ${buyPatterns.join("، ")}`;
      }
      if (sellPatterns.length > 0) {
        summary += `\nأنماط بيع ضعيفة: ${sellPatterns.join("، ")}`;
      }
    }

    return summary;
  }
}

module.exports = analyzeCandle;
